import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { io, type Socket } from 'socket.io-client';
import { AdbInstallModal } from './adb-install-modal';
import { fetchAdbDevices, isAdbInstallSupportedPackageUrl, isAdbServiceUnavailableError, probeAdbService } from './adb-client';
import {
  commitPendingUploads,
  convertMessageToTask,
  createRoom,
  deletePendingUpload,
  deleteServerFiles,
  dissolveManagedRooms,
  dissolveRoom,
  editMessage,
  editTaskMessage,
  fetchHotfixContent,
  fetchPackageDistributionPreview,
  getFeishuBotSettings,
  getActiveRooms,
  getHotfixSettings,
  getManagedRooms,
  getMe,
  getMessages,
  getMyRooms,
  getPackageTesterSettings,
  getRoom,
  getRoomPresence,
  getServerFiles,
  getTaskNotifyConfig,
  getPortalJwtToken,
  openServerFileFolder,
  joinRoom,
  leaveRoom,
  markRoomRead,
  recallMessage,
  refreshHotfixTask,
  restoreManagedRoom,
  refreshHotfixAuth,
  sendPackageDistributionTask,
  sendTaskNotification,
  updateHotfixSettings,
  updateMessageTaskItem,
  updateFeishuBotSettings,
  updatePackageTesterSettings,
  uploadPendingAttachment,
} from './api';
import type { AdbDevice } from './adb-client';
import type {
  ActiveRoomListItem,
  ChatMessage,
  FeishuBotMember,
  FeishuBotPublicConfig,
  FeishuBotSettings,
  HomeRoomPresencePayload,
  HotfixSettings,
  HotfixVersionBlock,
  ManagedRoomItem,
  MessageReplyContent,
  MeResponse,
  MemberEventPayload,
  MemberPresencePayload,
  MemberSummary,
  PackageDistributionPreviewBlock,
  PackageTaskEntry,
  PackageTesterSettings,
  RichMessageAttachment,
  RoomDissolvedPayload,
  RoomPresenceSnapshotPayload,
  RoomReadState,
  RoomErrorPayload,
  RoomListItem,
  RoomSummary,
  StoredFileItem,
  TaskMessageContent,
  TaskMessageItem,
  TaskMessageItemResource,
} from './types';
import { getCurrentPortalJwtUser, type PortalUser as JwtPortalUser } from './portal-auth';
import { areTaskContentItemsCompleted, countHotfixBlockItems } from './task-tree';

function formatDateTime(isoString: string | null): string {
  if (!isoString) {
    return '暂无消息';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoString));
}

function formatFileSize(size: number | null): string {
  if (!size || Number.isNaN(size)) {
    return '未知大小';
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatRoomOnlineMemberSummary(room: { memberCount: number; chattingMemberCount?: number; onlineMemberCount?: number }): string {
  return `${room.onlineMemberCount ?? room.chattingMemberCount ?? 0}/${room.memberCount}`;
}

function updateRoomOnlineMemberCount<T extends { roomId: string; chattingMemberCount?: number; onlineMemberCount?: number }>(
  items: T[],
  payload: HomeRoomPresencePayload,
): T[] {
  return items.map((item) => (
    item.roomId === payload.roomId
      ? {
          ...item,
          chattingMemberCount: payload.onlineMemberCount,
          onlineMemberCount: payload.onlineMemberCount,
        }
      : item
  ));
}

async function copyTextToClipboard(text: string, promptMessage: string): Promise<void> {
  const normalizedText = text.trim();
  if (!normalizedText) {
    throw new Error('没有可复制的文本');
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalizedText);
      return;
    } catch {
      // fall through to legacy copy path
    }
  }

  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = normalizedText;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);

    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, normalizedText.length);
      if (document.execCommand('copy')) {
        return;
      }
    } finally {
      document.body.removeChild(textarea);
    }
  }

  if (typeof window !== 'undefined') {
    window.prompt(promptMessage, normalizedText);
    return;
  }

  throw new Error('复制失败，请手动复制');
}

const MAX_IMAGE_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_FILE_ATTACHMENT_SIZE = 1024 * 1024 * 1024;

function mergeMember(current: MemberSummary[], incoming: MemberSummary): MemberSummary[] {
  const next = [...current];
  const existingIndex = next.findIndex((member) => member.ip === incoming.ip);
  if (existingIndex >= 0) {
    next[existingIndex] = incoming;
  } else {
    next.push(incoming);
  }

  next.sort((left, right) => {
    if (left.role === right.role) {
      return left.joinedAt.localeCompare(right.joinedAt);
    }
    return left.role === 'owner' ? -1 : 1;
  });

  return next;
}

function extractClipboardFiles(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
  const files: File[] = [];
  for (const item of Array.from(event.clipboardData.items)) {
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}

function isWithinRecallWindow(createdAt: string, nowMs: number): boolean {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  return nowMs - createdAtMs <= 2 * 60 * 1000;
}

function upsertMessage(current: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const existingIndex = current.findIndex((item) => item.id === incoming.id);
  if (existingIndex < 0) {
    return [...current, incoming];
  }

  const next = [...current];
  next[existingIndex] = incoming;
  return next;
}

function mergeMessagesById(current: ChatMessage[], incomingItems: ChatMessage[]): ChatMessage[] {
  const next = [...current];
  for (const item of incomingItems) {
    const existingIndex = next.findIndex((message) => message.id === item.id);
    if (existingIndex >= 0) {
      next[existingIndex] = item;
    } else {
      next.push(item);
    }
  }

  next.sort((left, right) => left.id - right.id);
  return next;
}

function getDisplayRoomName(roomName: string | null | undefined, roomId: string): string {
  const normalized = (roomName ?? '').trim();
  return normalized || `房间 ${roomId}`;
}

type DisplayPortalUser = MeResponse['portalUser'] | JwtPortalUser | null;

function getPortalUserFallbackName(user: DisplayPortalUser): string {
  return user?.name?.trim() || user?.user_id?.trim() || user?.open_id?.trim() || user?.union_id?.trim() || '已登录用户';
}

const JOB_FUNCTION_LABELS: Record<string, string> = {
  qa: '测试',
  program: '程序',
  art: '美术',
  ta: 'TA',
  producer: '制作人',
  planner: '策划',
  pm: 'PM',
  ops_am: '运营-AM',
  ops_cs: '运营-客服',
  ops_marketing: '运营-美宣',
  platform_backend: '中台-后端',
  platform_sdk: '中台-SDK',
  platform_frontend: '中台-前端',
  platform_pm: '中台-PM',
  soulknight: '元气骑士项目',
};

function formatJobFunctions(jobFunctions: string[] | undefined): string {
  if (!Array.isArray(jobFunctions) || jobFunctions.length === 0) {
    return '';
  }

  return jobFunctions.map((code) => JOB_FUNCTION_LABELS[code] || code).join(' / ');
}

function getJobDisplayText(user: DisplayPortalUser): string {
  const jobTitle = user?.job_title?.trim();
  if (jobTitle) {
    return jobTitle;
  }

  const jobFunctionsText = formatJobFunctions(user?.job_functions);
  if (jobFunctionsText) {
    return jobFunctionsText;
  }

  if (user?.job_title_status === 'empty') {
    return '职位信息暂未配置';
  }

  if (user?.job_title_status === 'not_found') {
    return '未匹配到用户目录';
  }

  if (user?.job_title_status === 'error') {
    return '职位信息获取失败';
  }

  return '职位信息暂未获取';
}

function getUserAvatarLabel(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized === '--') {
    return '用户';
  }

  const chars = Array.from(normalized);
  const latinWords = normalized.match(/[A-Za-z0-9]+/g);
  if (latinWords && latinWords.length > 0 && latinWords.join('').length === normalized.replace(/\s+/g, '').length) {
    return latinWords.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || '用户';
  }

  return chars.slice(-2).join('');
}

function UserIdentityCard({
  me,
  displayName,
}: {
  me: MeResponse | null;
  displayName?: string | null;
}) {
  const portalUser = getCurrentPortalJwtUser() ?? me?.portalUser ?? null;
  const normalizedName = displayName?.trim() || me?.nickname?.trim() || getPortalUserFallbackName(portalUser);
  const jobDisplayText = getJobDisplayText(portalUser);
  const ipText = me?.ip?.trim();
  const avatarUrl = portalUser?.avatar_url?.trim();
  const avatarLabel = getUserAvatarLabel(normalizedName);

  return (
    <div className="user-profile-card">
      <div className="user-avatar" aria-hidden="true">
        <span>{avatarLabel}</span>
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
      </div>
      <div className="user-profile-copy">
        <strong>{normalizedName}</strong>
        <span>{jobDisplayText}</span>
        {ipText ? <span className="user-profile-ip">{ipText}</span> : null}
      </div>
    </div>
  );
}

function createAuthedSocket(): Socket {
  return io({
    auth: (callback) => {
      const portalJwt = getPortalJwtToken();
      callback(portalJwt ? { portalJwt } : {});
    },
  });
}

const CLEANUP_PASSWORD_STORAGE_KEY = 'webchat_cleanup_password';
const ROOM_VISIT_STORAGE_KEY = 'webchat_recent_room_visits';
const MENTION_SEEN_STORAGE_KEY = 'webchat_seen_mentions_v1';
const HIDDEN_MESSAGES_STORAGE_KEY = 'webchat_hidden_messages_v1';
const PACKAGE_DISTRIBUTION_LINKS_STORAGE_KEY = 'webchat_package_distribution_links_v1';
const ROOMS_PAGE_SIZE = 10;

type MentionOption = {
  key: string;
  label: string;
  type: 'all' | 'member';
  ip: string | null;
  searchText: string;
};

type ActiveMentionQuery = {
  start: number;
  end: number;
  query: string;
};

type ParsedFeishuMembersResult = {
  members: FeishuBotMember[];
  error: string | null;
};

type TaskNotifyModalState = {
  messageId: number;
  selectedMemberIds: string[];
};

type HotfixVersionPickerModalState = {
  documentId: string;
  versionBlocks: HotfixVersionBlock[];
  selectedVersionLines: string[];
  refreshedToken: boolean;
};

type PackageDistributionLinkInput = {
  id: string;
  value: string;
};

type PackageDistributionEditableEntry = PackageTaskEntry & {
  assignees: string[];
};

type PackageDistributionEditableBlock = Omit<PackageDistributionPreviewBlock, 'entries'> & {
  entries: PackageDistributionEditableEntry[];
};

type PackageDistributionModalState = {
  links: PackageDistributionLinkInput[];
  blocks: PackageDistributionEditableBlock[] | null;
  testers: string[];
  fetchedAt: string | null;
};

type AdbInstallModalState = {
  packageName: string;
  packageUrl: string;
  devices: AdbDevice[];
};

function buildFeishuMembersEditorValue(members: FeishuBotMember[]): string {
  if (members.length === 0) {
    return '';
  }

  return JSON.stringify(
    members.map((member) => ({
      member_id: member.memberId,
      member_id_type: member.memberIdType,
      name: member.name,
      tenant_key: member.tenantKey,
    })),
    null,
    2,
  );
}

function parseFeishuMembersEditorValue(value: string): ParsedFeishuMembersResult {
  const normalized = value.trim();
  if (!normalized) {
    return { members: [], error: null };
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    const rawItems = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && 'data' in parsed
        && typeof parsed.data === 'object' && parsed.data !== null
        && 'items' in parsed.data && Array.isArray(parsed.data.items)
          ? parsed.data.items
          : null;

    if (!rawItems) {
      return {
        members: [],
        error: '人员配置 JSON 结构不正确，请粘贴成员数组，或包含 data.items 的返回结果',
      };
    }

    const members = rawItems.flatMap((rawItem) => {
      if (typeof rawItem !== 'object' || rawItem === null) {
        return [];
      }

      const item = rawItem as Record<string, unknown>;
      const memberId =
        typeof item.memberId === 'string' ? item.memberId
          : typeof item.member_id === 'string' ? item.member_id
            : '';
      const memberIdType =
        typeof item.memberIdType === 'string' ? item.memberIdType
          : typeof item.member_id_type === 'string' ? item.member_id_type
            : 'user_id';
      const name = typeof item.name === 'string' ? item.name : '';
      const tenantKey =
        typeof item.tenantKey === 'string' ? item.tenantKey
          : typeof item.tenant_key === 'string' ? item.tenant_key
            : '';

      return [{
        memberId: memberId.trim(),
        memberIdType: memberIdType.trim() || 'user_id',
        name: name.trim(),
        tenantKey: tenantKey.trim(),
      }];
    }).filter((member) => member.memberId && member.name);

    return { members, error: null };
  } catch {
    return {
      members: [],
      error: '人员配置不是有效的 JSON，请检查后再保存',
    };
  }
}

function buildPackageTesterEditorValue(testers: string[]): string {
  return testers.join('\n');
}

function parsePackageTesterEditorValue(value: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const line of value.split(/\r?\n/)) {
    const normalized = line.trim();
    const dedupeKey = normalized.toLowerCase();
    if (!normalized || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    result.push(normalized);
  }

  return result;
}

function normalizePackageDistributionAssignees(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = value.trim();
    const dedupeKey = normalized.toLowerCase();
    if (!normalized || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    result.push(normalized);
  }

  return result;
}

function getMentionIpSuffix(ip: string): string {
  const normalized = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    return normalized.split('.').slice(-2).join('.');
  }

  return normalized.slice(-4).toUpperCase();
}

function buildMentionOptions(room: RoomSummary | null, me: MeResponse | null): MentionOption[] {
  if (!room) {
    return [];
  }

  const visibleMembers = room.members.filter((member) => member.ip !== me?.ip);
  const nicknameCountMap = visibleMembers.reduce<Map<string, number>>((result, member) => {
    const normalizedNickname = member.nickname.trim();
    result.set(normalizedNickname, (result.get(normalizedNickname) ?? 0) + 1);
    return result;
  }, new Map());

  return [
    {
      key: 'all',
      label: '@所有人',
      type: 'all',
      ip: null,
      searchText: '@所有人 所有人 all everyone 全体 全员',
    },
    ...visibleMembers.map((member) => {
      const normalizedNickname = member.nickname.trim();
      const needsSuffix = (nicknameCountMap.get(normalizedNickname) ?? 0) > 1;
      const label = needsSuffix ? `@${normalizedNickname}（${getMentionIpSuffix(member.ip)}）` : `@${normalizedNickname}`;
      return {
        key: member.ip,
        label,
        type: 'member' as const,
        ip: member.ip,
        searchText: `${label} ${normalizedNickname} ${member.ip}`.toLowerCase(),
      } satisfies MentionOption;
    }),
  ];
}

function findActiveMentionQuery(text: string, caretPosition: number): ActiveMentionQuery | null {
  const safeCaretPosition = Math.max(0, Math.min(caretPosition, text.length));
  const textBeforeCaret = text.slice(0, safeCaretPosition);
  const mentionStart = textBeforeCaret.lastIndexOf('@');
  if (mentionStart < 0) {
    return null;
  }

  const prefix = textBeforeCaret.slice(0, mentionStart);
  if (prefix && !/\s/.test(prefix[prefix.length - 1] ?? '')) {
    return null;
  }

  const rawQuery = textBeforeCaret.slice(mentionStart + 1);
  if (/\s/.test(rawQuery)) {
    return null;
  }

  return {
    start: mentionStart,
    end: safeCaretPosition,
    query: rawQuery,
  };
}

function renderTextWithLinks(text: string, keyPrefix: string): ReactNode[] {
  const urlRegex = /https?:\/\/[^\s]+|www\.[^\s]+/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    let rawUrl = match[0];
    let trailing = '';
    while (rawUrl.length > 0 && /[),.!?;:]/.test(rawUrl[rawUrl.length - 1])) {
      trailing = rawUrl[rawUrl.length - 1] + trailing;
      rawUrl = rawUrl.slice(0, -1);
    }

    const href = rawUrl.startsWith('www.') ? `http://${rawUrl}` : rawUrl;
    nodes.push(
      <a
        key={`${keyPrefix}-link-${match.index}`}
        className="message-link"
        href={href}
        target="_blank"
        rel="noreferrer"
      >
        {rawUrl}
      </a>,
    );

    if (trailing) {
      nodes.push(trailing);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.map((node, index) => (
    typeof node === 'string'
      ? <span key={`${keyPrefix}-text-${index}`}>{node}</span>
      : node
  ));
}

function renderMessageTextWithMentions(text: string): ReactNode {
  const segments = text.split(/(@所有人|@[^\s@]+)/g);
  const nodes: ReactNode[] = [];

  segments.forEach((segment, index) => {
    if (!segment) {
      return;
    }

    if (segment.startsWith('@')) {
      nodes.push(<span key={`mention-${index}`} className="mention-inline-token">{segment}</span>);
      return;
    }

    nodes.push(...renderTextWithLinks(segment, `text-${index}`));
  });

  return nodes;
}

function isMessageMentioningCurrentUser(message: ChatMessage, me: MeResponse | null): boolean {
  if (!me || message.senderIp === me.ip) {
    return false;
  }

  return message.mentionAll || message.mentionedIps.includes(me.ip);
}

function isMessageEdited(message: ChatMessage): boolean {
  return Boolean(message.editedAt);
}

function getMessageMentionHint(message: ChatMessage, me: MeResponse | null, showCurrentUserMention = true): string | null {
  if (isMessageMentioningCurrentUser(message, me)) {
    if (!showCurrentUserMention) {
      return null;
    }

    return message.mentionAll ? '@所有人，请尽快关注' : '有人@你，请尽快查看';
  }

  if (message.mentionAll) {
    return '@所有人';
  }

  if (message.mentionedIps.length > 0) {
    return `@${message.mentionedIps.length} 人`;
  }

  return null;
}

function buildMentionSeenScopeKey(ip: string, roomId: string): string {
  return `${ip}::${roomId}`;
}

function readMentionSeenMap(): Record<string, string[]> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(MENTION_SEEN_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed).reduce<Record<string, string[]>>((result, [key, value]) => {
      if (!Array.isArray(value)) {
        return result;
      }

      const tokens = Array.from(new Set(value.filter((item): item is string => typeof item === 'string'))).slice(-500);
      if (tokens.length > 0) {
        result[key] = tokens;
      }
      return result;
    }, {});
  } catch {
    return {};
  }
}

function readSeenMentionTokens(ip: string, roomId: string): string[] {
  return readMentionSeenMap()[buildMentionSeenScopeKey(ip, roomId)] ?? [];
}

function storeSeenMentionTokens(ip: string, roomId: string, tokens: string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  const map = readMentionSeenMap();
  const scopeKey = buildMentionSeenScopeKey(ip, roomId);
  const normalizedTokens = Array.from(new Set(tokens)).slice(-500);

  if (normalizedTokens.length > 0) {
    map[scopeKey] = normalizedTokens;
  } else {
    delete map[scopeKey];
  }

  window.localStorage.setItem(MENTION_SEEN_STORAGE_KEY, JSON.stringify(map));
}

function getMessageMentionSeenToken(message: ChatMessage): string {
  return `${message.id}:${message.editedAt ?? message.createdAt}`;
}

function buildHiddenMessagesScopeKey(ip: string, roomId: string): string {
  return `${ip}::${roomId}`;
}

function readHiddenMessageMap(): Record<string, number[]> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(HIDDEN_MESSAGES_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed).reduce<Record<string, number[]>>((result, [key, value]) => {
      if (!Array.isArray(value)) {
        return result;
      }

      const ids = Array.from(
        new Set(
          value
            .filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item > 0),
        ),
      ).slice(-2000);
      if (ids.length > 0) {
        result[key] = ids;
      }
      return result;
    }, {});
  } catch {
    return {};
  }
}

function readHiddenMessageIds(ip: string, roomId: string): number[] {
  return readHiddenMessageMap()[buildHiddenMessagesScopeKey(ip, roomId)] ?? [];
}

function storeHiddenMessageIds(ip: string, roomId: string, messageIds: number[]) {
  if (typeof window === 'undefined') {
    return;
  }

  const map = readHiddenMessageMap();
  const scopeKey = buildHiddenMessagesScopeKey(ip, roomId);
  const normalizedIds = Array.from(
    new Set(messageIds.filter((item) => Number.isInteger(item) && item > 0)),
  ).slice(-2000);

  if (normalizedIds.length > 0) {
    map[scopeKey] = normalizedIds;
  } else {
    delete map[scopeKey];
  }

  window.localStorage.setItem(HIDDEN_MESSAGES_STORAGE_KEY, JSON.stringify(map));
}


function readStoredCleanupPassword(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.sessionStorage.getItem(CLEANUP_PASSWORD_STORAGE_KEY) ?? '';
}

function storeCleanupPassword(password: string) {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.setItem(CLEANUP_PASSWORD_STORAGE_KEY, password);
}

function clearStoredCleanupPassword() {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.removeItem(CLEANUP_PASSWORD_STORAGE_KEY);
}

function createPackageDistributionLinkInput(value = ''): PackageDistributionLinkInput {
  return {
    id: `pkg-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    value,
  };
}

function readStoredPackageDistributionLinks(): string[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(PACKAGE_DISTRIBUTION_LINKS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function storePackageDistributionLinks(links: string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  const normalizedLinks = links
    .map((value) => value.trim())
    .filter(Boolean);

  if (normalizedLinks.length === 0) {
    window.localStorage.removeItem(PACKAGE_DISTRIBUTION_LINKS_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(PACKAGE_DISTRIBUTION_LINKS_STORAGE_KEY, JSON.stringify(normalizedLinks));
}

function clearStoredPackageDistributionLinks() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(PACKAGE_DISTRIBUTION_LINKS_STORAGE_KEY);
}

function readRoomVisitMap(): Record<string, number> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(ROOM_VISIT_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed).reduce<Record<string, number>>((result, [key, value]) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[key] = value;
      }
      return result;
    }, {});
  } catch {
    return {};
  }
}

function markRoomVisited(roomId: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const next = {
    ...readRoomVisitMap(),
    [roomId]: Date.now(),
  };

  window.localStorage.setItem(ROOM_VISIT_STORAGE_KEY, JSON.stringify(next));
}

function toTimestamp(isoString: string | null | undefined): number {
  if (!isoString) {
    return 0;
  }

  const value = Date.parse(isoString);
  return Number.isFinite(value) ? value : 0;
}

function sortRoomsByRecentVisits(items: RoomListItem[]): RoomListItem[] {
  const recentVisits = readRoomVisitMap();

  return [...items].sort((left, right) => {
    const visitDiff = (recentVisits[right.roomId] ?? 0) - (recentVisits[left.roomId] ?? 0);
    if (visitDiff !== 0) {
      return visitDiff;
    }

    const joinDiff = toTimestamp(right.joinedAt) - toTimestamp(left.joinedAt);
    if (joinDiff !== 0) {
      return joinDiff;
    }

    return toTimestamp(right.lastMessageAt ?? right.createdAt) - toTimestamp(left.lastMessageAt ?? left.createdAt);
  });
}

function canRestoreManagedRoom(room: ManagedRoomItem, nowMs = Date.now()): boolean {
  if (room.status !== 'dissolved' || !room.restoreExpiresAt) {
    return false;
  }

  return toTimestamp(room.restoreExpiresAt) >= nowMs;
}

function useAutoDismissMessage(message: string | null, clearMessage: (nextMessage: string | null) => void, delayMs = 5000) {
  useEffect(() => {
    if (!message) {
      return;
    }

    const timer = window.setTimeout(() => clearMessage(null), delayMs);
    return () => window.clearTimeout(timer);
  }, [clearMessage, delayMs, message]);
}

type FloatingToastVariant = 'error' | 'success';

function FloatingToastMessage({ message, variant }: { message: string; variant: FloatingToastVariant }) {
  const icon = variant === 'error' ? '!' : '✓';

  return (
    <div className={`floating-toast floating-toast-${variant}`} role="status">
      <span className={`floating-toast-icon floating-toast-icon-${variant}`} aria-hidden="true">{icon}</span>
      <span>{message}</span>
    </div>
  );
}

function FloatingFeedbackToasts({ error, success }: { error?: string | null; success?: string | null }) {
  if (!error && !success) {
    return null;
  }

  return (
    <div className="floating-toast-container" aria-live="polite" aria-atomic="true">
      {error ? <FloatingToastMessage message={error} variant="error" /> : null}
      {success ? <FloatingToastMessage message={success} variant="success" /> : null}
    </div>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v11" />
      <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
      <path d="M4 19h16" />
    </svg>
  );
}

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 8.5 11.4 18.1a5 5 0 1 1-7.1-7.1l9.2-9.2a3.5 3.5 0 1 1 5 5l-9.2 9.2a2 2 0 1 1-2.8-2.8L15 7" />
    </svg>
  );
}

function HotfixIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13.5 2 6.5 12h4.7l-1.2 10L17.5 12h-4.4L13.5 2Z" />
    </svg>
  );
}

function PackageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8.5 12 4l8 4.5v9L12 22l-8-4.5Z" />
      <path d="M12 4v9" />
      <path d="m4 8.5 8 4.5 8-4.5" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
    </svg>
  );
}

function ComposerExpandIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 4h6v6" />
      <path d="M20 4l-7 7" />
      <path d="M10 20H4v-6" />
      <path d="M4 20l7-7" />
    </svg>
  );
}

function ComposerCollapseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4l6 6" />
      <path d="M10 6v4H6" />
      <path d="M20 20l-6-6" />
      <path d="M14 18v-4h4" />
    </svg>
  );
}

function FileCardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}

function RecallIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h9a7 7 0 1 1 0 14h-2" />
    </svg>
  );
}

function EditResendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function DeleteMessageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M9 3h6" />
      <path d="M7 7l1 13a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-13" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function TaskConvertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="m3 6 1.5 1.5L7 5" />
      <path d="m3 12 1.5 1.5L7 11" />
      <path d="m3 18 1.5 1.5L7 17" />
    </svg>
  );
}

function TaskNotifyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h11" />
      <path d="M11 5l7 7-7 7" />
      <path d="M5 6h4" />
      <path d="M5 18h4" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function ReplyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.25 7.25h11.5c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H11.5L8 19v-2.5H6.25C5.56 16.5 5 15.94 5 15.25V8.5c0-.69.56-1.25 1.25-1.25Z" />
      <circle cx="9.25" cy="11.88" r="0.92" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11.88" r="0.92" fill="currentColor" stroke="none" />
      <circle cx="14.75" cy="11.88" r="0.92" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m8 8 8 8" />
      <path d="m16 8-8 8" />
    </svg>
  );
}

function getRequestErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null;
  }

  const { status } = error as { status?: unknown };
  return typeof status === 'number' ? status : null;
}

const MESSAGE_LIST_BOTTOM_THRESHOLD = 72;
const REPLY_PREVIEW_MAX_LENGTH = 72;
const HOTFIX_VERSION_LINE_REGEX = /^(?:\d+\.\d+\.\d+(?:\.\d+)?(?:\s*\S.*)?|资源热更\s+\S(?:.*\S)?)\s*$/;

function isMessageListNearBottom(container: HTMLDivElement): boolean {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distance <= MESSAGE_LIST_BOTTOM_THRESHOLD;
}

function getTaskConvertActionKey(messageId: number): string {
  return `convert:${messageId}`;
}

function getTaskItemActionKey(messageId: number, taskItemId: string): string {
  return `toggle:${messageId}:${taskItemId}`;
}

function getTaskNotifyActionKey(messageId: number): string {
  return `notify:${messageId}`;
}

function getHotfixRefreshActionKey(messageId: number): string {
  return `hotfix-refresh:${messageId}`;
}

function getTaskCompletedByBadgeText(nickname: string | null): string {
  if (!nickname) {
    return '';
  }

  const normalized = nickname.trim();
  if (!normalized) {
    return '';
  }

  return Array.from(normalized).slice(0, 3).join('');
}

function isTaskNotifyStructured(taskContent: TaskMessageContent | null): boolean {
  if (!taskContent || taskContent.sections.length === 0) {
    return false;
  }

  return taskContent.sections.every((section) =>
    section.title.trim().length > 0
    && section.title !== '任务清单'
    && section.groups.length > 0
    && section.groups.every((group) =>
      group.assignee.trim().length > 0
      && group.assignee !== '未分配'
      && group.items.length > 0,
    ),
  );
}

function isHotfixTaskStructured(taskContent: TaskMessageContent | null): boolean {
  if (!taskContent) {
    return false;
  }

  return (
    isTaskNotifyStructured(taskContent)
    && taskContent.sections.every((section) => HOTFIX_VERSION_LINE_REGEX.test(section.title.trim()))
  );
}

function isPackageDistributionTask(taskContent: TaskMessageContent | null): boolean {
  return taskContent?.kind === 'package-distribution';
}

function isSimpleDefaultTaskGroup(sectionTitle: string, assignee: string): boolean {
  return sectionTitle === '任务清单' && assignee === '未分配';
}

function areAllTaskItemsCompleted(taskContent: TaskMessageContent | null): boolean {
  return areTaskContentItemsCompleted(taskContent);
}

function normalizeTaskNotifyPersonName(value: string): string {
  return value
    .trim()
    .replace(/^@+/, '')
    .replace(/[（(][^（）()]*[）)]/gu, ' ')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

function collectTaskAssigneeNames(taskContent: TaskMessageContent | null): string[] {
  if (!taskContent) {
    return [];
  }

  return Array.from(
    new Set(
      taskContent.sections.flatMap((section) =>
        section.groups.map((group) => group.assignee.trim()).filter(Boolean),
      ),
    ),
  );
}

function collectTaskAssigneeMatchKeys(taskContent: TaskMessageContent | null): string[] {
  if (!taskContent) {
    return [];
  }

  const unassignedKey = normalizeTaskNotifyPersonName('未分配');
  return Array.from(
    new Set(
      taskContent.sections.flatMap((section) =>
        section.groups
          .map((group) => normalizeTaskNotifyPersonName(group.assignee))
          .filter((name) => name.length > 0 && name !== unassignedKey),
      ),
    ),
  );
}

function buildHotfixBlocksText(blocks: HotfixVersionBlock[]): string {
  return blocks.map((block) => block.content).join('\n\n').trim();
}

function buildHotfixBlocksTaskText(blocks: HotfixVersionBlock[]): string {
  return blocks.map((block) => block.taskContent).join('\n\n').trim();
}

function truncateReplyPreviewText(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= REPLY_PREVIEW_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, REPLY_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

function summarizeMessageForReplyPreview(message: ChatMessage): string {
  if (message.type === 'text') {
    return truncateReplyPreviewText((message.textContent ?? '').replace(/\s+/g, ' ').trim() || '文本消息');
  }

  if (message.type === 'rich') {
    const normalizedText = (message.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (normalizedText) {
      return truncateReplyPreviewText(normalizedText);
    }

    const firstAttachment = message.richContent?.attachments[0];
    if (firstAttachment) {
      return truncateReplyPreviewText(firstAttachment.fileName.trim() || '富文本消息');
    }

    return '富文本消息';
  }

  if (message.type === 'image') {
    return truncateReplyPreviewText((message.imageName ?? message.fileName ?? '').trim() || '图片消息');
  }

  return truncateReplyPreviewText((message.fileName ?? '').trim() || '文件附件');
}

function buildReplyContentFromMessage(message: ChatMessage): MessageReplyContent {
  return {
    messageId: message.id,
    senderNickname: message.senderNickname,
    messageType: message.type,
    previewText: summarizeMessageForReplyPreview(message),
  };
}

function getReplyPreviewImageUrl(roomId: string, replyContent: MessageReplyContent): string | null {
  return replyContent.messageType === 'image'
    ? `/api/rooms/${roomId}/messages/${replyContent.messageId}/content`
    : null;
}

type PendingAttachmentStatus = 'uploading' | 'uploaded' | 'failed';

type PendingAttachment = {
  id: string;
  file: File;
  previewUrl: string;
  kind: 'image' | 'file';
  uploadStatus: PendingAttachmentStatus;
  uploadPercent: number;
  uploadId: string | null;
  error: string | null;
};

type AttachmentPreview = {
  kind: 'image' | 'file';
  url: string;
  name: string;
  size: number | null;
  mime: string | null;
  downloadName: string;
  sourceKey: string;
};

function getAttachmentKind(file: File): 'image' | 'file' {
  return file.type.startsWith('image/') ? 'image' : 'file';
}

function getAttachmentValidationError(file: File): string | null {
  if (getAttachmentKind(file) === 'image' && file.size > MAX_IMAGE_ATTACHMENT_SIZE) {
    return `图片“${file.name}”超过 10MB，无法上传`;
  }

  if (getAttachmentKind(file) === 'file' && file.size > MAX_FILE_ATTACHMENT_SIZE) {
    return `文件“${file.name}”超过 1GB，无法上传`;
  }

  return null;
}

function getAttachmentFormatLabel(file: File): string {
  const segments = file.name.split('.');
  if (segments.length > 1) {
    const extension = segments.at(-1)?.trim();
    if (extension) {
      return extension.toUpperCase();
    }
  }

  if (file.type) {
    return file.type.split('/').at(-1)?.toUpperCase() ?? 'FILE';
  }

  return 'FILE';
}

function createPendingAttachments(files: File[]): PendingAttachment[] {
  const timestamp = Date.now();
  return files.map((file, index) => ({
    id: `${timestamp}-${index}-${file.name}-${file.size}-${file.lastModified}`,
    file,
    previewUrl: URL.createObjectURL(file),
    kind: getAttachmentKind(file),
    uploadStatus: 'uploading',
    uploadPercent: 0,
    uploadId: null,
    error: null,
  }));
}

function getPendingAttachmentStatusLabel(attachment: PendingAttachment): string {
  const base = `${attachment.kind === 'image' ? '图片' : '文件'} · ${getAttachmentFormatLabel(attachment.file)} · ${formatFileSize(attachment.file.size)}`;

  if (attachment.uploadStatus === 'uploading') {
    return `${base} · 上传中 ${attachment.uploadPercent}%`;
  }

  if (attachment.uploadStatus === 'uploaded') {
    return `${base} · 已上传，点击发送后发出`;
  }

  return `${base} · 上传失败${attachment.error ? `：${attachment.error}` : ''}`;
}

function toPendingPreview(attachment: PendingAttachment): AttachmentPreview {
  return {
    kind: attachment.kind,
    url: attachment.previewUrl,
    name: attachment.file.name || (attachment.kind === 'image' ? '图片附件' : '文件附件'),
    size: attachment.file.size,
    mime: attachment.file.type || null,
    downloadName: attachment.file.name || (attachment.kind === 'image' ? 'image' : 'file'),
    sourceKey: `pending-${attachment.id}`,
  };
}

function toMessagePreview(message: ChatMessage): AttachmentPreview | null {
  if (message.type === 'image' && message.imageUrl) {
    return {
      kind: 'image',
      url: message.imageUrl,
      name: message.imageName ?? '图片附件',
      size: message.imageSize,
      mime: message.imageMime,
      downloadName: message.fileName ?? message.imageName ?? 'image',
      sourceKey: `message-${message.id}`,
    };
  }

  if (message.type === 'file' && message.fileUrl) {
    return {
      kind: 'file',
      url: message.fileUrl,
      name: message.fileName ?? '文件附件',
      size: message.fileSize,
      mime: message.fileMime,
      downloadName: message.fileName ?? 'file',
      sourceKey: `message-${message.id}`,
    };
  }

  return null;
}

function toRichAttachmentPreview(messageId: number, attachment: RichMessageAttachment): AttachmentPreview {
  return {
    kind: attachment.type,
    url: attachment.type === 'image' ? attachment.imageUrl ?? attachment.fileUrl : attachment.fileUrl,
    name: attachment.fileName,
    size: attachment.fileSize,
    mime: attachment.fileMime,
    downloadName: attachment.fileName,
    sourceKey: `message-${messageId}-rich-${attachment.id}`,
  };
}

function isPreviewForMessage(preview: AttachmentPreview | null, messageId: number): boolean {
  if (!preview) {
    return false;
  }

  return preview.sourceKey === `message-${messageId}` || preview.sourceKey.startsWith(`message-${messageId}-rich-`);
}

function RichAttachmentCard({
  messageId,
  attachment,
  onPreview,
}: {
  messageId: number;
  attachment: RichMessageAttachment;
  onPreview: (preview: AttachmentPreview) => void;
}) {
  const preview = toRichAttachmentPreview(messageId, attachment);

  if (attachment.type === 'image' && attachment.imageUrl) {
    return (
      <button
        className="rich-image-button"
        type="button"
        onClick={() => onPreview(preview)}
        aria-label={`预览 ${attachment.fileName || '图片附件'}`}
        title="预览图片"
      >
        <img className="chat-image rich-message-image" src={attachment.imageUrl} alt={attachment.fileName || '图片消息'} />
      </button>
    );
  }

  return (
    <div className="attachment-card file-card">
      <div className="file-card-main">
        <div className="file-icon"><FileCardIcon className="file-icon-svg" /></div>
        <div className="attachment-meta">
          <strong>{attachment.fileName || '文件附件'}</strong>
          <span>
            {attachment.fileMime || '未知类型'} · {formatFileSize(attachment.fileSize)}
          </span>
        </div>
      </div>
      <a
        className="attachment-action-icon file-download-icon"
        href={attachment.fileUrl}
        download={attachment.fileName || 'file'}
        aria-label={`下载 ${attachment.fileName || '文件附件'}`}
        title="下载文件"
      >
        <DownloadIcon className="attachment-action-icon-svg" />
      </a>
    </div>
  );
}

function PendingComposerAttachment({
  attachment,
  onPreview,
  onRemove,
  disabled,
}: {
  attachment: PendingAttachment;
  onPreview: (preview: AttachmentPreview) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const preview = toPendingPreview(attachment);
  const statusLabel = attachment.uploadStatus === 'uploading'
    ? `上传中 ${attachment.uploadPercent}%`
    : attachment.uploadStatus === 'failed'
      ? (attachment.error ?? '上传失败')
      : null;
  const fileName = attachment.file.name || (attachment.kind === 'image' ? '图片附件' : '文件附件');

  if (attachment.kind === 'image') {
    return (
      <div className={`composer-draft-attachment composer-draft-attachment-image composer-draft-attachment-${attachment.uploadStatus}`}>
        <button
          className="composer-draft-image-button"
          type="button"
          onClick={() => onPreview(preview)}
          aria-label={`预览 ${fileName}`}
          title="预览图片"
        >
          <img className="composer-draft-image" src={attachment.previewUrl} alt={fileName} />
        </button>
        {statusLabel ? (
          <div className={`composer-draft-status composer-draft-status-${attachment.uploadStatus}`}>
            {statusLabel}
          </div>
        ) : null}
        <button
          className="composer-draft-remove"
          type="button"
          aria-label={`移除 ${fileName}`}
          title="移除附件"
          onClick={onRemove}
          disabled={disabled}
        >
          <CloseIcon className="message-action-icon-svg" />
        </button>
      </div>
    );
  }

  return (
    <div className={`composer-draft-attachment composer-draft-attachment-file composer-draft-attachment-${attachment.uploadStatus}`}>
      <button
        className="composer-draft-file-button"
        type="button"
        onClick={() => onPreview(preview)}
        aria-label={`预览 ${fileName}`}
        title="查看附件"
      >
        <span className="composer-draft-file-icon"><FileCardIcon className="file-icon-svg" /></span>
        <span className="composer-draft-file-copy">
          <strong>{fileName}</strong>
          <span>{statusLabel ?? `已上传 · ${formatFileSize(attachment.file.size)}`}</span>
        </span>
      </button>
      <button
        className="composer-draft-remove composer-draft-remove-inline"
        type="button"
        aria-label={`移除 ${fileName}`}
        title="移除附件"
        onClick={onRemove}
        disabled={disabled}
      >
        <CloseIcon className="message-action-icon-svg" />
      </button>
    </div>
  );
}


function toStoredFilePreview(item: StoredFileItem): AttachmentPreview {
  return {
    kind: 'image',
    url: item.previewUrl ?? item.downloadUrl,
    name: item.fileName,
    size: item.fileSize,
    mime: item.fileMime,
    downloadName: item.fileName,
    sourceKey: `stored-file-${item.messageId}`,
  };
}

function isServerCleanedMessage(message: ChatMessage): boolean {
  return Boolean(message.recalledByIp?.startsWith('server:cleanup:'));
}

function getRecalledMessageText(message: ChatMessage, room: RoomSummary | null): string {
  if (isServerCleanedMessage(message)) {
    return '这个附件已被服务器清理';
  }

  if (room && message.recalledByIp === room.ownerIp) {
    return '这条消息已被群主撤回';
  }

  if (message.recalledByIp === message.senderIp) {
    return '这条消息已被用户撤回';
  }

  return '这条消息已被撤回';
}

function ReplyReferencePreview({
  roomId,
  replyContent,
  onClick,
  className = '',
}: {
  roomId: string;
  replyContent: MessageReplyContent;
  onClick: () => void;
  className?: string;
}) {
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const imageUrl = getReplyPreviewImageUrl(roomId, replyContent);
  const shouldShowImage = Boolean(imageUrl) && !imageLoadFailed;

  return (
    <button
      className={`reply-reference-preview ${className}`.trim()}
      type="button"
      onClick={onClick}
      title="点击定位到原消息"
    >
      <div className="reply-reference-copy">
        <span className="reply-reference-label">回复 {replyContent.senderNickname}:</span>
        {!shouldShowImage ? <span className="reply-reference-text">{replyContent.previewText}</span> : null}
      </div>
      {shouldShowImage && imageUrl ? (
        <img
          className="reply-reference-image"
          src={imageUrl}
          alt={replyContent.previewText}
          onError={() => setImageLoadFailed(true)}
        />
      ) : null}
    </button>
  );
}

function PackageTaskItemActions({
  resource,
  installBusy = false,
  onInstallPackage,
}: {
  resource: TaskMessageItemResource;
  installBusy?: boolean;
  onInstallPackage?: (resource: TaskMessageItemResource) => void;
}) {
  const installSupported = isAdbInstallSupportedPackageUrl(resource.fileUrl);
  const installDisabled = !installSupported || installBusy || !onInstallPackage;
  const installTitle = !installSupported
    ? 'ADB 安装仅支持 .apk/.apks 包体'
    : installBusy
      ? `正在准备安装 ${resource.fileName}`
      : `安装 ${resource.fileName}`;

  return (
    <span className="task-message-item-actions">
      <a
        className="task-message-resource-action"
        href={resource.fileUrl}
        target="_blank"
        rel="noreferrer"
        title={`下载 ${resource.fileName}`}
        aria-label={`下载 ${resource.fileName}`}
      >
        <DownloadIcon className="task-message-resource-action-icon" />
      </a>
      <button
        className="task-message-resource-action"
        type="button"
        title={`复制 ${resource.fileName} 下载链接`}
        aria-label={`复制 ${resource.fileName} 下载链接`}
        onClick={() => {
          void copyTextToClipboard(resource.fileUrl, '请复制下载链接').catch(() => undefined);
        }}
      >
        <CopyIcon className="task-message-resource-action-icon" />
      </button>
      <button
        className="task-message-resource-action"
        type="button"
        title={installTitle}
        aria-label={installTitle}
        disabled={installDisabled}
        onClick={() => {
          if (!installDisabled) {
            onInstallPackage(resource);
          }
        }}
      >
        <PackageIcon className="task-message-resource-action-icon" />
      </button>
    </span>
  );
}

function TaskMessageItemNode({
  item,
  depth,
  messageId,
  isTaskActionBusy,
  installBusy = false,
  onInstallPackage,
  onToggleItem,
  readOnly,
}: {
  item: TaskMessageItem;
  depth: number;
  messageId?: number;
  isTaskActionBusy?: (actionKey: string) => boolean;
  installBusy?: boolean;
  onInstallPackage?: (resource: TaskMessageItemResource) => void;
  onToggleItem?: (taskItemId: string, completed: boolean) => void;
  readOnly?: boolean;
}) {
  const taskActionKey = messageId ? getTaskItemActionKey(messageId, item.id) : '';
  const disabled = readOnly || !messageId || !onToggleItem || Boolean(isTaskActionBusy?.(taskActionKey));
  const hasChildren = Boolean(item.children?.length);

  return (
    <div className={`task-message-item-node ${hasChildren ? 'task-message-item-node-parent' : ''}`}>
      <label
        className={`task-message-item ${item.completed ? 'task-message-item-completed' : ''} ${item.changed ? 'task-message-item-changed' : ''} ${hasChildren ? 'task-message-item-has-children' : ''}`}
      >
        <input
          className="task-message-checkbox"
          type="checkbox"
          checked={item.completed}
          disabled={disabled}
          onChange={(event) => onToggleItem?.(item.id, event.target.checked)}
        />
        <span className="task-message-item-body">
          <span className="task-message-item-text">{item.text}</span>
          {item.changed ? <span className="task-message-item-change-badge">有变更</span> : null}
          {item.resource ? <PackageTaskItemActions resource={item.resource} installBusy={installBusy} onInstallPackage={onInstallPackage} /> : null}
          {item.completed && item.completedByNickname ? (
            <span className="task-message-item-completer" title={`由 ${item.completedByNickname} 划掉`}>
              {getTaskCompletedByBadgeText(item.completedByNickname)}
            </span>
          ) : null}
        </span>
      </label>
      {hasChildren ? (
        <div className={`task-message-item-children task-message-item-children-depth-${Math.min(depth + 1, 4)}`}>
          {item.children!.map((child) => (
            <TaskMessageItemNode
              key={child.id}
              item={child}
              depth={depth + 1}
              messageId={messageId}
              isTaskActionBusy={isTaskActionBusy}
              installBusy={installBusy}
              onInstallPackage={onInstallPackage}
              onToggleItem={onToggleItem}
              readOnly={readOnly}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskMessageCardView({
  taskContent,
  messageId,
  isTaskActionBusy,
  installBusy = false,
  onInstallPackage,
  onToggleItem,
  readOnly = false,
}: {
  taskContent: TaskMessageContent;
  messageId?: number;
  isTaskActionBusy?: (actionKey: string) => boolean;
  installBusy?: boolean;
  onInstallPackage?: (resource: TaskMessageItemResource) => void;
  onToggleItem?: (taskItemId: string, completed: boolean) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="task-message-card">
      {taskContent.sections.map((section) => (
        <section key={section.id} className="task-message-section">
          <div className="task-message-section-head">
            <div className="task-message-title">{section.title}</div>
            {section.packageSource?.sourceUrl ? (
              <a
                className="task-message-section-link"
                href={section.packageSource.sourceUrl}
                target="_blank"
                rel="noreferrer"
                title="打开包体链接"
                aria-label={`打开 ${section.title} 包体链接`}
              >
                <EyeIcon className="task-message-section-link-icon" />
                <span>打开链接</span>
              </a>
            ) : null}
          </div>
          {section.packageSource?.entries.some((entry) => entry.entryType === 'directory') ? (
            <div className="task-message-directory-list">
              {section.packageSource.entries
                .filter((entry) => entry.entryType === 'directory')
                .map((entry) => (
                  <a
                    key={entry.id}
                    className="task-message-directory-chip"
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`打开目录 ${entry.name}`}
                  >
                    <FolderIcon className="task-message-directory-icon" />
                    <span>{entry.name}</span>
                  </a>
                ))}
            </div>
          ) : null}
          <div className="task-message-groups">
            {section.groups.map((group) => (
              <section key={group.id} className="task-message-group">
                {!isSimpleDefaultTaskGroup(section.title, group.assignee) ? (
                  <div className="task-message-assignee">@{group.assignee}</div>
                ) : null}
                <div className="task-message-items">
                  {group.items.map((item) => {
                    return (
                      <TaskMessageItemNode
                        key={item.id}
                        item={item}
                        depth={0}
                        messageId={messageId}
                        isTaskActionBusy={isTaskActionBusy}
                        installBusy={installBusy}
                        onInstallPackage={onInstallPackage}
                        onToggleItem={onToggleItem}
                        readOnly={readOnly}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TaskNotifyModal({
  message,
  members,
  selectedMemberIds,
  busy,
  onToggleMember,
  onCancel,
  onConfirm,
}: {
  message: ChatMessage;
  members: FeishuBotMember[];
  selectedMemberIds: string[];
  busy: boolean;
  onToggleMember: (memberId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [keyword, setKeyword] = useState('');
  const assigneeNames = useMemo(() => collectTaskAssigneeNames(message.taskContent), [message.taskContent]);
  const filteredMembers = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    const visibleMembers = !normalizedKeyword
      ? members
      : members.filter((member) =>
          `${member.name} ${member.memberId}`.toLowerCase().includes(normalizedKeyword),
        );

    return [...visibleMembers].sort((left, right) => {
      const leftSelected = selectedMemberIds.includes(left.memberId);
      const rightSelected = selectedMemberIds.includes(right.memberId);
      if (leftSelected !== rightSelected) {
        return leftSelected ? -1 : 1;
      }

      return left.name.localeCompare(right.name, 'zh-Hans-CN');
    });
  }, [keyword, members, selectedMemberIds]);

  return (
    <>
      <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
        <div className="modal-card task-notify-modal-card" onClick={(event) => event.stopPropagation()}>
          <div className="section-head align-start">
            <div>
              <h3>发送飞书通知</h3>
              <p>仅支持已全部完成的标准任务结构，发送时会通过飞书自定义机器人推送任务内容并 @ 成员。</p>
            </div>
            <button
              className="modal-close-button"
              type="button"
              onClick={onCancel}
              disabled={busy}
              aria-label="关闭弹窗"
              title="关闭"
            >
              <CloseIcon className="modal-close-icon-svg" />
            </button>
          </div>

          <div className="task-notify-modal-body">
            <div className="task-notify-summary">
              <strong>{message.taskContent?.sections.map((section) => section.title).join(' / ') || '未命名任务'}</strong>
              {assigneeNames.length > 0 ? (
                <div className="task-notify-assignees">负责人：{assigneeNames.join('、')}</div>
              ) : null}
            </div>

            <div className="settings-block task-notify-panel">
              <input
                className="text-input"
                placeholder="搜索通知成员"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
              <div className="task-notify-members">
                {filteredMembers.length > 0 ? (
                  filteredMembers.map((member) => {
                    const checked = selectedMemberIds.includes(member.memberId);
                    return (
                      <label key={member.memberId} className={`task-notify-member ${checked ? 'task-notify-member-selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggleMember(member.memberId)}
                          disabled={busy}
                        />
                        <span className="task-notify-member-copy">
                          <strong>{member.name}</strong>
                          <span>{member.memberId}</span>
                        </span>
                      </label>
                    );
                  })
                ) : (
                  <div className="empty-state task-notify-empty">没有匹配的成员</div>
                )}
              </div>
            </div>
          </div>

          <div className="modal-actions task-notify-modal-actions">
            <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>
              取消
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={onConfirm}
              disabled={busy || selectedMemberIds.length === 0}
            >
              {busy ? '发送中…' : `发送通知${selectedMemberIds.length > 0 ? ` (${selectedMemberIds.length})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function HotfixVersionPickerModal({
  blocks,
  selectedVersionLines,
  refreshedToken,
  busy,
  onToggleVersion,
  onCancel,
  onSendText,
  onSendTask,
}: {
  blocks: HotfixVersionBlock[];
  selectedVersionLines: string[];
  refreshedToken: boolean;
  busy: boolean;
  onToggleVersion: (versionLine: string) => void;
  onCancel: () => void;
  onSendText: () => void;
  onSendTask: () => void;
}) {
  const selectedBlocks = useMemo(
    () => blocks.filter((block) => selectedVersionLines.includes(block.versionLine)),
    [blocks, selectedVersionLines],
  );
  const previewText = useMemo(() => buildHotfixBlocksText(selectedBlocks), [selectedBlocks]);

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal-card hotfix-picker-modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="section-head align-start">
          <div>
            <h3>选择热更版本</h3>
            <p>支持多选版本。发送文本会直接发到聊天中；发送任务会按负责人自动整理成任务结构并立即转任务。</p>
          </div>
          <button
            className="modal-close-button"
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="关闭弹窗"
            title="关闭"
          >
            <CloseIcon className="modal-close-icon-svg" />
          </button>
        </div>

        <div className="hotfix-picker-modal-body">
          {refreshedToken ? (
            <div className="hotfix-picker-refresh-hint">本次热更读取时已自动刷新 token。</div>
          ) : null}

          <div className="hotfix-picker-layout">
            <div className="settings-block hotfix-picker-panel">
              <div className="hotfix-picker-panel-head">
                <strong>版本列表</strong>
                <span>已选 {selectedVersionLines.length} / {blocks.length}</span>
              </div>
              <div className="hotfix-picker-version-list">
                {blocks.map((block) => {
                  const checked = selectedVersionLines.includes(block.versionLine);
                  const assignees = block.entries.map((entry) => entry.assigneeLine).join('、');
                  return (
                    <label key={block.versionLine} className={`hotfix-picker-version-item ${checked ? 'hotfix-picker-version-item-selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleVersion(block.versionLine)}
                        disabled={busy}
                      />
                      <span className="hotfix-picker-version-copy">
                        <strong>{block.versionLine}</strong>
                        <span>{countHotfixBlockItems(block)} 条 · {assignees || '未识别负责人'}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="settings-block hotfix-picker-panel">
              <div className="hotfix-picker-panel-head">
                <strong>发送预览</strong>
                <span>{selectedBlocks.length > 0 ? `${selectedBlocks.length} 个版本块` : '未选择版本'}</span>
              </div>
              {previewText ? (
                <pre className="hotfix-picker-preview">{previewText}</pre>
              ) : (
                <div className="empty-state hotfix-picker-empty">请选择要发送的版本内容</div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-actions task-notify-modal-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={onSendText}
            disabled={busy || selectedBlocks.length === 0}
          >
            {busy ? '发送中…' : '发送文本'}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={onSendTask}
            disabled={busy || selectedBlocks.length === 0}
          >
            {busy ? '处理中…' : '发送任务'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PackageDistributionModal({
  modal,
  previewBusy,
  sendBusy,
  onChangeLink,
  onAddLink,
  onRemoveLink,
  onClearLinks,
  onFetchPreview,
  onToggleAssignee,
  onCancel,
  onSend,
}: {
  modal: PackageDistributionModalState;
  previewBusy: boolean;
  sendBusy: boolean;
  onChangeLink: (linkId: string, value: string) => void;
  onAddLink: () => void;
  onRemoveLink: (linkId: string) => void;
  onClearLinks: () => void;
  onFetchPreview: () => void;
  onToggleAssignee: (blockId: string, entryId: string, assignee: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  const busy = previewBusy || sendBusy;
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(modal.blocks?.[0]?.id ?? null);
  const filledLinkCount = modal.links.filter((link) => link.value.trim().length > 0).length;
  const fileCount = useMemo(
    () => modal.blocks?.reduce((sum, block) => sum + block.entries.filter((entry) => entry.entryType === 'file').length, 0) ?? 0,
    [modal.blocks],
  );
  const unassignedFileCount = useMemo(
    () => modal.blocks?.reduce(
      (sum, block) => sum + block.entries.filter((entry) => entry.entryType === 'file' && entry.assignees.length === 0).length,
      0,
    ) ?? 0,
    [modal.blocks],
  );
  const activeBlock = useMemo(
    () => modal.blocks?.find((block) => block.id === selectedBlockId) ?? modal.blocks?.[0] ?? null,
    [modal.blocks, selectedBlockId],
  );
  const activeBlockFiles = useMemo(
    () => activeBlock?.entries.filter((entry) => entry.entryType === 'file') ?? [],
    [activeBlock],
  );
  const activeBlockDirectories = useMemo(
    () => activeBlock?.entries.filter((entry) => entry.entryType === 'directory') ?? [],
    [activeBlock],
  );

  useEffect(() => {
    const blocks = modal.blocks;
    if (!blocks || blocks.length === 0) {
      setSelectedBlockId(null);
      return;
    }

    setSelectedBlockId((current) => (
      current && blocks.some((block) => block.id === current)
        ? current
        : blocks[0].id
    ));
  }, [modal.blocks]);

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal-card package-distribution-modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="section-head align-start">
          <div>
            <h3>包体分配</h3>
            <p>输入一个或多个包体目录链接。确认后会读取目录内容，并把每个文件分配给测试人员生成任务消息。</p>
          </div>
          <button
            className="modal-close-button"
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="关闭弹窗"
            title="关闭"
          >
            <CloseIcon className="modal-close-icon-svg" />
          </button>
        </div>

        <div className="package-distribution-modal-body">
          <div className="settings-block package-distribution-link-panel">
            <div className="package-distribution-link-panel-head">
              <strong>包体链接</strong>
              <span>已填写 {filledLinkCount} / {modal.links.length}</span>
            </div>
            <div className="package-distribution-link-list">
              {modal.links.map((link, index) => (
                <div key={link.id} className="package-distribution-link-row">
                  <input
                    className="text-input"
                    placeholder="http://192.168.xx.xx:xxxx/..."
                    value={link.value}
                    onChange={(event) => onChangeLink(link.id, event.target.value)}
                    disabled={busy}
                  />
                  <button
                    className="secondary-button package-distribution-link-remove"
                    type="button"
                    onClick={() => onRemoveLink(link.id)}
                    disabled={busy || modal.links.length === 1}
                    title={`移除第 ${index + 1} 个链接`}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
            <div className="package-distribution-link-actions">
              <button className="secondary-button" type="button" onClick={onAddLink} disabled={busy}>
                + 新增链接
              </button>
              <button className="secondary-button" type="button" onClick={onClearLinks} disabled={busy}>
                清空已记住链接
              </button>
              <button className="primary-button" type="button" onClick={onFetchPreview} disabled={busy || filledLinkCount === 0}>
                {previewBusy ? '读取中…' : (modal.blocks ? '重新获取内容' : '获取内容')}
              </button>
            </div>
          </div>

          {modal.blocks ? (
            <div className="package-distribution-preview-layout">
              <div className="package-distribution-preview-summary">
                <div className="status-chip package-distribution-status-chip">
                  <span>链接块数</span>
                  <strong>{modal.blocks.length}</strong>
                </div>
                <div className="status-chip package-distribution-status-chip">
                  <span>文件数</span>
                  <strong>{fileCount}</strong>
                </div>
                <div className="status-chip package-distribution-status-chip">
                  <span>待分配</span>
                  <strong>{unassignedFileCount}</strong>
                </div>
                <div className="status-chip package-distribution-status-chip">
                  <span>测试人员</span>
                  <strong>{modal.testers.length}</strong>
                </div>
              </div>

              {modal.testers.length === 0 ? (
                <div className="package-distribution-warning">
                  当前还没有配置测试人员。请先到管理员页维护测试人员，再回来分配文件。
                </div>
              ) : null}

              <div className="package-distribution-content-layout">
                <aside className="settings-block package-distribution-sidebar">
                  <div className="package-distribution-sidebar-head">
                    <strong>链接块</strong>
                    <span>{modal.blocks.length} 个</span>
                  </div>
                  <div className="package-distribution-block-list">
                    {modal.blocks.map((block) => {
                      const blockFiles = block.entries.filter((entry) => entry.entryType === 'file');
                      const blockUnassignedCount = blockFiles.filter((entry) => entry.assignees.length === 0).length;
                      const active = activeBlock?.id === block.id;
                      return (
                        <button
                          key={block.id}
                          className={`package-distribution-block-tab${active ? ' package-distribution-block-tab-active' : ''}`}
                          type="button"
                          onClick={() => setSelectedBlockId(block.id)}
                          disabled={busy}
                        >
                          <strong>{block.title}</strong>
                          <span>{blockFiles.length} 文件 · {blockUnassignedCount > 0 ? `${blockUnassignedCount} 待分配` : '已分配完成'}</span>
                        </button>
                      );
                    })}
                  </div>
                </aside>

                {activeBlock ? (
                  <section className="settings-block package-distribution-detail-panel">
                    <div className="section-head align-start package-distribution-block-head">
                      <div className="package-distribution-block-head-copy">
                        <strong>{activeBlock.title}</strong>
                        <span className="package-distribution-block-meta">
                          {activeBlockFiles.length} 文件 · {activeBlockDirectories.length} 文件夹
                        </span>
                      </div>
                      <a
                        className="secondary-button package-distribution-open-link"
                        href={activeBlock.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开链接
                      </a>
                    </div>

                    {activeBlockFiles.length > 0 ? (
                      <div className="package-distribution-file-list">
                        {activeBlockFiles.map((entry) => (
                          <div key={entry.id} className="package-distribution-file-row">
                            <div className="package-distribution-file-copy">
                              <strong title={entry.name}>{entry.name}</strong>
                              {entry.path.trim() && entry.path.trim() !== entry.name.trim() ? (
                                <span title={entry.path}>{entry.path}</span>
                              ) : null}
                            </div>
                            <div className="package-distribution-assignee-panel">
                              <div className="package-distribution-assignee-summary">
                                {entry.assignees.length > 0
                                  ? `已选：${entry.assignees.join('、')}`
                                  : '请选择至少一位测试人员'}
                              </div>
                              {modal.testers.length > 0 ? (
                                <div className="package-distribution-assignee-selection">
                                  {modal.testers.map((tester) => {
                                    const selected = entry.assignees.includes(tester);
                                    return (
                                      <button
                                        key={tester}
                                        className={`package-distribution-assignee-chip${selected ? ' package-distribution-assignee-chip-selected' : ''}`}
                                        type="button"
                                        onClick={() => onToggleAssignee(activeBlock.id, entry.id, tester)}
                                        disabled={busy}
                                        aria-pressed={selected}
                                      >
                                        {tester}
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="package-distribution-assignee-empty">
                                  暂无可选测试人员
                                </div>
                              )}
                            </div>
                            <a
                              className="package-distribution-file-action"
                              href={entry.url}
                              target="_blank"
                              rel="noreferrer"
                              title={`下载 ${entry.name}`}
                            >
                              <DownloadIcon className="task-message-resource-action-icon" />
                            </a>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state package-distribution-file-empty">当前链接块没有可分配文件。</div>
                    )}
                  </section>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="modal-actions package-distribution-modal-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={onSend}
            disabled={busy || !modal.blocks || modal.testers.length === 0 || unassignedFileCount > 0}
          >
            {sendBusy ? '发送中…' : '发送任务'}
          </button>
        </div>
      </div>
    </div>
  );
}

function confirmRoomDangerAction(role: 'owner' | 'member', roomId: string): boolean {
  return window.confirm(
    role === 'owner'
      ? `确认要解散群组 ${roomId} 吗？解散后所有成员都会被移出当前群组。`
      : `确认要退出群组 ${roomId} 吗？退出后你可以通过房间 ID 再次加入。`,
  );
}

function AppShell({ children }: { children: ReactNode }) {
  return <div className="app-shell">{children}</div>;
}

function AttachmentPreviewModal({
  preview,
  onClose,
}: {
  preview: AttachmentPreview | null;
  onClose: () => void;
}) {
  if (!preview) {
    return null;
  }

  return (
    <div className="modal-backdrop preview-backdrop" onClick={onClose}>
      <div className="preview-card" onClick={(event) => event.stopPropagation()}>
        <div className="section-head align-start">
          <div>
            <h3>{preview.name}</h3>
            <p>
              {preview.kind === 'image' ? '图片' : '文件'}
              {preview.mime ? ` · ${preview.mime}` : ''}
              {preview.size ? ` · ${formatFileSize(preview.size)}` : ''}
            </p>
          </div>
          <button
            className="modal-close-button"
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            title="关闭"
          >
            <CloseIcon className="modal-close-icon-svg" />
          </button>
        </div>

        {preview.kind === 'image' ? (
          <div className="preview-image-wrap">
            <img className="preview-image" src={preview.url} alt={preview.name} />
          </div>
        ) : (
          <div className="preview-file-wrap">
            <iframe className="preview-file-frame" src={preview.url} title={preview.name} />
            <p className="preview-file-tip">若浏览器无法直接显示此附件，可使用下方下载按钮查看。</p>
          </div>
        )}

        <div className="preview-actions">
          <a className="primary-button as-link-button" href={preview.url} download={preview.downloadName}>
            {preview.kind === 'image' ? '下载图片' : '下载附件'}
          </a>
        </div>
      </div>
    </div>
  );
}

function HomePage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [activeRooms, setActiveRooms] = useState<ActiveRoomListItem[]>([]);
  const [joinRoomId, setJoinRoomId] = useState('');
  const [roomNameInput, setRoomNameInput] = useState('');
  const [cleanupPasswordInput, setCleanupPasswordInput] = useState(() => readStoredCleanupPassword());
  const [roomManagementPasswordInput, setRoomManagementPasswordInput] = useState(() => readStoredCleanupPassword());
  const [feishuSettingsPasswordInput, setFeishuSettingsPasswordInput] = useState(() => readStoredCleanupPassword());
  const [hotfixSettingsPasswordInput, setHotfixSettingsPasswordInput] = useState(() => readStoredCleanupPassword());
  const [packageTesterSettingsPasswordInput, setPackageTesterSettingsPasswordInput] = useState(() => readStoredCleanupPassword());
  const [homeActionTab, setHomeActionTab] = useState<'common' | 'admin'>('common');
  const [roomSearchInput, setRoomSearchInput] = useState('');
  const [roomPage, setRoomPage] = useState(1);
  const [activeRoomSearchInput, setActiveRoomSearchInput] = useState('');
  const [activeRoomPage, setActiveRoomPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  useAutoDismissMessage(error, setError);
  useAutoDismissMessage(success, setSuccess);
  const homeRefreshInFlightRef = useRef(false);
  const homeRefreshQueuedRef = useRef(false);

  const loadHome = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    try {
      const [meResponse, roomsResponse, activeRoomsResponse] = await Promise.all([getMe(), getMyRooms(), getActiveRooms()]);
      setMe(meResponse);
      setRooms(roomsResponse);
      setActiveRooms(activeRoomsResponse);
    } catch (requestError) {
      if (!silent) {
        setError(requestError instanceof Error ? requestError.message : '加载主页失败');
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  const refreshHomeSilently = useCallback(async () => {
    if (homeRefreshInFlightRef.current) {
      homeRefreshQueuedRef.current = true;
      return;
    }

    homeRefreshInFlightRef.current = true;
    try {
      await loadHome({ silent: true });
    } finally {
      homeRefreshInFlightRef.current = false;
      if (homeRefreshQueuedRef.current) {
        homeRefreshQueuedRef.current = false;
        void refreshHomeSilently();
      }
    }
  }, [loadHome]);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshHomeSilently();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [refreshHomeSilently]);

  useEffect(() => {
    const socket = createAuthedSocket();
    const handleHomeRoomsChanged = () => {
      void refreshHomeSilently();
    };
    const handleHomeRoomPresence = (payload: HomeRoomPresencePayload) => {
      setRooms((current) => updateRoomOnlineMemberCount(current, payload));
      setActiveRooms((current) => updateRoomOnlineMemberCount(current, payload));
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshHomeSilently();
      }
    };

    socket.on('connect', handleHomeRoomsChanged);
    socket.on('connect_error', (socketError) => {
      setError(socketError.message || '实时连接失败，请刷新后重试');
    });
    socket.on('home:roomsChanged', handleHomeRoomsChanged);
    socket.on('home:roomPresence', handleHomeRoomPresence);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      socket.disconnect();
    };
  }, [refreshHomeSilently]);

  const visibleRooms = useMemo(() => {
    const normalizedKeyword = roomSearchInput.trim().toLowerCase();
    const sortedRooms = sortRoomsByRecentVisits(rooms);

    if (!normalizedKeyword) {
      return sortedRooms;
    }

    return sortedRooms.filter((room) => {
      const roomName = getDisplayRoomName(room.roomName, room.roomId).toLowerCase();
      const roomId = room.roomId.toLowerCase();
      return roomName.includes(normalizedKeyword) || roomId.includes(normalizedKeyword);
    });
  }, [roomSearchInput, rooms]);

  const totalRoomPages = Math.max(1, Math.ceil(visibleRooms.length / ROOMS_PAGE_SIZE));
  const currentRoomPage = Math.min(roomPage, totalRoomPages);
  const pagedRooms = useMemo(() => {
    const startIndex = (currentRoomPage - 1) * ROOMS_PAGE_SIZE;
    return visibleRooms.slice(startIndex, startIndex + ROOMS_PAGE_SIZE);
  }, [currentRoomPage, visibleRooms]);

  const visibleActiveRooms = useMemo(() => {
    const normalizedKeyword = activeRoomSearchInput.trim().toLowerCase();

    if (!normalizedKeyword) {
      return activeRooms;
    }

    return activeRooms.filter((room) => {
      const roomName = getDisplayRoomName(room.roomName, room.roomId).toLowerCase();
      const roomId = room.roomId.toLowerCase();
      return roomName.includes(normalizedKeyword) || roomId.includes(normalizedKeyword);
    });
  }, [activeRoomSearchInput, activeRooms]);

  const totalActiveRoomPages = Math.max(1, Math.ceil(visibleActiveRooms.length / ROOMS_PAGE_SIZE));
  const currentActiveRoomPage = Math.min(activeRoomPage, totalActiveRoomPages);
  const pagedActiveRooms = useMemo(() => {
    const startIndex = (currentActiveRoomPage - 1) * ROOMS_PAGE_SIZE;
    return visibleActiveRooms.slice(startIndex, startIndex + ROOMS_PAGE_SIZE);
  }, [currentActiveRoomPage, visibleActiveRooms]);

  useEffect(() => {
    setRoomPage(1);
  }, [roomSearchInput]);

  useEffect(() => {
    if (roomPage > totalRoomPages) {
      setRoomPage(totalRoomPages);
    }
  }, [roomPage, totalRoomPages]);

  useEffect(() => {
    setActiveRoomPage(1);
  }, [activeRoomSearchInput]);

  useEffect(() => {
    if (activeRoomPage > totalActiveRoomPages) {
      setActiveRoomPage(totalActiveRoomPages);
    }
  }, [activeRoomPage, totalActiveRoomPages]);

  async function handleOpenCleanupPage() {
    const adminPassword = cleanupPasswordInput.trim();
    if (!adminPassword) {
      setError('请输入服务器文件清理管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await getServerFiles(adminPassword);
      storeCleanupPassword(adminPassword);
      setRoomManagementPasswordInput(adminPassword);
      navigate('/server/files');
    } catch (requestError) {
      clearStoredCleanupPassword();
      setCleanupPasswordInput('');
      const status = getRequestErrorStatus(requestError);
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '进入清理页失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenRoomManagementPage() {
    const adminPassword = roomManagementPasswordInput.trim();
    if (!adminPassword) {
      setError('请输入房间管理管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await getManagedRooms(adminPassword);
      storeCleanupPassword(adminPassword);
      setCleanupPasswordInput(adminPassword);
      navigate('/server/rooms');
    } catch (requestError) {
      clearStoredCleanupPassword();
      setRoomManagementPasswordInput('');
      const status = getRequestErrorStatus(requestError);
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '进入房间管理页失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenFeishuSettingsPage() {
    const adminPassword = feishuSettingsPasswordInput.trim();
    if (!adminPassword) {
      setError('请输入飞书机器人管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await getFeishuBotSettings(adminPassword);
      storeCleanupPassword(adminPassword);
      setCleanupPasswordInput(adminPassword);
      setRoomManagementPasswordInput(adminPassword);
      setHotfixSettingsPasswordInput(adminPassword);
      navigate('/server/feishu');
    } catch (requestError) {
      clearStoredCleanupPassword();
      setFeishuSettingsPasswordInput('');
      const status = getRequestErrorStatus(requestError);
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '进入飞书机器人设置页失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenHotfixSettingsPage() {
    const adminPassword = hotfixSettingsPasswordInput.trim();
    if (!adminPassword) {
      setError('请输入热更设置管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await getHotfixSettings(adminPassword);
      storeCleanupPassword(adminPassword);
      setCleanupPasswordInput(adminPassword);
      setRoomManagementPasswordInput(adminPassword);
      setFeishuSettingsPasswordInput(adminPassword);
      navigate('/server/hotfix');
    } catch (requestError) {
      clearStoredCleanupPassword();
      setHotfixSettingsPasswordInput('');
      const status = getRequestErrorStatus(requestError);
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '进入热更设置页失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenPackageTesterSettingsPage() {
    const adminPassword = packageTesterSettingsPasswordInput.trim();
    if (!adminPassword) {
      setError('请输入测试人员配置管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await getPackageTesterSettings(adminPassword);
      storeCleanupPassword(adminPassword);
      setCleanupPasswordInput(adminPassword);
      setRoomManagementPasswordInput(adminPassword);
      setFeishuSettingsPasswordInput(adminPassword);
      setHotfixSettingsPasswordInput(adminPassword);
      navigate('/server/package-testers');
    } catch (requestError) {
      clearStoredCleanupPassword();
      setPackageTesterSettingsPasswordInput('');
      const status = getRequestErrorStatus(requestError);
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '进入测试人员配置页失败');
    } finally {
      setBusy(false);
    }
  }

  async function executeCreateOrJoin(action: 'create' | 'join') {
    const roomName = roomNameInput.trim();

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      if (action === 'create') {
        if (!roomName) {
          throw new Error('请输入房间主题名');
        }

        const room = await createRoom(roomName);
        setRoomNameInput('');
        markRoomVisited(room.roomId);
        navigate(`/rooms/${room.roomId}`);
        return;
      }

      const roomId = joinRoomId.trim().toUpperCase();
      if (!roomId) {
        throw new Error('请输入房间 ID');
      }

      const result = await joinRoom(roomId);
      markRoomVisited(result.room.roomId);
      navigate(`/rooms/${result.room.roomId}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleActiveRoomJoin(roomId: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await joinRoom(roomId);
      markRoomVisited(result.room.roomId);
      navigate(`/rooms/${result.room.roomId}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加入群组失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleRoomAction(roomId: string, role: RoomListItem['role']) {
    if (!confirmRoomDangerAction(role, roomId)) {
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      if (role === 'owner') {
        await dissolveRoom(roomId);
      } else {
        await leaveRoom(roomId);
      }
      await loadHome();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '群组操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <FloatingFeedbackToasts error={error} success={success} />
      <header className="hero-card">
        <div>
          <div className="eyebrow">LAN CHAT</div>
          <h1>局域网内容传输</h1>
          <p>同一局域网设备可直接创建群组、加入群组、发送文本、图片和文件。</p>
        </div>
        <div className="status-grid">
          <UserIdentityCard me={me} displayName={me?.nickname} />
        </div>
      </header>

      <section className="home-entry-switcher" aria-label="主页功能分类">
        <div className="home-entry-switcher-copy">
          <span className="home-entry-switcher-label">入口分类</span>
          <span className="home-entry-switcher-hint">
            {homeActionTab === 'common' ? '默认隐藏管理员入口' : '以下功能需要管理员密码'}
          </span>
        </div>

        <div className="home-entry-tabs" role="tablist" aria-label="主页功能分类">
          <button
            className={`home-entry-tab ${homeActionTab === 'common' ? 'home-entry-tab-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={homeActionTab === 'common'}
            onClick={() => setHomeActionTab('common')}
          >
            常用功能
          </button>
          <button
            className={`home-entry-tab ${homeActionTab === 'admin' ? 'home-entry-tab-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={homeActionTab === 'admin'}
            onClick={() => setHomeActionTab('admin')}
          >
            管理员功能
          </button>
        </div>
      </section>

      {homeActionTab === 'common' ? (
        <section className="card-grid">
          <article className="panel-card home-action-card">
            <div className="home-action-copy">
              <h2>创建群组</h2>
              <p>创建后会自动加入，并获得可分享的房间 ID。</p>
            </div>
            <div className="stack-gap home-action-form">
              <input
                className="text-input"
                maxLength={40}
                placeholder="请输入房间主题名"
                value={roomNameInput}
                onChange={(event) => setRoomNameInput(event.target.value)}
              />
              <button className="primary-button" type="button" onClick={() => void executeCreateOrJoin('create')} disabled={loading || busy}>
                创建群组
              </button>
            </div>
          </article>

          <article className="panel-card home-action-card">
            <div className="home-action-copy">
              <h2>加入群组</h2>
              <p>输入朋友分享给你的房间 ID，直接进入已有聊天。</p>
            </div>
            <div className="stack-gap home-action-form">
              <input
                className="text-input"
                placeholder="请输入房间 ID"
                maxLength={8}
                value={joinRoomId}
                onChange={(event) => setJoinRoomId(event.target.value.toUpperCase())}
              />
              <button className="primary-button" type="button" onClick={() => void executeCreateOrJoin('join')} disabled={loading || busy}>
                加入群组
              </button>
            </div>
          </article>
        </section>
      ) : (
        <section className="admin-entry-grid">
          <article className="panel-card home-action-card">
            <div className="home-action-copy">
              <h2>服务器文件清理</h2>
              <p>查看服务器保留的图片 / 文件；进入前需要输入管理员密码。</p>
            </div>
            <div className="stack-gap home-action-form">
              <input
                className="text-input"
                type="password"
                placeholder="请输入管理员密码"
                value={cleanupPasswordInput}
                onChange={(event) => setCleanupPasswordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleOpenCleanupPage();
                  }
                }}
              />
              <button className="secondary-button" type="button" onClick={() => void handleOpenCleanupPage()} disabled={loading || busy}>
                进入清理页
              </button>
            </div>
          </article>

          <article className="panel-card home-action-card">
            <div className="home-action-copy">
              <h2>房间管理</h2>
              <p>查看全部房间、批量解散与恢复；进入前需要输入管理员密码。</p>
            </div>
            <div className="stack-gap home-action-form">
              <input
                className="text-input"
                type="password"
                placeholder="请输入管理员密码"
                value={roomManagementPasswordInput}
                onChange={(event) => setRoomManagementPasswordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleOpenRoomManagementPage();
                  }
                }}
              />
              <button className="secondary-button" type="button" onClick={() => void handleOpenRoomManagementPage()} disabled={loading || busy}>
                进入管理页
              </button>
            </div>
          </article>

          <article className="panel-card home-action-card">
            <div className="home-action-copy">
              <h2>飞书机器人</h2>
              <p>配置 webhook 与通知成员，供任务完成后发送飞书通知。</p>
            </div>
            <div className="stack-gap home-action-form">
              <input
                className="text-input"
                type="password"
                placeholder="请输入管理员密码"
                value={feishuSettingsPasswordInput}
                onChange={(event) => setFeishuSettingsPasswordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleOpenFeishuSettingsPage();
                  }
                }}
              />
              <button className="secondary-button" type="button" onClick={() => void handleOpenFeishuSettingsPage()} disabled={loading || busy}>
                进入设置页
              </button>
            </div>
          </article>

          <article className="panel-card home-action-card">
            <div className="home-action-copy">
              <h2>飞书热更</h2>
              <p>配置飞书文档 ID，并查看服务器保存的最新 service token 数据。</p>
            </div>
            <div className="stack-gap home-action-form">
              <input
                className="text-input"
                type="password"
                placeholder="请输入管理员密码"
                value={hotfixSettingsPasswordInput}
                onChange={(event) => setHotfixSettingsPasswordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleOpenHotfixSettingsPage();
                  }
                }}
              />
              <button className="secondary-button" type="button" onClick={() => void handleOpenHotfixSettingsPage()} disabled={loading || busy}>
                进入设置页
              </button>
            </div>
          </article>

          <article className="panel-card home-action-card">
            <div className="home-action-copy">
              <h2>测试人员配置</h2>
              <p>维护包体分配弹窗里的测试人员列表；进入前需要输入管理员密码。</p>
            </div>
            <div className="stack-gap home-action-form">
              <input
                className="text-input"
                type="password"
                placeholder="请输入管理员密码"
                value={packageTesterSettingsPasswordInput}
                onChange={(event) => setPackageTesterSettingsPasswordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleOpenPackageTesterSettingsPage();
                  }
                }}
              />
              <button className="secondary-button" type="button" onClick={() => void handleOpenPackageTesterSettingsPage()} disabled={loading || busy}>
                进入设置页
              </button>
            </div>
          </article>
        </section>
      )}

      {homeActionTab === 'common' ? (
        <section className="room-overview-grid">
          <section className="panel-card room-list-card">
          <div className="room-list-head">
            <div>
              <h2>当前所在群组</h2>
              <p>会自动恢复此设备加入或创建过且仍有效的群组。</p>
            </div>
          </div>

          <div className="room-list-toolbar">
            <input
              className="text-input room-search-input"
              placeholder="搜索房间主题或房间号"
              value={roomSearchInput}
              onChange={(event) => setRoomSearchInput(event.target.value)}
            />
            <button className="secondary-button room-refresh-button" type="button" onClick={() => void loadHome()} disabled={loading || busy}>
              刷新
            </button>
          </div>

          <div className="room-list-meta-bar">
            <span>{roomSearchInput.trim() ? `匹配 ${visibleRooms.length} 个房间` : `共 ${visibleRooms.length} 个房间`}</span>
            <span>每页 10 个 · 最近进入优先</span>
          </div>

          {loading ? <div className="empty-state">加载中…</div> : null}
          {!loading && rooms.length === 0 ? <div className="empty-state">你当前还没有活跃群组。</div> : null}
          {!loading && rooms.length > 0 && visibleRooms.length === 0 ? <div className="empty-state">没有找到匹配的房间。</div> : null}

          {!loading && visibleRooms.length > 0 ? (
            <>
              <div className="room-list">
                {pagedRooms.map((room) => (
                  <div key={room.roomId} className="room-item">
                    <div className="room-item-content">
                      <div className="room-title-row">
                        <strong className="room-name">房间主题：{getDisplayRoomName(room.roomName, room.roomId)}</strong>
                        <div className="room-title-badges">
                          {room.unreadMentionCount > 0 ? (
                            <span className="mention-room-badge">有人@你{room.unreadMentionCount > 1 ? ` · ${room.unreadMentionCount}` : ''}</span>
                          ) : null}
                          <span className="role-badge">{room.role === 'owner' ? '群主' : '成员'}</span>
                        </div>
                      </div>
                      <div className="room-meta">房间号：{room.roomId}</div>
                      <div className="room-meta">在线成员/成员总数：{formatRoomOnlineMemberSummary(room)}</div>
                      <div className="room-meta">最近进入：{formatDateTime(room.joinedAt)}</div>
                      <div className="room-meta">最近消息：{formatDateTime(room.lastMessageAt ?? room.createdAt)}</div>
                      {room.unreadMentionCount > 0 && room.latestUnreadMentionAt ? (
                        <div className="room-meta mention-room-meta">@提醒：{formatDateTime(room.latestUnreadMentionAt)}</div>
                      ) : null}
                    </div>
                    <div className="room-actions">
                      <button className="secondary-button" type="button" onClick={() => { markRoomVisited(room.roomId); navigate(`/rooms/${room.roomId}`); }}>
                        进入
                      </button>
                      <button className="danger-button" type="button" onClick={() => void handleRoomAction(room.roomId, room.role)} disabled={busy}>
                        {room.role === 'owner' ? '解散' : '退出'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {visibleRooms.length > ROOMS_PAGE_SIZE ? (
                <div className="room-pagination">
                  <button
                    className="secondary-button room-page-button"
                    type="button"
                    onClick={() => setRoomPage((current) => Math.max(1, current - 1))}
                    disabled={currentRoomPage <= 1 || loading || busy}
                  >
                    上一页
                  </button>
                  <div className="room-pagination-meta">第 {currentRoomPage} / {totalRoomPages} 页</div>
                  <button
                    className="secondary-button room-page-button"
                    type="button"
                    onClick={() => setRoomPage((current) => Math.min(totalRoomPages, current + 1))}
                    disabled={currentRoomPage >= totalRoomPages || loading || busy}
                  >
                    下一页
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        <section className="panel-card room-list-card">
          <div className="room-list-head">
            <div>
              <h2>活跃群组</h2>
              <p>展示当前所有可直接加入的活跃群组，无需邀请码即可一键加入。</p>
            </div>
          </div>

          <div className="room-list-toolbar">
            <input
              className="text-input room-search-input"
              placeholder="搜索活跃群组主题或房间号"
              value={activeRoomSearchInput}
              onChange={(event) => setActiveRoomSearchInput(event.target.value)}
            />
            <button className="secondary-button room-refresh-button" type="button" onClick={() => void loadHome()} disabled={loading || busy}>
              刷新
            </button>
          </div>

          <div className="room-list-meta-bar">
            <span>{activeRoomSearchInput.trim() ? `匹配 ${visibleActiveRooms.length} 个群组` : `共 ${visibleActiveRooms.length} 个群组`}</span>
            <span>每页 10 个 · 按最近活跃排序</span>
          </div>

          {loading ? <div className="empty-state">加载中…</div> : null}
          {!loading && activeRooms.length === 0 ? <div className="empty-state">当前还没有可直接加入的活跃群组。</div> : null}
          {!loading && activeRooms.length > 0 && visibleActiveRooms.length === 0 ? <div className="empty-state">没有找到匹配的群组。</div> : null}

          {!loading && visibleActiveRooms.length > 0 ? (
            <>
              <div className="room-list">
                {pagedActiveRooms.map((room) => {
                  const isJoined = Boolean(room.role);

                  return (
                    <div key={room.roomId} className="room-item">
                      <div className="room-item-content">
                        <div className="room-title-row">
                          <strong className="room-name">房间主题：{getDisplayRoomName(room.roomName, room.roomId)}</strong>
                          <div className="room-title-badges">
                            {isJoined && room.unreadMentionCount > 0 ? (
                              <span className="mention-room-badge">有人@你{room.unreadMentionCount > 1 ? ` · ${room.unreadMentionCount}` : ''}</span>
                            ) : null}
                            {isJoined ? <span className="role-badge">{room.role === 'owner' ? '群主' : '成员'}</span> : <span className="joinable-room-badge">可加入</span>}
                          </div>
                        </div>
                        <div className="room-meta">房间号：{room.roomId}</div>
                        <div className="room-meta">在线成员/成员总数：{formatRoomOnlineMemberSummary(room)}</div>
                        <div className="room-meta">最近消息：{formatDateTime(room.lastMessageAt ?? room.createdAt)}</div>
                        <div className="room-meta">{isJoined ? `最近进入：${formatDateTime(room.joinedAt)}` : `创建时间：${formatDateTime(room.createdAt)}`}</div>
                        {isJoined && room.unreadMentionCount > 0 && room.latestUnreadMentionAt ? (
                          <div className="room-meta mention-room-meta">@提醒：{formatDateTime(room.latestUnreadMentionAt)}</div>
                        ) : null}
                      </div>
                      <div className="room-actions">
                        {isJoined ? (
                          <>
                            <button className="secondary-button" type="button" onClick={() => { markRoomVisited(room.roomId); navigate(`/rooms/${room.roomId}`); }}>
                              进入
                            </button>
                            <button className="danger-button" type="button" onClick={() => void handleRoomAction(room.roomId, room.role as RoomListItem['role'])} disabled={busy}>
                              {room.role === 'owner' ? '解散' : '退出'}
                            </button>
                          </>
                        ) : (
                          <button className="primary-button" type="button" onClick={() => void handleActiveRoomJoin(room.roomId)} disabled={busy}>
                            加入
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {visibleActiveRooms.length > ROOMS_PAGE_SIZE ? (
                <div className="room-pagination">
                  <button
                    className="secondary-button room-page-button"
                    type="button"
                    onClick={() => setActiveRoomPage((current) => Math.max(1, current - 1))}
                    disabled={currentActiveRoomPage <= 1 || loading || busy}
                  >
                    上一页
                  </button>
                  <div className="room-pagination-meta">第 {currentActiveRoomPage} / {totalActiveRoomPages} 页</div>
                  <button
                    className="secondary-button room-page-button"
                    type="button"
                    onClick={() => setActiveRoomPage((current) => Math.min(totalActiveRoomPages, current + 1))}
                    disabled={currentActiveRoomPage >= totalActiveRoomPages || loading || busy}
                  >
                    下一页
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
          </section>
        </section>
      ) : null}
    </AppShell>
  );
}

function PackageTesterSettingsPage() {
  const navigate = useNavigate();
  const [testersInput, setTestersInput] = useState('');
  const [savedSettings, setSavedSettings] = useState<PackageTesterSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [passwordInput, setPasswordInput] = useState(() => readStoredCleanupPassword());
  const [authorized, setAuthorized] = useState(() => Boolean(readStoredCleanupPassword().trim()));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  useAutoDismissMessage(error, setError);
  useAutoDismissMessage(success, setSuccess);

  const previewTesters = useMemo(() => parsePackageTesterEditorValue(testersInput), [testersInput]);

  function applySettings(settings: PackageTesterSettings) {
    setSavedSettings(settings);
    setTestersInput(buildPackageTesterEditorValue(settings.testers));
  }

  function handleUnauthorized() {
    clearStoredCleanupPassword();
    setAuthorized(false);
    setPasswordInput('');
    setSavedSettings(null);
    setTestersInput('');
  }

  async function loadSettings(adminPassword = passwordInput.trim()): Promise<boolean> {
    if (!adminPassword) {
      setLoading(false);
      setAuthorized(false);
      return false;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await getPackageTesterSettings(adminPassword);
      applySettings(response);
      storeCleanupPassword(adminPassword);
      setPasswordInput(adminPassword);
      setAuthorized(true);
      return true;
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleUnauthorized();
        setError('管理员密码错误，请重新输入');
      } else {
        setError(requestError instanceof Error ? requestError.message : '加载测试人员配置失败');
      }
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const storedPassword = readStoredCleanupPassword().trim();
    if (!storedPassword) {
      setLoading(false);
      return;
    }

    void loadSettings(storedPassword);
  }, []);

  async function handleUnlockPage() {
    const adminPassword = passwordInput.trim();
    if (!adminPassword) {
      setError('请输入管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const unlocked = await loadSettings(adminPassword);
      if (unlocked) {
        setSuccess('管理员密码验证成功');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSettings() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await updatePackageTesterSettings(
        {
          testers: previewTesters,
        },
        passwordInput.trim(),
      );
      applySettings(response);
      setSuccess(response.testers.length > 0 ? '测试人员配置已保存' : '已清空测试人员配置');
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleUnauthorized();
      }
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '保存测试人员配置失败');
    } finally {
      setBusy(false);
    }
  }

  if (!authorized) {
    return (
      <AppShell>
        <FloatingFeedbackToasts error={error} success={success} />
        <header className="hero-card cleanup-hero">
          <div>
            <div className="eyebrow">TESTERS</div>
            <h1>测试人员配置</h1>
            <p>进入设置页前，请先输入管理员密码。</p>
          </div>
        </header>

        <section className="panel-card home-action-card cleanup-auth-card">
          <div className="home-action-copy">
            <h2>管理员验证</h2>
            <p>该页面与服务器文件清理、房间管理共用同一管理员密码。</p>
          </div>

          <div className="stack-gap home-action-form">
            <input
              className="text-input"
              type="password"
              placeholder="请输入管理员密码"
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleUnlockPage();
                }
              }}
            />
            <div className="cleanup-auth-actions">
              <button className="secondary-button" type="button" onClick={() => navigate('/')} disabled={busy}>
                返回主页
              </button>
              <button className="primary-button" type="button" onClick={() => void handleUnlockPage()} disabled={busy}>
                验证并进入
              </button>
            </div>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <FloatingFeedbackToasts error={error} success={success} />
      <header className="hero-card cleanup-hero">
        <div>
          <div className="eyebrow">TESTERS</div>
          <h1>测试人员配置</h1>
          <p>聊天页“包体分配”弹窗里的负责人下拉选项来自这里，按行维护即可。</p>
        </div>
        <div className="status-grid">
          <div className="status-chip">
            <span>当前人数</span>
            <strong>{loading ? '--' : previewTesters.length}</strong>
          </div>
          <div className="status-chip">
            <span>最近保存</span>
            <strong>{savedSettings?.updatedAt ? formatDateTime(savedSettings.updatedAt) : '未保存'}</strong>
          </div>
        </div>
      </header>

      <section className="panel-card cleanup-panel feishu-settings-panel">
        <div className="section-head cleanup-section-head">
          <div>
            <h2>人员配置</h2>
            <p>每行一个测试人员名称。保存后，包体分配弹窗会立即使用最新列表。</p>
          </div>
          <div className="cleanup-header-actions">
            <button className="secondary-button" type="button" onClick={() => navigate('/')}>
              返回主页
            </button>
            <button className="secondary-button" type="button" onClick={() => void loadSettings()} disabled={loading || busy}>
              刷新
            </button>
          </div>
        </div>

        <div className="settings-block">
          <label className="feishu-settings-label">
            <span>测试人员列表</span>
            <textarea
              className="composer-input feishu-settings-textarea"
              placeholder={'裘心宇\n刘庆林\n汤睿哲'}
              value={testersInput}
              onChange={(event) => setTestersInput(event.target.value)}
            />
          </label>
        </div>

        <div className="section-head align-start feishu-settings-preview-head">
          <div>
            <h2>预览</h2>
            <p>保存时会自动去重并清理空行。</p>
          </div>
          <button className="primary-button" type="button" onClick={() => void handleSaveSettings()} disabled={busy}>
            {busy ? '保存中…' : '保存配置'}
          </button>
        </div>

        {previewTesters.length > 0 ? (
          <div className="feishu-member-preview-list">
            {previewTesters.map((tester) => (
              <div key={tester} className="feishu-member-preview-item">
                <strong>{tester}</strong>
                <span>测试人员</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">当前还没有配置测试人员。</div>
        )}
      </section>
    </AppShell>
  );
}

function FeishuBotSettingsPage() {
  const navigate = useNavigate();
  const [webhookUrlInput, setWebhookUrlInput] = useState('');
  const [taskCreationWebhookUrlInput, setTaskCreationWebhookUrlInput] = useState('');
  const [membersConfigInput, setMembersConfigInput] = useState('');
  const [savedSettings, setSavedSettings] = useState<FeishuBotSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [passwordInput, setPasswordInput] = useState(() => readStoredCleanupPassword());
  const [authorized, setAuthorized] = useState(() => Boolean(readStoredCleanupPassword().trim()));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  useAutoDismissMessage(error, setError);
  useAutoDismissMessage(success, setSuccess);

  const parsedMembersResult = useMemo(() => parseFeishuMembersEditorValue(membersConfigInput), [membersConfigInput]);
  const previewMembers = useMemo(
    () => Array.from(new Map(parsedMembersResult.members.map((member) => [member.memberId, member])).values()),
    [parsedMembersResult.members],
  );

  function applySettings(settings: FeishuBotSettings) {
    setSavedSettings(settings);
    setWebhookUrlInput(settings.webhookUrl);
    setTaskCreationWebhookUrlInput(settings.taskCreationWebhookUrl);
    setMembersConfigInput(buildFeishuMembersEditorValue(settings.members));
  }

  function handleUnauthorized() {
    clearStoredCleanupPassword();
    setAuthorized(false);
    setPasswordInput('');
    setSavedSettings(null);
    setWebhookUrlInput('');
    setTaskCreationWebhookUrlInput('');
    setMembersConfigInput('');
  }

  async function loadSettings(adminPassword = passwordInput.trim()): Promise<boolean> {
    if (!adminPassword) {
      setLoading(false);
      setAuthorized(false);
      return false;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await getFeishuBotSettings(adminPassword);
      applySettings(response);
      storeCleanupPassword(adminPassword);
      setPasswordInput(adminPassword);
      setAuthorized(true);
      return true;
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleUnauthorized();
        setError('管理员密码错误，请重新输入');
      } else {
        setError(requestError instanceof Error ? requestError.message : '加载飞书机器人设置失败');
      }
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const storedPassword = readStoredCleanupPassword().trim();
    if (!storedPassword) {
      setLoading(false);
      return;
    }

    void loadSettings(storedPassword);
  }, []);

  async function handleUnlockPage() {
    const adminPassword = passwordInput.trim();
    if (!adminPassword) {
      setError('请输入管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const unlocked = await loadSettings(adminPassword);
      if (unlocked) {
        setSuccess('管理员密码验证成功');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSettings() {
    if (parsedMembersResult.error) {
      setError(parsedMembersResult.error);
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await updateFeishuBotSettings(
        {
          webhookUrl: webhookUrlInput.trim(),
          taskCreationWebhookUrl: taskCreationWebhookUrlInput.trim(),
          members: previewMembers,
        },
        passwordInput.trim(),
      );
      applySettings(response);
      const enabledLabels = [
        response.enabled ? '完成通知' : '',
        response.taskCreationEnabled ? '创建通知' : '',
      ].filter(Boolean);
      setSuccess(enabledLabels.length > 0 ? `飞书机器人配置已保存并启用：${enabledLabels.join('、')}` : '飞书配置已保存，需补全 webhook 后才会启用');
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleUnauthorized();
      }
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '保存飞书机器人设置失败');
    } finally {
      setBusy(false);
    }
  }

  if (!authorized) {
    return (
      <AppShell>
        <FloatingFeedbackToasts error={error} success={success} />
        <header className="hero-card cleanup-hero">
          <div>
            <div className="eyebrow">FEISHU BOT</div>
            <h1>飞书机器人设置</h1>
            <p>进入设置页前，请先输入管理员密码。</p>
          </div>
        </header>

        <section className="panel-card home-action-card cleanup-auth-card">
          <div className="home-action-copy">
            <h2>管理员验证</h2>
            <p>该页面与服务器文件清理、房间管理共用同一管理员密码。</p>
          </div>

          <div className="stack-gap home-action-form">
            <input
              className="text-input"
              type="password"
              placeholder="请输入管理员密码"
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleUnlockPage();
                }
              }}
            />
            <div className="cleanup-auth-actions">
              <button className="secondary-button" type="button" onClick={() => navigate('/')} disabled={busy}>
                返回主页
              </button>
              <button className="primary-button" type="button" onClick={() => void handleUnlockPage()} disabled={busy}>
                验证并进入
              </button>
            </div>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <FloatingFeedbackToasts error={error} success={success} />
      <header className="hero-card cleanup-hero">
        <div>
          <div className="eyebrow">FEISHU BOT</div>
          <h1>飞书机器人设置</h1>
          <p>配置完成后，标准任务完成通知和任务创建通知会通过对应飞书自定义机器人发送。</p>
        </div>
        <div className="status-grid">
          <div className="status-chip">
            <span>完成通知</span>
            <strong>{loading ? '--' : savedSettings?.enabled ? '已启用' : '未启用'}</strong>
          </div>
          <div className="status-chip">
            <span>创建通知</span>
            <strong>{loading ? '--' : savedSettings?.taskCreationEnabled ? '已启用' : '未启用'}</strong>
          </div>
          <div className="status-chip">
            <span>通知成员数</span>
            <strong>{loading ? '--' : previewMembers.length}</strong>
          </div>
          <div className="status-chip">
            <span>最近保存</span>
            <strong>{savedSettings?.updatedAt ? formatDateTime(savedSettings.updatedAt) : '未保存'}</strong>
          </div>
        </div>
      </header>

      <section className="panel-card cleanup-panel feishu-settings-panel">
        <div className="section-head cleanup-section-head">
          <div>
            <h2>通知配置</h2>
            <p>完成通知需要 webhook 和成员；创建通知只需要填写专用 webhook。</p>
          </div>
          <div className="cleanup-header-actions">
            <button className="secondary-button" type="button" onClick={() => navigate('/')}>
              返回主页
            </button>
            <button className="secondary-button" type="button" onClick={() => void loadSettings()} disabled={loading || busy}>
              刷新
            </button>
          </div>
        </div>

        <div className="settings-block">
          <label className="feishu-settings-label">
            <span>任务完成通知 Webhook 地址</span>
            <input
              className="text-input"
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
              value={webhookUrlInput}
              onChange={(event) => setWebhookUrlInput(event.target.value)}
            />
          </label>
          <label className="feishu-settings-label">
            <span>任务创建通知 Webhook 地址</span>
            <input
              className="text-input"
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
              value={taskCreationWebhookUrlInput}
              onChange={(event) => setTaskCreationWebhookUrlInput(event.target.value)}
            />
          </label>
          <label className="feishu-settings-label">
            <span>人员管理配置</span>
            <textarea
              className="composer-input feishu-settings-textarea"
              placeholder="粘贴成员数组，或飞书成员接口返回的完整 JSON（支持 data.items）"
              value={membersConfigInput}
              onChange={(event) => setMembersConfigInput(event.target.value)}
            />
          </label>
          {parsedMembersResult.error ? (
            <div className="feishu-settings-parse-error">{parsedMembersResult.error}</div>
          ) : null}
        </div>

        <div className="section-head align-start feishu-settings-preview-head">
          <div>
            <h2>成员预览</h2>
            <p>通知弹窗会基于这里的成员列表进行 @ 选择，并自动尝试勾选与任务负责人同名的成员。</p>
          </div>
          <button className="primary-button" type="button" onClick={() => void handleSaveSettings()} disabled={busy || Boolean(parsedMembersResult.error)}>
            {busy ? '保存中…' : '保存配置'}
          </button>
        </div>

        {previewMembers.length > 0 ? (
          <div className="feishu-member-preview-list">
            {previewMembers.map((member) => (
              <div key={member.memberId} className="feishu-member-preview-item">
                <strong>{member.name}</strong>
                <span>{member.memberIdType} · {member.memberId}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">还没有可用的飞书通知成员。</div>
        )}
      </section>
    </AppShell>
  );
}

function HotfixSettingsPage() {
  const navigate = useNavigate();
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [documentIdInput, setDocumentIdInput] = useState('');
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');
  const [savedSettings, setSavedSettings] = useState<HotfixSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [passwordInput, setPasswordInput] = useState(() => readStoredCleanupPassword());
  const [authorized, setAuthorized] = useState(() => Boolean(readStoredCleanupPassword().trim()));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  useAutoDismissMessage(error, setError);
  useAutoDismissMessage(success, setSuccess);

  function applySettings(settings: HotfixSettings) {
    setSavedSettings(settings);
    setBaseUrlInput(settings.baseUrl);
    setDocumentIdInput(settings.documentId);
    setClientIdInput(settings.clientId);
    setClientSecretInput(settings.clientSecret);
  }

  function handleUnauthorized() {
    clearStoredCleanupPassword();
    setAuthorized(false);
    setPasswordInput('');
    setSavedSettings(null);
    setBaseUrlInput('');
    setDocumentIdInput('');
    setClientIdInput('');
    setClientSecretInput('');
  }

  async function loadSettings(adminPassword = passwordInput.trim()): Promise<boolean> {
    if (!adminPassword) {
      setLoading(false);
      setAuthorized(false);
      return false;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await getHotfixSettings(adminPassword);
      applySettings(response);
      storeCleanupPassword(adminPassword);
      setPasswordInput(adminPassword);
      setAuthorized(true);
      return true;
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleUnauthorized();
        setError('管理员密码错误，请重新输入');
      } else {
        setError(requestError instanceof Error ? requestError.message : '加载热更设置失败');
      }
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const storedPassword = readStoredCleanupPassword().trim();
    if (!storedPassword) {
      setLoading(false);
      return;
    }

    void loadSettings(storedPassword);
  }, []);

  async function handleUnlockPage() {
    const adminPassword = passwordInput.trim();
    if (!adminPassword) {
      setError('请输入管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const unlocked = await loadSettings(adminPassword);
      if (unlocked) {
        setSuccess('管理员密码验证成功');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSettings() {
    const adminPassword = passwordInput.trim();
    if (!adminPassword) {
      setError('请输入管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await updateHotfixSettings(
        {
          baseUrl: baseUrlInput.trim(),
          documentId: documentIdInput.trim(),
          clientId: clientIdInput.trim(),
          clientSecret: clientSecretInput.trim(),
        },
        adminPassword,
      );
      applySettings(response);
      setSuccess(
        response.documentId || response.clientId || response.clientSecret
          ? '热更配置已保存'
          : '已清空热更配置',
      );
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleUnauthorized();
      }
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '保存热更设置失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshAuthToken() {
    const adminPassword = passwordInput.trim();
    if (!adminPassword) {
      setError('请输入管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await refreshHotfixAuth(adminPassword);
      applySettings(response);
      setSuccess('热更服务鉴权成功，token 已更新');
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleUnauthorized();
      }
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '热更服务鉴权失败');
    } finally {
      setBusy(false);
    }
  }

  if (!authorized) {
    return (
      <AppShell>
        <FloatingFeedbackToasts error={error} success={success} />
        <header className="hero-card cleanup-hero">
          <div>
            <div className="eyebrow">HOTFIX</div>
            <h1>飞书热更设置</h1>
            <p>进入设置页前，请先输入管理员密码。</p>
          </div>
        </header>

        <section className="panel-card home-action-card cleanup-auth-card">
          <div className="home-action-copy">
            <h2>管理员验证</h2>
            <p>该页面与服务器文件清理、房间管理共用同一管理员密码。</p>
          </div>

          <div className="stack-gap home-action-form">
            <input
              className="text-input"
              type="password"
              placeholder="请输入管理员密码"
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleUnlockPage();
                }
              }}
            />
            <div className="cleanup-auth-actions">
              <button className="secondary-button" type="button" onClick={() => navigate('/')} disabled={busy}>
                返回主页
              </button>
              <button className="primary-button" type="button" onClick={() => void handleUnlockPage()} disabled={busy}>
                验证并进入
              </button>
            </div>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <FloatingFeedbackToasts error={error} success={success} />
      <header className="hero-card cleanup-hero">
        <div>
          <div className="eyebrow">HOTFIX</div>
          <h1>飞书热更设置</h1>
          <p>服务器会优先复用这里保存的 service token；若文档读取因 token 失效失败，会自动重新鉴权并覆盖旧数据。</p>
        </div>
        <div className="status-grid">
          <div className="status-chip">
            <span>服务地址</span>
            <strong>{loading ? '--' : (savedSettings?.baseUrl || '默认值')}</strong>
          </div>
          <div className="status-chip">
            <span>文档 ID</span>
            <strong>{loading ? '--' : (savedSettings?.documentId || '未配置')}</strong>
          </div>
          <div className="status-chip">
            <span>client_id</span>
            <strong>{loading ? '--' : (savedSettings?.clientId || '未配置')}</strong>
          </div>
          <div className="status-chip">
            <span>client_secret</span>
            <strong>{loading ? '--' : savedSettings?.clientSecret ? '已配置' : '未配置'}</strong>
          </div>
          <div className="status-chip">
            <span>Token 状态</span>
            <strong>{loading ? '--' : savedSettings?.auth ? '已保存' : '未保存'}</strong>
          </div>
          <div className="status-chip">
            <span>最近更新</span>
            <strong>{savedSettings?.updatedAt ? formatDateTime(savedSettings.updatedAt) : '未更新'}</strong>
          </div>
        </div>
      </header>

      <section className="panel-card cleanup-panel feishu-settings-panel">
        <div className="section-head cleanup-section-head">
          <div>
            <h2>热更配置</h2>
            <p>请填写飞书新版文档 `document_id`。聊天页点击“获取热更”后，会读取这里配置的目标文档内容。</p>
          </div>
          <div className="cleanup-header-actions">
            <button className="secondary-button" type="button" onClick={() => navigate('/')}>
              返回主页
            </button>
            <button className="secondary-button" type="button" onClick={() => void loadSettings()} disabled={loading || busy}>
              刷新
            </button>
          </div>
        </div>

        <div className="settings-block">
          <label className="feishu-settings-label">
            <span>服务地址</span>
            <input
              className="text-input"
              placeholder="http://192.168.50.5:8005"
              value={baseUrlInput}
              onChange={(event) => setBaseUrlInput(event.target.value)}
            />
          </label>
          <label className="feishu-settings-label">
            <span>文档 ID</span>
            <input
              className="text-input"
              placeholder="doxcnAJ9VRRJqVMYZ1MyKnavXWe"
              value={documentIdInput}
              onChange={(event) => setDocumentIdInput(event.target.value)}
            />
          </label>
          <label className="feishu-settings-label">
            <span>client_id</span>
            <input
              className="text-input"
              placeholder="report-service"
              value={clientIdInput}
              onChange={(event) => setClientIdInput(event.target.value)}
            />
          </label>
          <label className="feishu-settings-label">
            <span>client_secret</span>
            <input
              className="text-input"
              type="password"
              placeholder="请输入鉴权 client_secret"
              value={clientSecretInput}
              onChange={(event) => setClientSecretInput(event.target.value)}
            />
          </label>
        </div>

        <div className="section-head align-start feishu-settings-preview-head">
          <div>
            <h2>鉴权结果</h2>
            <p>这里展示服务器最近一次成功鉴权后保存的 token 数据。点击“立即鉴权”前，请先保存服务地址、`client_id` 和 `client_secret`。</p>
          </div>
          <div className="hotfix-settings-actions">
            <button className="secondary-button" type="button" onClick={() => void handleRefreshAuthToken()} disabled={busy}>
              {busy ? '处理中…' : '立即鉴权'}
            </button>
            <button className="primary-button" type="button" onClick={() => void handleSaveSettings()} disabled={busy}>
              保存配置
            </button>
          </div>
        </div>

        {savedSettings?.auth ? (
          <div className="hotfix-token-panel">
            <div className="hotfix-token-grid">
              <div className="feishu-member-preview-item">
                <strong>client_id</strong>
                <span>{savedSettings.auth.clientId}</span>
              </div>
              <div className="feishu-member-preview-item">
                <strong>token_type</strong>
                <span>{savedSettings.auth.tokenType}</span>
              </div>
              <div className="feishu-member-preview-item">
                <strong>expires_in</strong>
                <span>{savedSettings.auth.expiresIn}s</span>
              </div>
              <div className="feishu-member-preview-item">
                <strong>issued_at</strong>
                <span>{savedSettings.auth.issuedAt}</span>
              </div>
              <div className="feishu-member-preview-item">
                <strong>expires_at</strong>
                <span>{savedSettings.auth.expiresAt}</span>
              </div>
              <div className="feishu-member-preview-item">
                <strong>trace_id</strong>
                <span>{savedSettings.auth.traceId ?? '无'}</span>
              </div>
            </div>

            <label className="feishu-settings-label">
              <span>access_token</span>
              <textarea
                className="composer-input feishu-settings-textarea hotfix-token-textarea"
                readOnly
                value={savedSettings.auth.accessToken}
              />
            </label>
          </div>
        ) : (
          <div className="empty-state">服务器当前还没有保存成功的热更 service token，点击“立即鉴权”后会写入这里。</div>
        )}
      </section>
    </AppShell>
  );
}


function FileCleanupPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<StoredFileItem[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [missingCount, setMissingCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [storageRootPath, setStorageRootPath] = useState('');
  const [cleanupPasswordInput, setCleanupPasswordInput] = useState(() => readStoredCleanupPassword());
  const [cleanupAuthorized, setCleanupAuthorized] = useState(() => Boolean(readStoredCleanupPassword().trim()));
  const [openingFolderId, setOpeningFolderId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  useAutoDismissMessage(error, setError);
  useAutoDismissMessage(success, setSuccess);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected = items.length > 0 && items.every((item) => selectedIdSet.has(item.messageId));
  const selectedSize = useMemo(
    () => items.reduce((sum, item) => sum + (selectedIdSet.has(item.messageId) ? item.fileSize : 0), 0),
    [items, selectedIdSet],
  );

  function handleCleanupUnauthorized() {
    clearStoredCleanupPassword();
    setCleanupAuthorized(false);
    setCleanupPasswordInput('');
    setItems([]);
    setSelectedIds([]);
    setStorageRootPath('');
    setPreview(null);
  }

  async function loadFiles(adminPassword = cleanupPasswordInput.trim()): Promise<boolean> {
    if (!adminPassword) {
      setLoading(false);
      setCleanupAuthorized(false);
      return false;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await getServerFiles(adminPassword);
      setItems(response.items);
      setTotalSize(response.totalSize);
      setMissingCount(response.missingCount);
      setStorageRootPath(response.storageRootPath);
      setSelectedIds((current) => current.filter((messageId) => response.items.some((item) => item.messageId === messageId)));
      storeCleanupPassword(adminPassword);
      setCleanupPasswordInput(adminPassword);
      setCleanupAuthorized(true);
      return true;
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleCleanupUnauthorized();
        setError('管理员密码错误，请重新输入');
      } else {
        setError(requestError instanceof Error ? requestError.message : '加载服务器文件失败');
      }
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const storedPassword = readStoredCleanupPassword().trim();
    if (!storedPassword) {
      setLoading(false);
      return;
    }

    void loadFiles(storedPassword);
  }, []);

  function toggleItem(messageId: number) {
    setSelectedIds((current) =>
      current.includes(messageId) ? current.filter((item) => item !== messageId) : [...current, messageId],
    );
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? [] : items.map((item) => item.messageId));
  }

  async function handleUnlockCleanupPage() {
    const adminPassword = cleanupPasswordInput.trim();
    if (!adminPassword) {
      setError('请输入管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const unlocked = await loadFiles(adminPassword);
      if (unlocked) {
        setSuccess('管理员密码验证成功');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenFolder(item: StoredFileItem) {
    setOpeningFolderId(item.messageId);
    setError(null);
    setSuccess(null);

    try {
      const result = await openServerFileFolder(item.messageId, cleanupPasswordInput.trim());
      setSuccess(`已尝试在服务器上打开目录：${result.folderPath}`);
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleCleanupUnauthorized();
      }
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '打开服务器文件夹失败');
    } finally {
      setOpeningFolderId(null);
    }
  }

  async function handleDeleteSelected() {
    if (selectedIds.length === 0) {
      setError('请先勾选要删除的文件');
      return;
    }

    const confirmed = window.confirm(
      `确认删除已勾选的 ${selectedIds.length} 个文件吗？删除后，对应聊天中的附件会显示为“已被服务器清理”，无法再下载。`,
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await deleteServerFiles(selectedIds, cleanupPasswordInput.trim());
      setPreview(null);
      setSuccess(
        `已清理 ${result.cleanedCount} 个文件，释放 ${formatFileSize(result.cleanedSize)}${
          result.skippedCount > 0 ? `，跳过 ${result.skippedCount} 个无效项` : ''
        }`,
      );
      await loadFiles(cleanupPasswordInput.trim());
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleCleanupUnauthorized();
      }
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '删除服务器文件失败');
    } finally {
      setBusy(false);
    }
  }

  if (!cleanupAuthorized) {
    return (
      <AppShell>
        <FloatingFeedbackToasts error={error} success={success} />
        <header className="hero-card cleanup-hero">
          <div>
            <div className="eyebrow">SERVER FILES</div>
            <h1>服务器文件清理</h1>
            <p>进入清理页前，请先输入管理员密码。</p>
          </div>
        </header>

        <section className="panel-card home-action-card cleanup-auth-card">
          <div className="home-action-copy">
            <h2>管理员验证</h2>
            <p>管理员密码固定为你设置的清理页口令，验证通过后才可查看和删除服务器附件。</p>
          </div>


          <div className="stack-gap home-action-form">
            <input
              className="text-input"
              type="password"
              placeholder="请输入管理员密码"
              value={cleanupPasswordInput}
              onChange={(event) => setCleanupPasswordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleUnlockCleanupPage();
                }
              }}
            />
            <div className="cleanup-auth-actions">
              <button className="secondary-button" type="button" onClick={() => navigate('/')} disabled={busy}>
                返回主页
              </button>
              <button className="primary-button" type="button" onClick={() => void handleUnlockCleanupPage()} disabled={busy}>
                验证并进入
              </button>
            </div>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <FloatingFeedbackToasts error={error} success={success} />
      <header className="hero-card cleanup-hero">
        <div>
          <div className="eyebrow">SERVER FILES</div>
          <h1>服务器文件清理</h1>
          <p>这里只展示服务器当前仍保留在磁盘上的聊天附件，支持批量删除以释放存储空间。</p>
        </div>
        <div className="status-grid">
          <div className="status-chip">
            <span>当前文件数</span>
            <strong>{loading ? '--' : items.length}</strong>
          </div>
          <div className="status-chip">
            <span>占用空间</span>
            <strong>{loading ? '--' : formatFileSize(totalSize)}</strong>
          </div>
          <div className="status-chip">
            <span>缺失记录</span>
            <strong>{loading ? '--' : missingCount}</strong>
          </div>
        </div>
      </header>

      <section className="panel-card cleanup-panel">
        <div className="section-head cleanup-section-head">
          <div>
            <h2>已接收文件列表</h2>
            <p>删除后会同步让聊天中的对应附件不可下载；图片也无法再预览。</p>
            <div className="cleanup-room-meta">当前上传目录：{storageRootPath || '加载中…'}</div>
          </div>
          <div className="cleanup-header-actions">
            <button className="secondary-button" type="button" onClick={() => navigate('/')}>
              返回主页
            </button>
            <button className="secondary-button" type="button" onClick={() => void loadFiles()} disabled={loading || busy}>
              刷新
            </button>
          </div>
        </div>


        <div className="cleanup-toolbar">
          <button className="secondary-button" type="button" onClick={toggleSelectAll} disabled={loading || busy || items.length === 0}>
            {allSelected ? '取消全选' : '全选'}
          </button>
          <div className="cleanup-selection-meta">
            已选 {selectedIds.length} 项 · {formatFileSize(selectedSize)}
          </div>
          <button className="danger-button" type="button" onClick={() => void handleDeleteSelected()} disabled={loading || busy || selectedIds.length === 0}>
            删除已选
          </button>
        </div>

        {loading ? <div className="empty-state">正在加载服务器文件…</div> : null}
        {!loading && items.length === 0 ? <div className="empty-state">服务器当前没有可清理的聊天附件。</div> : null}

        {!loading && items.length > 0 ? (
          <div className="cleanup-list">
            {items.map((item) => {
              const checked = selectedIdSet.has(item.messageId);
              return (
                <div key={item.messageId} className={`cleanup-item ${checked ? 'cleanup-item-selected' : ''}`}>
                  <input
                    className="cleanup-checkbox"
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleItem(item.messageId)}
                    aria-label={`勾选 ${item.fileName}`}
                  />
                  <div className="cleanup-item-main">
                    <div className="cleanup-item-head">
                      <div className="cleanup-title-block">
                        <strong className="cleanup-file-name">{item.fileName}</strong>
                        <div className="cleanup-file-meta">
                          {item.type === 'image' ? '图片' : '文件'} · {item.fileMime} · {formatFileSize(item.fileSize)}
                        </div>
                      </div>
                      <span className="role-badge">{item.type === 'image' ? '图片' : '文件'}</span>
                    </div>

                    <div className="cleanup-room-meta">
                      房间主题：{getDisplayRoomName(item.roomName, item.roomId)}
                    </div>
                    <div className="cleanup-room-meta">
                      房间号：{item.roomId} · 发送者：{item.senderNickname}（{item.senderIp}） · 时间：{formatDateTime(item.createdAt)}
                    </div>

                    <div className="cleanup-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void handleOpenFolder(item)}
                        disabled={busy || loading || openingFolderId === item.messageId}
                      >
                        {openingFolderId === item.messageId ? '打开中…' : '打开文件夹'}
                      </button>
                      {item.previewUrl ? (
                        <button className="secondary-button" type="button" onClick={() => setPreview(toStoredFilePreview(item))}>
                          预览
                        </button>
                      ) : null}
                      <a className="secondary-button as-link-button" href={item.downloadUrl} download={item.fileName}>
                        下载
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <AttachmentPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </AppShell>
  );
}

function RoomManagementPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ManagedRoomItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'dissolved'>('all');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actingRoomId, setActingRoomId] = useState<string | null>(null);
  const [roomManagementPasswordInput, setRoomManagementPasswordInput] = useState(() => readStoredCleanupPassword());
  const [roomManagementAuthorized, setRoomManagementAuthorized] = useState(() => Boolean(readStoredCleanupPassword().trim()));
  const [restoreClock, setRestoreClock] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  useAutoDismissMessage(error, setError);
  useAutoDismissMessage(success, setSuccess);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const activeCount = useMemo(() => items.filter((item) => item.status === 'active').length, [items]);
  const dissolvedCount = items.length - activeCount;

  useEffect(() => {
    const timer = window.setInterval(() => setRestoreClock(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  function handleRoomManagementUnauthorized() {
    clearStoredCleanupPassword();
    setRoomManagementAuthorized(false);
    setRoomManagementPasswordInput('');
    setItems([]);
    setSelectedIds([]);
  }

  async function loadManagedRooms(adminPassword = roomManagementPasswordInput.trim()): Promise<boolean> {
    if (!adminPassword) {
      setLoading(false);
      setRoomManagementAuthorized(false);
      return false;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await getManagedRooms(adminPassword);
      setItems(response.items);
      setSelectedIds((current) =>
        current.filter((roomId) => response.items.some((item) => item.roomId === roomId && item.status === 'active')),
      );
      storeCleanupPassword(adminPassword);
      setRoomManagementPasswordInput(adminPassword);
      setRoomManagementAuthorized(true);
      return true;
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleRoomManagementUnauthorized();
        setError('管理员密码错误，请重新输入');
      } else {
        setError(requestError instanceof Error ? requestError.message : '加载房间管理列表失败');
      }
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const storedPassword = readStoredCleanupPassword().trim();
    if (!storedPassword) {
      setLoading(false);
      return;
    }

    void loadManagedRooms(storedPassword);
  }, []);

  const visibleItems = useMemo(() => {
    const keyword = searchInput.trim().toLowerCase();
    const filteredItems = items.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) {
        return false;
      }

      if (!keyword) {
        return true;
      }

      const roomName = getDisplayRoomName(item.roomName, item.roomId).toLowerCase();
      return roomName.includes(keyword) || item.roomId.toLowerCase().includes(keyword) || item.ownerIp.toLowerCase().includes(keyword);
    });

    return filteredItems.sort((left, right) => {
      const createdDiff = toTimestamp(right.createdAt) - toTimestamp(left.createdAt);
      if (createdDiff !== 0) {
        return createdDiff;
      }

      return right.roomId.localeCompare(left.roomId);
    });
  }, [items, searchInput, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(visibleItems.length / ROOMS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedItems = useMemo(() => {
    const startIndex = (currentPage - 1) * ROOMS_PAGE_SIZE;
    return visibleItems.slice(startIndex, startIndex + ROOMS_PAGE_SIZE);
  }, [currentPage, visibleItems]);

  const currentPageSelectableIds = useMemo(
    () => pagedItems.filter((item) => item.status === 'active').map((item) => item.roomId),
    [pagedItems],
  );
  const allSelected = currentPageSelectableIds.length > 0 && currentPageSelectableIds.every((roomId) => selectedIdSet.has(roomId));

  useEffect(() => {
    setPage(1);
  }, [searchInput, statusFilter]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  function toggleItem(roomId: string) {
    setSelectedIds((current) =>
      current.includes(roomId) ? current.filter((item) => item !== roomId) : [...current, roomId],
    );
  }

  function toggleSelectAll() {
    if (currentPageSelectableIds.length === 0) {
      return;
    }

    setSelectedIds((current) => {
      const next = new Set(current);
      const shouldClear = currentPageSelectableIds.every((roomId) => next.has(roomId));
      if (shouldClear) {
        currentPageSelectableIds.forEach((roomId) => next.delete(roomId));
      } else {
        currentPageSelectableIds.forEach((roomId) => next.add(roomId));
      }
      return Array.from(next);
    });
  }

  async function handleUnlockRoomManagementPage() {
    const adminPassword = roomManagementPasswordInput.trim();
    if (!adminPassword) {
      setError('请输入管理员密码');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const unlocked = await loadManagedRooms(adminPassword);
      if (unlocked) {
        setSuccess('管理员密码验证成功');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDissolveRooms(roomIds: string[]) {
    if (roomIds.length === 0) {
      setError('请先勾选要解散的房间');
      return;
    }

    const confirmed = window.confirm(
      roomIds.length === 1
        ? `确认解散房间 ${roomIds[0]} 吗？解散后原成员会暂时无法进入，24 小时内仍可恢复。`
        : `确认解散已勾选的 ${roomIds.length} 个房间吗？解散后原成员会暂时无法进入，24 小时内仍可恢复。`,
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    setActingRoomId(roomIds.length === 1 ? roomIds[0] : null);
    try {
      const result = await dissolveManagedRooms(roomIds, roomManagementPasswordInput.trim());
      setSelectedIds((current) => current.filter((roomId) => !roomIds.includes(roomId)));
      setSuccess(`已解散 ${result.dissolvedCount} 个房间${result.skippedCount > 0 ? `，跳过 ${result.skippedCount} 个无效项` : ''}`);
      await loadManagedRooms(roomManagementPasswordInput.trim());
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleRoomManagementUnauthorized();
      }
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '解散房间失败');
    } finally {
      setBusy(false);
      setActingRoomId(null);
    }
  }

  async function handleRestoreRoom(room: ManagedRoomItem) {
    if (!canRestoreManagedRoom(room, restoreClock)) {
      setError('该房间已超过 24 小时恢复期，无法恢复');
      return;
    }

    const confirmed = window.confirm(`确认恢复房间 ${room.roomId} 吗？恢复后原成员可再次进入。`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setActingRoomId(room.roomId);
    setError(null);
    setSuccess(null);
    try {
      await restoreManagedRoom(room.roomId, roomManagementPasswordInput.trim());
      setSuccess(`房间 ${room.roomId} 已恢复`);
      await loadManagedRooms(roomManagementPasswordInput.trim());
    } catch (requestError) {
      const status = getRequestErrorStatus(requestError);
      if (status === 401) {
        handleRoomManagementUnauthorized();
      }
      setError(status === 401 ? '管理员密码错误，请重新输入' : requestError instanceof Error ? requestError.message : '恢复房间失败');
    } finally {
      setBusy(false);
      setActingRoomId(null);
    }
  }

  if (!roomManagementAuthorized) {
    return (
      <AppShell>
        <FloatingFeedbackToasts error={error} success={success} />
        <header className="hero-card cleanup-hero">
          <div>
            <div className="eyebrow">ROOM MANAGE</div>
            <h1>房间管理</h1>
            <p>进入管理页前，请先输入管理员密码。</p>
          </div>
        </header>

        <section className="panel-card home-action-card cleanup-auth-card">
          <div className="home-action-copy">
            <h2>管理员验证</h2>
            <p>房间管理与服务器文件清理共用同一管理员密码，验证通过后才可查看、解散和恢复房间。</p>
          </div>

          <div className="stack-gap home-action-form">
            <input
              className="text-input"
              type="password"
              placeholder="请输入管理员密码"
              value={roomManagementPasswordInput}
              onChange={(event) => setRoomManagementPasswordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleUnlockRoomManagementPage();
                }
              }}
            />
            <div className="cleanup-auth-actions">
              <button className="secondary-button" type="button" onClick={() => navigate('/')} disabled={busy}>
                返回主页
              </button>
              <button className="primary-button" type="button" onClick={() => void handleUnlockRoomManagementPage()} disabled={busy}>
                验证并进入
              </button>
            </div>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <FloatingFeedbackToasts error={error} success={success} />
      <header className="hero-card cleanup-hero">
        <div>
          <div className="eyebrow">ROOM MANAGE</div>
          <h1>房间管理</h1>
          <p>这里展示所有创建过的房间，支持搜索、筛选、分页查看，以及批量解散和 24 小时内恢复。</p>
        </div>
        <div className="status-grid">
          <div className="status-chip">
            <span>房间总数</span>
            <strong>{loading ? '--' : items.length}</strong>
          </div>
          <div className="status-chip">
            <span>未解散</span>
            <strong>{loading ? '--' : activeCount}</strong>
          </div>
          <div className="status-chip">
            <span>已解散</span>
            <strong>{loading ? '--' : dissolvedCount}</strong>
          </div>
        </div>
      </header>

      <section className="panel-card cleanup-panel">
        <div className="section-head cleanup-section-head">
          <div>
            <h2>房间列表</h2>
            <p>按创建时间倒序展示，每页 10 个房间；已解散房间会保留在列表中，并在恢复期内支持恢复。</p>
            <div className="cleanup-room-meta">当前筛选结果：{loading ? '--' : visibleItems.length} 个房间</div>
          </div>
          <div className="cleanup-header-actions">
            <button className="secondary-button" type="button" onClick={() => navigate('/')}>
              返回主页
            </button>
            <button className="secondary-button" type="button" onClick={() => void loadManagedRooms()} disabled={loading || busy}>
              刷新
            </button>
          </div>
        </div>

        <div className="cleanup-toolbar room-manage-toolbar">
          <input
            className="text-input room-manage-search-input"
            placeholder="搜索房间主题、房间号或群主 IP"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <div className="room-manage-filter-group" role="tablist" aria-label="房间状态筛选">
            <button
              className={`secondary-button room-manage-filter-button ${statusFilter === 'all' ? 'room-manage-filter-button-active' : ''}`}
              type="button"
              onClick={() => setStatusFilter('all')}
            >
              全部
            </button>
            <button
              className={`secondary-button room-manage-filter-button ${statusFilter === 'active' ? 'room-manage-filter-button-active' : ''}`}
              type="button"
              onClick={() => setStatusFilter('active')}
            >
              未解散
            </button>
            <button
              className={`secondary-button room-manage-filter-button ${statusFilter === 'dissolved' ? 'room-manage-filter-button-active' : ''}`}
              type="button"
              onClick={() => setStatusFilter('dissolved')}
            >
              已解散
            </button>
          </div>
        </div>

        <div className="cleanup-toolbar">
          <button className="secondary-button" type="button" onClick={toggleSelectAll} disabled={loading || busy || currentPageSelectableIds.length === 0}>
            {allSelected ? '取消全选' : '全选本页'}
          </button>
          <div className="cleanup-selection-meta">
            已选 {selectedIds.length} 个房间 · 当前第 {currentPage} / {totalPages} 页
          </div>
          <button className="danger-button" type="button" onClick={() => void handleDissolveRooms(selectedIds)} disabled={loading || busy || selectedIds.length === 0}>
            解散已选
          </button>
        </div>

        {loading ? <div className="empty-state">正在加载房间列表…</div> : null}
        {!loading && items.length === 0 ? <div className="empty-state">当前还没有任何房间记录。</div> : null}
        {!loading && items.length > 0 && visibleItems.length === 0 ? <div className="empty-state">没有找到匹配的房间。</div> : null}

        {!loading && visibleItems.length > 0 ? (
          <>
            <div className="cleanup-list">
              {pagedItems.map((room) => {
                const checked = selectedIdSet.has(room.roomId);
                const canRestore = canRestoreManagedRoom(room, restoreClock);
                const isActing = actingRoomId === room.roomId;

                return (
                  <div key={room.roomId} className={`cleanup-item ${checked ? 'cleanup-item-selected' : ''}`}>
                    <input
                      className="cleanup-checkbox"
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleItem(room.roomId)}
                      disabled={room.status !== 'active' || busy}
                      aria-label={`勾选 ${room.roomId}`}
                    />
                    <div className="cleanup-item-main">
                      <div className="cleanup-item-head">
                        <div className="cleanup-title-block">
                          <strong className="cleanup-file-name">房间主题：{getDisplayRoomName(room.roomName, room.roomId)}</strong>
                          <div className="cleanup-file-meta">房间号：{room.roomId} · 群主 IP：{room.ownerIp}</div>
                        </div>
                        <span
                          className={`room-manage-status-badge ${room.status === 'active' ? 'room-manage-status-active' : 'room-manage-status-dissolved'}`}
                        >
                          {room.status === 'active' ? '未解散' : '已解散'}
                        </span>
                      </div>

                      <div className="cleanup-room-meta">在线成员/成员总数：{formatRoomOnlineMemberSummary(room)} · 创建时间：{formatDateTime(room.createdAt)}</div>
                      {room.dissolvedAt ? (
                        <div className="cleanup-room-meta">
                          解散时间：{formatDateTime(room.dissolvedAt)}
                          {room.restoreExpiresAt ? ` · 恢复截止：${formatDateTime(room.restoreExpiresAt)}` : ''}
                        </div>
                      ) : null}
                      {room.status === 'dissolved' ? (
                        <div className={`cleanup-room-meta ${canRestore ? 'room-manage-restore-meta' : 'room-manage-restore-meta room-manage-restore-meta-expired'}`}>
                          {canRestore ? '处于 24 小时恢复期内，可直接恢复。' : '已超过 24 小时恢复期，无法恢复。'}
                        </div>
                      ) : null}

                      <div className="cleanup-actions">
                        {room.status === 'active' ? (
                          <button
                            className="danger-button"
                            type="button"
                            onClick={() => void handleDissolveRooms([room.roomId])}
                            disabled={busy}
                          >
                            {isActing ? '解散中…' : '解散'}
                          </button>
                        ) : (
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => void handleRestoreRoom(room)}
                            disabled={busy || !canRestore}
                            title={canRestore ? '恢复房间' : '该房间已超过 24 小时恢复期'}
                          >
                            {isActing ? '恢复中…' : '恢复'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {visibleItems.length > ROOMS_PAGE_SIZE ? (
              <div className="room-pagination">
                <button
                  className="secondary-button room-page-button"
                  type="button"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={currentPage <= 1 || loading || busy}
                >
                  上一页
                </button>
                <div className="room-pagination-meta">第 {currentPage} / {totalPages} 页</div>
                <button
                  className="secondary-button room-page-button"
                  type="button"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={currentPage >= totalPages || loading || busy}
                >
                  下一页
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </AppShell>
  );
}


function RoomPage() {
  const navigate = useNavigate();
  const params = useParams();
  const roomId = (params.roomId ?? '').toUpperCase();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState('');
  const [resendDraftSource, setResendDraftSource] = useState<ChatMessage | null>(null);
  const [replyDraftMessageId, setReplyDraftMessageId] = useState<number | null>(null);
  const [hiddenMessageIds, setHiddenMessageIds] = useState<number[]>([]);
  const [hiddenMessageStorageScope, setHiddenMessageStorageScope] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useAutoDismissMessage(error, setError);
  useAutoDismissMessage(success, setSuccess);
  const [sending, setSending] = useState(false);
  const [fetchingHotfixContent, setFetchingHotfixContent] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);
  const [recallClock, setRecallClock] = useState(Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [membersExpanded, setMembersExpanded] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [showMentionJump, setShowMentionJump] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [taskActionKeys, setTaskActionKeys] = useState<string[]>([]);
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);
  const [activeMentionQuery, setActiveMentionQuery] = useState<ActiveMentionQuery | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [lastSeenMessageId, setLastSeenMessageId] = useState<number | null>(null);
  const [unreadMentionCount, setUnreadMentionCount] = useState(0);
  const [latestUnreadMentionId, setLatestUnreadMentionId] = useState<number | null>(null);
  const [latestUnreadMentionAt, setLatestUnreadMentionAt] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const dragDepthRef = useRef(0);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const uploadQueueRef = useRef<string[]>([]);
  const uploadWorkerActiveRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const initialScrollHandledRef = useRef(false);
  const lastSeenMessageIdRef = useRef<number | null>(null);
  const lastRequestedReadMessageIdRef = useRef<number | null>(null);
  const latestUnreadMentionIdRef = useRef<number | null>(null);
  const copiedMessageResetTimerRef = useRef<number | null>(null);
  const copiedRoomIdResetTimerRef = useRef<number | null>(null);
  const highlightedMessageResetTimerRef = useRef<number | null>(null);
  const meRef = useRef<MeResponse | null>(null);
  const loadingOlderMessagesRef = useRef(false);
  const [copiedMessageId, setCopiedMessageId] = useState<number | null>(null);
  const [roomIdCopied, setRoomIdCopied] = useState(false);
  const [onlineMemberIps, setOnlineMemberIps] = useState<string[]>([]);
  const [taskNotifyConfig, setTaskNotifyConfig] = useState<FeishuBotPublicConfig | null>(null);
  const [taskNotifyModal, setTaskNotifyModal] = useState<TaskNotifyModalState | null>(null);
  const [hotfixPickerModal, setHotfixPickerModal] = useState<HotfixVersionPickerModalState | null>(null);
  const [packageDistributionModal, setPackageDistributionModal] = useState<PackageDistributionModalState | null>(null);
  const [adbInstallModal, setAdbInstallModal] = useState<AdbInstallModalState | null>(null);
  const [processingHotfixSelection, setProcessingHotfixSelection] = useState(false);
  const [fetchingPackageDistributionPreview, setFetchingPackageDistributionPreview] = useState(false);
  const [sendingPackageDistributionTask, setSendingPackageDistributionTask] = useState(false);
  const [openingAdbInstallPackageUrl, setOpeningAdbInstallPackageUrl] = useState<string | null>(null);
  const [joinedRooms, setJoinedRooms] = useState<RoomListItem[]>([]);
  const [roomStripDragging, setRoomStripDragging] = useState(false);
  const roomStripRef = useRef<HTMLDivElement | null>(null);
  const roomStripDragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number; moved: boolean } | null>(null);
  const roomStripSuppressClickRef = useRef(false);
  const roomStripSuppressTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedMessageResetTimerRef.current) {
        window.clearTimeout(copiedMessageResetTimerRef.current);
      }
      if (copiedRoomIdResetTimerRef.current) {
        window.clearTimeout(copiedRoomIdResetTimerRef.current);
      }
      if (highlightedMessageResetTimerRef.current) {
        window.clearTimeout(highlightedMessageResetTimerRef.current);
      }
      if (roomStripSuppressTimerRef.current) {
        window.clearTimeout(roomStripSuppressTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!roomId) {
      navigate('/');
    }
  }, [navigate, roomId]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    initialScrollHandledRef.current = false;
    setShowScrollToLatest(false);
    setShowMentionJump(false);
    setLastSeenMessageId(null);
    setUnreadMentionCount(0);
    setLatestUnreadMentionId(null);
    setLatestUnreadMentionAt(null);
    setCopiedMessageId(null);
    setRoomIdCopied(false);
    setOnlineMemberIps([]);
    setComposerExpanded(false);
    setTaskActionKeys([]);
    setTaskNotifyConfig(null);
    setTaskNotifyModal(null);
    setHotfixPickerModal(null);
    setPackageDistributionModal(null);
    setAdbInstallModal(null);
    setProcessingHotfixSelection(false);
    setFetchingPackageDistributionPreview(false);
    setSendingPackageDistributionTask(false);
    setOpeningAdbInstallPackageUrl(null);
    setJoinedRooms([]);
    setRoomStripDragging(false);
    setReplyDraftMessageId(null);
    setHiddenMessageIds([]);
    setHiddenMessageStorageScope(null);
    setHighlightedMessageId(null);
    lastSeenMessageIdRef.current = null;
    lastRequestedReadMessageIdRef.current = null;
    loadingOlderMessagesRef.current = false;
    if (copiedMessageResetTimerRef.current) {
      window.clearTimeout(copiedMessageResetTimerRef.current);
      copiedMessageResetTimerRef.current = null;
    }
    if (copiedRoomIdResetTimerRef.current) {
      window.clearTimeout(copiedRoomIdResetTimerRef.current);
      copiedRoomIdResetTimerRef.current = null;
    }
    if (highlightedMessageResetTimerRef.current) {
      window.clearTimeout(highlightedMessageResetTimerRef.current);
      highlightedMessageResetTimerRef.current = null;
    }
    if (roomStripSuppressTimerRef.current) {
      window.clearTimeout(roomStripSuppressTimerRef.current);
      roomStripSuppressTimerRef.current = null;
    }
    roomStripDragRef.current = null;
    roomStripSuppressClickRef.current = false;
  }, [roomId]);

  useEffect(() => {
    lastSeenMessageIdRef.current = lastSeenMessageId;
  }, [lastSeenMessageId]);

  useEffect(() => {
    latestUnreadMentionIdRef.current = latestUnreadMentionId;
  }, [latestUnreadMentionId]);

  useEffect(() => {
    meRef.current = me;
  }, [me]);

  const hiddenMessageScopeKey = useMemo(
    () => (me?.ip ? buildHiddenMessagesScopeKey(me.ip, roomId) : null),
    [me?.ip, roomId],
  );

  useEffect(() => {
    if (!me?.ip || !roomId || !hiddenMessageScopeKey) {
      setHiddenMessageIds([]);
      setHiddenMessageStorageScope(null);
      return;
    }

    setHiddenMessageIds(readHiddenMessageIds(me.ip, roomId));
    setHiddenMessageStorageScope(hiddenMessageScopeKey);
  }, [hiddenMessageScopeKey, me?.ip, roomId]);

  useEffect(() => {
    if (!me?.ip || !roomId || !hiddenMessageScopeKey || hiddenMessageStorageScope !== hiddenMessageScopeKey) {
      return;
    }

    storeHiddenMessageIds(me.ip, roomId, hiddenMessageIds);
  }, [hiddenMessageIds, hiddenMessageScopeKey, hiddenMessageStorageScope, me?.ip, roomId]);

  function applyRoomReadState(state: RoomReadState) {
    setLastSeenMessageId(state.lastSeenMessageId);
    setUnreadMentionCount(state.unreadMentionCount);
    setLatestUnreadMentionId(state.latestUnreadMentionId);
    setLatestUnreadMentionAt(state.latestUnreadMentionAt);
    lastSeenMessageIdRef.current = state.lastSeenMessageId;
    lastRequestedReadMessageIdRef.current = state.lastSeenMessageId;
    setRoom((current) => (current ? { ...current, ...state } : current));
  }

  async function refreshRoomReadState() {
    const roomResponse = await getRoom(roomId);
    setRoom(roomResponse);
    applyRoomReadState(roomResponse);
  }

  async function refreshRoomPresence() {
    const presence = await getRoomPresence(roomId);
    setOnlineMemberIps(presence.onlineMemberIps);
  }

  function getVisibleMessageIds(): number[] {
    const container = scrollRef.current;
    if (!container) {
      return [];
    }

    const containerRect = container.getBoundingClientRect();
    const elements = Array.from(container.querySelectorAll<HTMLElement>('.message-row[data-message-id]'));
    return elements.flatMap((element) => {
      const rawId = element.dataset.messageId;
      const messageId = rawId ? Number(rawId) : NaN;
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return [];
      }

      const rect = element.getBoundingClientRect();
      const visibleHeight = Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top);
      const minimumVisibleHeight = Math.min(40, rect.height * 0.35);
      return visibleHeight >= minimumVisibleHeight ? [messageId] : [];
    });
  }

  async function syncVisibleMessagesRead(visibleMessageIds?: number[]) {
    const ids = visibleMessageIds ?? getVisibleMessageIds();
    if (ids.length === 0) {
      return;
    }

    const highestVisibleMessageId = Math.max(...ids);
    const currentLastSeenMessageId = lastSeenMessageIdRef.current ?? 0;
    const lastRequestedReadMessageId = lastRequestedReadMessageIdRef.current ?? 0;
    if (highestVisibleMessageId <= currentLastSeenMessageId || highestVisibleMessageId <= lastRequestedReadMessageId) {
      return;
    }

    lastRequestedReadMessageIdRef.current = highestVisibleMessageId;
    lastSeenMessageIdRef.current = highestVisibleMessageId;
    setLastSeenMessageId(highestVisibleMessageId);
    setRoom((current) => (current ? { ...current, lastSeenMessageId: highestVisibleMessageId } : current));

    try {
      const nextState = await markRoomRead(roomId, highestVisibleMessageId);
      applyRoomReadState(nextState);
    } catch {
      lastRequestedReadMessageIdRef.current = lastSeenMessageIdRef.current;
    }
  }

  function updateMentionJumpVisibility(visibleMessageIds?: number[]) {
    if (!latestUnreadMentionId || unreadMentionCount <= 0) {
      setShowMentionJump(false);
      return;
    }

    const ids = visibleMessageIds ?? getVisibleMessageIds();
    setShowMentionJump(!ids.includes(latestUnreadMentionId));
  }

  function updateMessageListScrollState() {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const nearBottom = isMessageListNearBottom(container);
    shouldStickToBottomRef.current = nearBottom;
    setShowScrollToLatest(!nearBottom);

    const visibleMessageIds = getVisibleMessageIds();
    updateMentionJumpVisibility(visibleMessageIds);
    void syncVisibleMessagesRead(visibleMessageIds);
  }

  function scrollMessageListToLatest(behavior: ScrollBehavior = 'smooth') {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    container.scrollTo({ top: container.scrollHeight, behavior });
    shouldStickToBottomRef.current = true;
    setShowScrollToLatest(false);
    window.requestAnimationFrame(() => updateMessageListScrollState());
  }

  async function ensureMessageLoaded(targetMessageId: number): Promise<boolean> {
    if (messages.some((message) => message.id === targetMessageId)) {
      return true;
    }

    const oldestLoadedMessageId = messages[0]?.id;
    if (!oldestLoadedMessageId || loadingOlderMessagesRef.current) {
      return false;
    }

    loadingOlderMessagesRef.current = true;
    try {
      let mergedMessages = [...messages];
      let cursor: number | null = oldestLoadedMessageId;
      while (cursor && !mergedMessages.some((message) => message.id === targetMessageId)) {
        const page = await getMessages(roomId, cursor);
        if (page.items.length === 0) {
          break;
        }

        mergedMessages = mergeMessagesById(mergedMessages, page.items);
        setMessages((current) => mergeMessagesById(current, page.items));
        cursor = page.nextCursor;
      }

      return mergedMessages.some((message) => message.id === targetMessageId);
    } finally {
      loadingOlderMessagesRef.current = false;
    }
  }

  function highlightMessage(messageId: number) {
    setHighlightedMessageId(messageId);
    if (highlightedMessageResetTimerRef.current) {
      window.clearTimeout(highlightedMessageResetTimerRef.current);
    }
    highlightedMessageResetTimerRef.current = window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === messageId ? null : current));
      highlightedMessageResetTimerRef.current = null;
    }, 1800);
  }

  async function jumpToMessage(targetMessageId: number, errorMessage: string) {
    const loaded = await ensureMessageLoaded(targetMessageId);
    if (!loaded) {
      setError(errorMessage);
      return;
    }

    window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      const element = container?.querySelector<HTMLElement>(`.message-row[data-message-id="${targetMessageId}"]`);
      if (!element) {
        setError(errorMessage);
        return;
      }

      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightMessage(targetMessageId);
      window.setTimeout(() => updateMessageListScrollState(), 220);
    });
  }

  async function jumpToUnreadMention() {
    const targetMessageId = latestUnreadMentionId;
    if (!targetMessageId) {
      return;
    }

    await jumpToMessage(targetMessageId, '暂时无法定位这条 @ 消息，请稍后重试');
  }

  useEffect(() => {
    let cancelled = false;

    async function loadRoomPage() {
      setLoading(true);
      setError(null);
      try {
        const [meResponse, roomResponse, messageResponse, presenceResponse, taskNotifyConfigResponse, myRoomsResponse] = await Promise.all([
          getMe(),
          getRoom(roomId),
          getMessages(roomId),
          getRoomPresence(roomId),
          getTaskNotifyConfig(roomId),
          getMyRooms(),
        ]);
        if (cancelled) {
          return;
        }
        setMe(meResponse);
        setRoom(roomResponse);
        applyRoomReadState(roomResponse);
        setMessages(messageResponse.items);
        setOnlineMemberIps(presenceResponse.onlineMemberIps);
        setTaskNotifyConfig(taskNotifyConfigResponse);
        setJoinedRooms(myRoomsResponse);
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : '加载群组失败');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadRoomPage();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  useEffect(() => {
    if (room?.roomId) {
      markRoomVisited(room.roomId);
    }
  }, [room?.roomId]);

  useEffect(() => {
    if (!roomId) {
      return;
    }

    let cancelled = false;

    const refreshTaskNotifyConfig = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }

      void getTaskNotifyConfig(roomId)
        .then((response) => {
          if (!cancelled) {
            setTaskNotifyConfig(response);
          }
        })
        .catch(() => undefined);
    };

    window.addEventListener('focus', refreshTaskNotifyConfig);
    document.addEventListener('visibilitychange', refreshTaskNotifyConfig);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshTaskNotifyConfig);
      document.removeEventListener('visibilitychange', refreshTaskNotifyConfig);
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId) {
      return;
    }

    const socket = createAuthedSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit(
        'room:joinLive',
        { roomId },
        (payload: ({ ok: true } & RoomPresenceSnapshotPayload) | { ok: false; message?: string }) => {
          if (!payload.ok) {
            if (payload.message) {
              setError(payload.message);
            }
            return;
          }

          if (payload.roomId === roomId) {
            setOnlineMemberIps(payload.onlineMemberIps);
          }

          void refreshRoomPresence().catch(() => undefined);
        },
      );

      window.setTimeout(() => {
        void refreshRoomPresence().catch(() => undefined);
      }, 220);
    });
    socket.on('connect_error', (socketError) => {
      setError(socketError.message || '实时连接失败，请刷新后重试');
    });

    socket.on('message:new', (payload: ChatMessage) => {
      if (payload.roomId !== roomId) {
        return;
      }
      setMessages((current) => upsertMessage(current, payload));

      if (isMessageMentioningCurrentUser(payload, meRef.current) && payload.id > (lastSeenMessageIdRef.current ?? 0)) {
        setUnreadMentionCount((current) => current + 1);

        if (latestUnreadMentionIdRef.current === null) {
          latestUnreadMentionIdRef.current = payload.id;
          setLatestUnreadMentionId(payload.id);
          setLatestUnreadMentionAt(payload.createdAt);
        }

        setRoom((current) => current
          ? {
              ...current,
              unreadMentionCount: current.unreadMentionCount + 1,
              latestUnreadMentionId: current.latestUnreadMentionId ?? payload.id,
              latestUnreadMentionAt: current.latestUnreadMentionAt ?? payload.createdAt,
            }
          : current);
      }
    });

    socket.on('message:edited', (payload: ChatMessage) => {
      if (payload.roomId !== roomId) {
        return;
      }
      setMessages((current) => upsertMessage(current, payload));
      setResendDraftSource((current) => (current?.id === payload.id ? payload : current));
      setReplyDraftMessageId((current) => (current === payload.id ? payload.id : current));
      if (payload.id >= (latestUnreadMentionIdRef.current ?? 0) || isMessageMentioningCurrentUser(payload, meRef.current)) {
        void refreshRoomReadState().catch(() => undefined);
      }
    });

    socket.on('message:taskUpdated', (payload: ChatMessage) => {
      if (payload.roomId !== roomId) {
        return;
      }
      setMessages((current) => upsertMessage(current, payload));
      setResendDraftSource((current) => (current?.id === payload.id ? null : current));
      setReplyDraftMessageId((current) => (current === payload.id ? payload.id : current));
      setTaskNotifyModal((current) => (
        current?.messageId === payload.id && !isTaskNotifyStructured(payload.taskContent)
          ? null
          : current
      ));
    });

    socket.on('message:recalled', (payload: ChatMessage) => {
      if (payload.roomId !== roomId) {
        return;
      }
      setMessages((current) => upsertMessage(current, payload));
      setPreview((current) => (isPreviewForMessage(current, payload.id) ? null : current));
      setResendDraftSource((current) => (current?.id === payload.id ? null : current));
      setReplyDraftMessageId((current) => (current === payload.id ? null : current));
      setTaskNotifyModal((current) => (current?.messageId === payload.id ? null : current));
      if (payload.id >= (latestUnreadMentionIdRef.current ?? 0)) {
        void refreshRoomReadState().catch(() => undefined);
      }
    });

    const handleMemberChange = (payload: MemberEventPayload) => {
      if (payload.roomId !== roomId) {
        return;
      }

      setRoom((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          members: mergeMember(current.members, payload.member),
        };
      });

      setMe((current) => {
        if (!current || current.ip !== payload.member.ip) {
          return current;
        }
        return {
          ...current,
          nickname: payload.member.nickname,
          hasProfile: true,
        };
      });
    };

    socket.on('member:joined', handleMemberChange);
    socket.on('member:updated', handleMemberChange);

    socket.on('member:presence', (payload: MemberPresencePayload) => {
      if (payload.roomId !== roomId) {
        return;
      }

      setOnlineMemberIps((current) => {
        if (payload.isOnline) {
          return current.includes(payload.memberIp) ? current : [...current, payload.memberIp];
        }

        return current.filter((memberIp) => memberIp !== payload.memberIp);
      });
    });

    socket.on('member:left', (payload: MemberEventPayload) => {
      if (payload.roomId !== roomId) {
        return;
      }
      setRoom((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          members: current.members.filter((member) => member.ip !== payload.member.ip),
        };
      });
      setOnlineMemberIps((current) => current.filter((memberIp) => memberIp !== payload.member.ip));
    });

    socket.on('room:dissolved', (payload: RoomDissolvedPayload) => {
      if (payload.roomId !== roomId) {
        return;
      }
      setPreview(null);
      window.alert('群组已被群主解散');
      navigate('/');
    });

    socket.on('room:error', (payload: RoomErrorPayload) => {
      if (payload.roomId && payload.roomId !== roomId) {
        return;
      }
      setError(payload.message);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [navigate, roomId]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) {
        return;
      }

      if (shouldStickToBottomRef.current || !initialScrollHandledRef.current) {
        container.scrollTop = container.scrollHeight;
        shouldStickToBottomRef.current = true;
        setShowScrollToLatest(false);
      } else {
        updateMessageListScrollState();
      }

      initialScrollHandledRef.current = true;
      updateMessageListScrollState();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [hiddenMessageIds, latestUnreadMentionId, messages, unreadMentionCount]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateMessageListScrollState());
    return () => window.cancelAnimationFrame(frameId);
  }, [latestUnreadMentionId, roomId, unreadMentionCount]);

  useEffect(() => {
    const timer = window.setInterval(() => setRecallClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px) and (orientation: portrait)');
    const applyMembersPanelState = () => setMembersExpanded(!mediaQuery.matches);
    applyMembersPanelState();

    const listener = () => applyMembersPanelState();
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, [roomId]);

  useEffect(() => {
    setPreview(null);
    setPendingAttachments([]);
    setMessageText('');
    setResendDraftSource(null);
    setActiveMentionQuery(null);
    setActiveMentionIndex(0);
    pendingAttachmentsRef.current = [];
    uploadQueueRef.current = [];
    uploadWorkerActiveRef.current = false;
    setUploadProgress(null);
    setUploadingFileName(null);

    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = '';
    }

    return () => {
      const currentAttachments = pendingAttachmentsRef.current;
      currentAttachments.forEach((attachment) => {
        URL.revokeObjectURL(attachment.previewUrl);
        if (attachment.uploadId) {
          void deletePendingUpload(roomId, attachment.uploadId).catch(() => undefined);
        }
      });
      pendingAttachmentsRef.current = [];
      uploadQueueRef.current = [];
      uploadWorkerActiveRef.current = false;
    };
  }, [roomId]);

  const meMember = useMemo(() => {
    if (!room || !me) {
      return null;
    }
    return room.members.find((member) => member.ip === me.ip) ?? null;
  }, [me, room]);

  const replyDraftSource = useMemo(() => {
    if (replyDraftMessageId === null) {
      return null;
    }

    return messages.find((message) => message.id === replyDraftMessageId) ?? null;
  }, [messages, replyDraftMessageId]);

  const hiddenMessageIdSet = useMemo(() => new Set(hiddenMessageIds), [hiddenMessageIds]);
  const visibleMessages = useMemo(
    () => (hiddenMessageIdSet.size === 0 ? messages : messages.filter((message) => !hiddenMessageIdSet.has(message.id))),
    [hiddenMessageIdSet, messages],
  );
  const activeTaskNotifyMessage = useMemo(() => {
    if (!taskNotifyModal) {
      return null;
    }

    return messages.find((message) => message.id === taskNotifyModal.messageId) ?? null;
  }, [messages, taskNotifyModal]);
  const joinedRoomTabs = useMemo(() => sortRoomsByRecentVisits(joinedRooms), [joinedRooms]);

  function releaseRoomStripSuppressSoon() {
    if (roomStripSuppressTimerRef.current) {
      window.clearTimeout(roomStripSuppressTimerRef.current);
    }

    roomStripSuppressTimerRef.current = window.setTimeout(() => {
      roomStripSuppressClickRef.current = false;
      roomStripSuppressTimerRef.current = null;
    }, 80);
  }

  function handleRoomStripPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, label')) {
      roomStripDragRef.current = null;
      roomStripSuppressClickRef.current = false;
      setRoomStripDragging(false);
      return;
    }

    const container = roomStripRef.current;
    if (!container) {
      return;
    }

    roomStripDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: container.scrollLeft,
      moved: false,
    };
    roomStripSuppressClickRef.current = false;
    setRoomStripDragging(false);
    container.setPointerCapture(event.pointerId);
  }

  function handleRoomStripPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const container = roomStripRef.current;
    const dragState = roomStripDragRef.current;
    if (!container || !dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragState.startX;
    if (!dragState.moved && Math.abs(deltaX) > 4) {
      dragState.moved = true;
      roomStripSuppressClickRef.current = true;
      setRoomStripDragging(true);
    }

    if (!dragState.moved) {
      return;
    }

    container.scrollLeft = dragState.startScrollLeft - deltaX;
  }

  function handleRoomStripPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const container = roomStripRef.current;
    const dragState = roomStripDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (container?.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    const didDrag = dragState.moved;
    roomStripDragRef.current = null;
    setRoomStripDragging(false);
    if (didDrag) {
      releaseRoomStripSuppressSoon();
    }
  }

  function handleSwitchRoom(targetRoomId: string) {
    if (roomStripSuppressClickRef.current || targetRoomId === roomId) {
      return;
    }

    markRoomVisited(targetRoomId);
    navigate(`/rooms/${targetRoomId}`);
  }

  const onlineMemberIpSet = useMemo(() => new Set(onlineMemberIps), [onlineMemberIps]);
  const onlineMemberCount = useMemo(
    () => room?.members.filter((member) => onlineMemberIpSet.has(member.ip)).length ?? 0,
    [onlineMemberIpSet, room],
  );

  const mentionOptions = useMemo(() => buildMentionOptions(room, me), [me, room]);
  const filteredMentionOptions = useMemo(() => {
    if (!activeMentionQuery) {
      return [];
    }

    const normalizedQuery = activeMentionQuery.query.trim().toLowerCase();
    if (!normalizedQuery) {
      return mentionOptions;
    }

    return mentionOptions.filter((option) => option.searchText.includes(normalizedQuery));
  }, [activeMentionQuery, mentionOptions]);

  const uploadingCount = useMemo(
    () => pendingAttachments.filter((attachment) => attachment.uploadStatus === 'uploading').length,
    [pendingAttachments],
  );
  const readyAttachmentCount = useMemo(
    () => pendingAttachments.filter((attachment) => attachment.uploadStatus === 'uploaded' && attachment.uploadId).length,
    [pendingAttachments],
  );
  const canSubmitMessage = messageText.trim().length > 0 || readyAttachmentCount > 0;

  function syncActiveMentionQuery(nextText: string, caretPosition: number) {
    const nextQuery = findActiveMentionQuery(nextText, caretPosition);
    setActiveMentionQuery(nextQuery);
    setActiveMentionIndex(0);
  }

  function focusComposerSelection(position: number) {
    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  }

  function applyMentionOption(option: MentionOption) {
    const textarea = composerTextareaRef.current;
    const fallbackCaret = textarea?.selectionStart ?? messageText.length;
    const currentQuery = activeMentionQuery ?? findActiveMentionQuery(messageText, fallbackCaret);
    if (!currentQuery) {
      return;
    }

    const mentionToken = `${option.label} `;
    const nextText = `${messageText.slice(0, currentQuery.start)}${mentionToken}${messageText.slice(currentQuery.end)}`;
    const nextCaretPosition = currentQuery.start + mentionToken.length;
    setMessageText(nextText);
    setActiveMentionQuery(null);
    setActiveMentionIndex(0);
    focusComposerSelection(nextCaretPosition);
  }

  function getMessageMentionPayload(text: string): { mentionAll: boolean; mentionedIps: string[] } {
    const mentionAll = text.includes('@所有人');
    const mentionedIps = Array.from(
      new Set(
        mentionOptions
          .filter((option) => option.type === 'member' && option.ip && text.includes(option.label))
          .map((option) => option.ip as string),
      ),
    );

    return {
      mentionAll,
      mentionedIps,
    };
  }

  useEffect(() => {
    if (filteredMentionOptions.length === 0) {
      if (activeMentionIndex !== 0) {
        setActiveMentionIndex(0);
      }
      return;
    }

    if (activeMentionIndex >= filteredMentionOptions.length) {
      setActiveMentionIndex(0);
    }
  }, [activeMentionIndex, filteredMentionOptions.length]);

  function updatePendingAttachments(
    updater: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[]),
  ) {
    const current = pendingAttachmentsRef.current;
    const next =
      typeof updater === 'function'
        ? (updater as (current: PendingAttachment[]) => PendingAttachment[])(current)
        : updater;

    pendingAttachmentsRef.current = next;
    setPendingAttachments(next);
  }

  function updatePendingAttachment(
    attachmentId: string,
    updater: (attachment: PendingAttachment) => PendingAttachment,
  ) {
    updatePendingAttachments((current) =>
      current.map((attachment) => (attachment.id === attachmentId ? updater(attachment) : attachment)),
    );
  }

  async function processPendingUploadQueue() {
    if (uploadWorkerActiveRef.current) {
      return;
    }

    uploadWorkerActiveRef.current = true;
    try {
      while (uploadQueueRef.current.length > 0) {
        const attachmentId = uploadQueueRef.current.shift();
        if (!attachmentId) {
          continue;
        }

        const attachment = pendingAttachmentsRef.current.find((item) => item.id === attachmentId);
        if (!attachment || attachment.uploadStatus !== 'uploading') {
          continue;
        }

        setUploadingFileName(attachment.file.name);
        setUploadProgress(attachment.uploadPercent);

        try {
          const uploaded = await uploadPendingAttachment(roomId, attachment.file, ({ percent }) => {
            setUploadProgress(percent);
            updatePendingAttachment(attachmentId, (current) => ({
              ...current,
              uploadStatus: 'uploading',
              uploadPercent: percent,
              error: null,
            }));
          });

          updatePendingAttachment(attachmentId, (current) => ({
            ...current,
            uploadStatus: 'uploaded',
            uploadPercent: 100,
            uploadId: uploaded.uploadId,
            error: null,
          }));
        } catch (requestError) {
          const message = requestError instanceof Error ? requestError.message : '附件上传失败';
          updatePendingAttachment(attachmentId, (current) => ({
            ...current,
            uploadStatus: 'failed',
            uploadPercent: 0,
            error: message,
          }));
          setError(message);
        }
      }
    } finally {
      uploadWorkerActiveRef.current = false;
      setUploadProgress(null);
      setUploadingFileName(null);

      if (uploadQueueRef.current.length > 0) {
        void processPendingUploadQueue();
      }
    }
  }

  function enqueuePendingUploads(attachments: PendingAttachment[]) {
    uploadQueueRef.current.push(...attachments.map((attachment) => attachment.id));
    void processPendingUploadQueue();
  }

  function queueAttachments(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const validFiles: File[] = [];
    const invalidMessages: string[] = [];

    for (const file of files) {
      const validationError = getAttachmentValidationError(file);
      if (validationError) {
        invalidMessages.push(validationError);
        continue;
      }
      validFiles.push(file);
    }

    if (invalidMessages.length > 0) {
      setError(invalidMessages.join('；'));
    } else {
      setError(null);
    }

    if (validFiles.length === 0) {
      if (attachmentInputRef.current) {
        attachmentInputRef.current.value = '';
      }
      return;
    }

    const created = createPendingAttachments(validFiles);
    updatePendingAttachments((current) => [...current, ...created]);
    enqueuePendingUploads(created);

    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = '';
    }
  }

  async function removePendingAttachment(attachmentId: string) {
    const attachment = pendingAttachmentsRef.current.find((item) => item.id === attachmentId);
    if (!attachment) {
      return;
    }

    if (attachment.uploadStatus === 'uploading') {
      return;
    }

    if (attachment.uploadId) {
      try {
        await deletePendingUpload(roomId, attachment.uploadId);
      } catch {
        return;
      }
    }

    URL.revokeObjectURL(attachment.previewUrl);
    setPreview((current) => (current?.sourceKey === `pending-${attachment.id}` ? null : current));
    updatePendingAttachments((current) => current.filter((item) => item.id !== attachmentId));

    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = '';
    }
  }

  function canRecallMessage(message: ChatMessage): boolean {
    if (!me || !room || message.isRecalled) {
      return false;
    }

    if (room.role === 'owner') {
      return true;
    }

    return message.senderIp === me.ip && isWithinRecallWindow(message.createdAt, recallClock);
  }

  function canReplyMessage(message: ChatMessage): boolean {
    return !message.isRecalled;
  }

  function canEditResendMessage(message: ChatMessage): boolean {
    return Boolean(
      me
      && !message.isRecalled
      && message.type === 'text'
      && !isPackageDistributionTask(message.taskContent)
      && message.senderIp === me.ip
      && message.textContent?.trim()
      && isWithinRecallWindow(message.createdAt, recallClock),
    );
  }

  function canDeleteMessageLocally(message: ChatMessage): boolean {
    return Boolean(me && message.senderIp === me.ip);
  }

  function canCopyTextMessage(message: ChatMessage): boolean {
    return Boolean(
      !message.isRecalled
      && (message.type === 'text' || message.type === 'rich')
      && message.textContent?.trim(),
    );
  }

  function canConvertTextMessageToTask(message: ChatMessage): boolean {
    return Boolean(
      !message.isRecalled
      && message.type === 'text'
      && message.textContent?.trim()
      && !message.taskContent,
    );
  }

  function canShowTaskNotifyButton(message: ChatMessage): boolean {
    return Boolean(
      !message.isRecalled
      && message.type === 'text'
      && taskNotifyConfig?.enabled
      && isTaskNotifyStructured(message.taskContent)
      && !isPackageDistributionTask(message.taskContent)
    );
  }

  function canShowHotfixRefreshButton(message: ChatMessage): boolean {
    return Boolean(
      !message.isRecalled
      && message.type === 'text'
      && isHotfixTaskStructured(message.taskContent),
    );
  }

  function isTaskActionBusy(actionKey: string): boolean {
    return taskActionKeys.includes(actionKey);
  }

  function setTaskActionBusy(actionKey: string, busy: boolean) {
    setTaskActionKeys((current) => {
      if (busy) {
        return current.includes(actionKey) ? current : [...current, actionKey];
      }

      return current.filter((item) => item !== actionKey);
    });
  }

  function focusComposerForEditing(nextText: string) {
    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(nextText.length, nextText.length);
      textarea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  function handleToggleComposerExpanded() {
    const textarea = composerTextareaRef.current;
    const selectionStart = textarea?.selectionStart ?? messageText.length;
    const selectionEnd = textarea?.selectionEnd ?? messageText.length;
    setComposerExpanded((current) => !current);

    window.requestAnimationFrame(() => {
      const nextTextarea = composerTextareaRef.current;
      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function handleStartEditResend(message: ChatMessage) {
    const nextText = message.textContent ?? '';
    if (!nextText.trim()) {
      return;
    }

    const hasDifferentDraftText = messageText.trim().length > 0 && messageText.trim() !== nextText.trim();
    const hasPendingAttachments = pendingAttachmentsRef.current.length > 0;
    if ((hasDifferentDraftText || hasPendingAttachments) && resendDraftSource?.id !== message.id) {
      const confirmed = window.confirm(
        `当前输入区已有未发送内容${hasPendingAttachments ? '，待发送附件会保留' : ''}，确认切换为这条消息的编辑吗？`,
      );
      if (!confirmed) {
        return;
      }
    }

    setMessageText(nextText);
    setResendDraftSource(message);
    setReplyDraftMessageId(null);
    setActiveMentionQuery(null);
    setActiveMentionIndex(0);
    setError(null);
    focusComposerForEditing(nextText);
  }

  function handleStartReply(message: ChatMessage) {
    if (resendDraftSource) {
      if (resendDraftSource.id !== message.id) {
        const confirmed = window.confirm('当前正在编辑消息，切换为回复会退出编辑状态，是否继续？');
        if (!confirmed) {
          return;
        }
      }
      setResendDraftSource(null);
    }

    setReplyDraftMessageId(message.id);
    setError(null);
    focusComposerForEditing(messageText);
  }

  async function handleCopyMessageText(message: ChatMessage) {
    const textContent = message.textContent?.trim() ?? '';
    if (!textContent) {
      return;
    }

    setError(null);
    setSuccess(null);

    try {
      await copyTextToClipboard(textContent, '请复制这条消息');
      setSuccess('文案已复制');
      setCopiedMessageId(message.id);
      if (copiedMessageResetTimerRef.current) {
        window.clearTimeout(copiedMessageResetTimerRef.current);
      }
      copiedMessageResetTimerRef.current = window.setTimeout(() => {
        setCopiedMessageId((current) => (current === message.id ? null : current));
        copiedMessageResetTimerRef.current = null;
      }, 1600);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '复制失败，请手动复制');
    }
  }

  async function handleConvertMessageTask(message: ChatMessage) {
    const actionKey = getTaskConvertActionKey(message.id);
    if (isTaskActionBusy(actionKey)) {
      return;
    }

    setTaskActionBusy(actionKey, true);
    setError(null);
    try {
      const updated = await convertMessageToTask(roomId, message.id);
      setMessages((current) => upsertMessage(current, updated));
      setResendDraftSource((current) => (current?.id === updated.id ? null : current));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '转任务失败');
    } finally {
      setTaskActionBusy(actionKey, false);
    }
  }

  async function handleToggleTaskItem(message: ChatMessage, taskItemId: string, completed: boolean) {
    const actionKey = getTaskItemActionKey(message.id, taskItemId);
    if (isTaskActionBusy(actionKey)) {
      return;
    }

    setTaskActionBusy(actionKey, true);
    setError(null);
    try {
      const updated = await updateMessageTaskItem(roomId, message.id, taskItemId, completed);
      setMessages((current) => upsertMessage(current, updated));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '更新任务状态失败');
    } finally {
      setTaskActionBusy(actionKey, false);
    }
  }

  async function handleRefreshHotfixTask(message: ChatMessage) {
    if (!isHotfixTaskStructured(message.taskContent)) {
      return;
    }

    const actionKey = getHotfixRefreshActionKey(message.id);
    if (isTaskActionBusy(actionKey)) {
      return;
    }

    setTaskActionBusy(actionKey, true);
    setError(null);
    setSuccess(null);
    try {
      const response = await refreshHotfixTask(roomId, message.id);
      const currentText = (message.textContent ?? '').replace(/\r\n?/g, '\n').trim();
      const nextText = (response.message.textContent ?? '').replace(/\r\n?/g, '\n').trim();
      const taskChanged = currentText !== nextText || JSON.stringify(message.taskContent) !== JSON.stringify(response.message.taskContent);
      setMessages((current) => upsertMessage(current, response.message));
      setSuccess(
        taskChanged
          ? `热更任务已刷新${response.refreshedToken ? '，token 已自动刷新' : ''}`
          : `热更任务内容无变化${response.refreshedToken ? '，token 已自动刷新' : ''}`,
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '热更任务刷新失败');
    } finally {
      setTaskActionBusy(actionKey, false);
    }
  }

  function handleOpenTaskNotifyModal(message: ChatMessage) {
    if (!taskNotifyConfig?.enabled || !isTaskNotifyStructured(message.taskContent)) {
      return;
    }

    const assigneeMatchKeys = new Set(collectTaskAssigneeMatchKeys(message.taskContent));
    const defaultSelectedMemberIds = taskNotifyConfig.members
      .filter((member) => assigneeMatchKeys.has(normalizeTaskNotifyPersonName(member.name)))
      .map((member) => member.memberId);

    setTaskNotifyModal({
      messageId: message.id,
      selectedMemberIds: Array.from(new Set(defaultSelectedMemberIds)),
    });
    setError(null);
  }

  function handleToggleTaskNotifyMember(memberId: string) {
    setTaskNotifyModal((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        selectedMemberIds: current.selectedMemberIds.includes(memberId)
          ? current.selectedMemberIds.filter((item) => item !== memberId)
          : [...current.selectedMemberIds, memberId],
      };
    });
  }

  async function handleConfirmTaskNotify() {
    if (!taskNotifyModal || !activeTaskNotifyMessage || !taskNotifyConfig?.enabled) {
      return;
    }
    if (!areAllTaskItemsCompleted(activeTaskNotifyMessage.taskContent)) {
      setError('任务尚未全部划线完成，暂时不能发送通知');
      return;
    }
    if (taskNotifyModal.selectedMemberIds.length === 0) {
      setError('请至少选择一位通知成员');
      return;
    }

    const actionKey = getTaskNotifyActionKey(activeTaskNotifyMessage.id);
    if (isTaskActionBusy(actionKey)) {
      return;
    }

    setTaskActionBusy(actionKey, true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await sendTaskNotification(roomId, activeTaskNotifyMessage.id, {
        recipientMemberIds: taskNotifyModal.selectedMemberIds,
      });
      setMessages((current) => upsertMessage(current, updated));
      setTaskNotifyModal(null);
      setSuccess('飞书通知已发送');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '飞书通知发送失败');
    } finally {
      setTaskActionBusy(actionKey, false);
    }
  }

  function handleToggleHotfixVersion(versionLine: string) {
    setHotfixPickerModal((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        selectedVersionLines: current.selectedVersionLines.includes(versionLine)
          ? current.selectedVersionLines.filter((item) => item !== versionLine)
          : [...current.selectedVersionLines, versionLine],
      };
    });
  }

  function handleOpenPackageDistributionModal() {
    const storedLinks = readStoredPackageDistributionLinks();
    setPackageDistributionModal({
      links: (storedLinks.length > 0 ? storedLinks : ['']).map((value) => createPackageDistributionLinkInput(value)),
      blocks: null,
      testers: [],
      fetchedAt: null,
    });
    setError(null);
    setSuccess(null);
  }

  function handleChangePackageDistributionLink(linkId: string, value: string) {
    setPackageDistributionModal((current) => {
      if (!current) {
        return current;
      }

      const nextLinks = current.links.map((link) => (link.id === linkId ? { ...link, value } : link));
      storePackageDistributionLinks(nextLinks.map((link) => link.value));
      return {
        ...current,
        links: nextLinks,
        blocks: null,
        testers: [],
        fetchedAt: null,
      };
    });
  }

  function handleAddPackageDistributionLink() {
    setPackageDistributionModal((current) => {
      if (!current) {
        return current;
      }

      const nextLinks = [...current.links, createPackageDistributionLinkInput()];
      storePackageDistributionLinks(nextLinks.map((link) => link.value));
      return {
        ...current,
        links: nextLinks,
      };
    });
  }

  function handleRemovePackageDistributionLink(linkId: string) {
    setPackageDistributionModal((current) => {
      if (!current) {
        return current;
      }

      const nextLinks = current.links.filter((link) => link.id !== linkId);
      const safeLinks = nextLinks.length > 0 ? nextLinks : [createPackageDistributionLinkInput()];
      storePackageDistributionLinks(safeLinks.map((link) => link.value));
      return {
        ...current,
        links: safeLinks,
        blocks: null,
        testers: [],
        fetchedAt: null,
      };
    });
  }

  function handleClearPackageDistributionLinks() {
    clearStoredPackageDistributionLinks();
    setPackageDistributionModal((current) => (current ? {
      ...current,
      links: [createPackageDistributionLinkInput()],
      blocks: null,
      testers: [],
      fetchedAt: null,
    } : current));
  }

  async function handleFetchPackageDistributionPreview() {
    if (!packageDistributionModal || fetchingPackageDistributionPreview || sendingPackageDistributionTask) {
      return;
    }

    const links = packageDistributionModal.links
      .map((link) => link.value.trim())
      .filter(Boolean);
    if (links.length === 0) {
      setError('请至少输入一个包体链接');
      return;
    }

    setFetchingPackageDistributionPreview(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetchPackageDistributionPreview(roomId, { links });
      setPackageDistributionModal((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          blocks: response.blocks.map((block) => ({
            ...block,
            entries: block.entries.map((entry) => ({
              ...entry,
              assignees: [],
            })),
          })),
          testers: response.testers,
          fetchedAt: response.fetchedAt,
        };
      });
      setSuccess(response.testers.length > 0 ? '包体内容已加载' : '包体内容已加载，请先到管理员页配置测试人员');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '包体链接读取失败');
    } finally {
      setFetchingPackageDistributionPreview(false);
    }
  }

  function handleTogglePackageDistributionAssignee(blockId: string, entryId: string, assignee: string) {
    const normalizedAssignee = assignee.trim();
    if (!normalizedAssignee) {
      return;
    }

    setPackageDistributionModal((current) => {
      if (!current?.blocks) {
        return current;
      }

      return {
        ...current,
        blocks: current.blocks.map((block) => (
          block.id === blockId
            ? {
                ...block,
                entries: block.entries.map((entry) => (
                  entry.id === entryId
                    ? {
                        ...entry,
                        assignees: entry.assignees.includes(normalizedAssignee)
                          ? entry.assignees.filter((value) => value !== normalizedAssignee)
                          : normalizePackageDistributionAssignees([...entry.assignees, normalizedAssignee]),
                      }
                    : entry
                )),
              }
            : block
        )),
      };
    });
  }

  async function handleSendPackageDistributionTask() {
    if (!packageDistributionModal?.blocks || sendingPackageDistributionTask || fetchingPackageDistributionPreview) {
      return;
    }

    const fileEntries = packageDistributionModal.blocks.flatMap((block) => block.entries.filter((entry) => entry.entryType === 'file'));
    if (fileEntries.length === 0) {
      setError('当前包体目录下没有可分配的文件');
      return;
    }

    const unassignedEntry = fileEntries.find((entry) => entry.assignees.length === 0);
    if (unassignedEntry) {
      setError(`请先为文件 ${unassignedEntry.name} 选择至少一位测试人员`);
      return;
    }

    setSendingPackageDistributionTask(true);
    setError(null);
    setSuccess(null);

    try {
      const message = await sendPackageDistributionTask(roomId, {
        blocks: packageDistributionModal.blocks.map((block) => ({
          title: block.title,
          sourceUrl: block.sourceUrl,
          entries: block.entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            path: entry.path,
            entryType: entry.entryType,
            url: entry.url,
            assignees: entry.entryType === 'file' ? entry.assignees : undefined,
          })),
        })),
      });
      setMessages((current) => upsertMessage(current, message));
      setPackageDistributionModal(null);
      setSuccess('包体分配任务已发送');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '包体分配任务发送失败');
    } finally {
      setSendingPackageDistributionTask(false);
    }
  }

  async function handleOpenAdbInstallModal(resource: TaskMessageItemResource) {
    if (openingAdbInstallPackageUrl || adbInstallModal) {
      return;
    }

    if (!isAdbInstallSupportedPackageUrl(resource.fileUrl)) {
      setError('ADB 安装仅支持 .apk/.apks 包体');
      return;
    }

    setOpeningAdbInstallPackageUrl(resource.fileUrl);
    setError(null);
    setSuccess(null);

    try {
      const serviceReady = await probeAdbService();
      if (!serviceReady) {
        setError('本地adb服务未开启');
        return;
      }

      const devices = await fetchAdbDevices();
      setAdbInstallModal({
        packageName: resource.fileName,
        packageUrl: resource.fileUrl,
        devices,
      });
    } catch (requestError) {
      if (isAdbServiceUnavailableError(requestError)) {
        setError('本地adb服务未开启');
      } else {
        setError(requestError instanceof Error ? requestError.message : '获取设备失败');
      }
    } finally {
      setOpeningAdbInstallPackageUrl(null);
    }
  }

  async function sendRoomTextMessage(text: string): Promise<ChatMessage> {
    if (!socketRef.current) {
      throw new Error('实时连接未就绪，请稍后重试');
    }

    return new Promise<ChatMessage>((resolveSend, rejectSend) => {
      socketRef.current?.emit(
        'message:text',
        {
          roomId,
          text,
          mentionAll: false,
          mentionedIps: [],
        },
        (payload: { ok: boolean; message?: ChatMessage | string }) => {
          if (payload.ok && payload.message && typeof payload.message === 'object') {
            resolveSend(payload.message);
            return;
          }

          rejectSend(new Error(typeof payload.message === 'string' ? payload.message : '发送失败'));
        },
      );
    });
  }

  async function handleSendSelectedHotfix(asTask: boolean) {
    if (!hotfixPickerModal || processingHotfixSelection) {
      return;
    }

    const selectedBlocks = hotfixPickerModal.versionBlocks.filter((block) => hotfixPickerModal.selectedVersionLines.includes(block.versionLine));
    if (selectedBlocks.length === 0) {
      setError('请至少选择一个热更版本');
      return;
    }

    const text = asTask ? buildHotfixBlocksTaskText(selectedBlocks) : buildHotfixBlocksText(selectedBlocks);
    if (!text) {
      setError('当前选择的热更内容为空，无法发送');
      return;
    }

    setProcessingHotfixSelection(true);
    setError(null);
    setSuccess(null);

    try {
      const sentMessage = await sendRoomTextMessage(text);
      setMessages((current) => upsertMessage(current, sentMessage));

      if (asTask) {
        try {
          const updated = await convertMessageToTask(roomId, sentMessage.id, { notifyTaskCreation: true });
          setMessages((current) => upsertMessage(current, updated));
        } catch (requestError) {
          setHotfixPickerModal(null);
          setError(`热更文本已发送，但自动转任务失败：${requestError instanceof Error ? requestError.message : '请手动转任务'}`);
          return;
        }
      }

      setHotfixPickerModal(null);
      setSuccess(
        `${asTask ? '热更任务已发送' : '热更文本已发送'}${hotfixPickerModal.refreshedToken ? '，token 已自动刷新' : ''}`,
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : asTask ? '热更任务发送失败' : '热更文本发送失败');
    } finally {
      setProcessingHotfixSelection(false);
    }
  }

  async function handleFetchHotfix() {
    if (fetchingHotfixContent || sending || processingHotfixSelection) {
      return;
    }

    setFetchingHotfixContent(true);
    setError(null);
    setSuccess(null);

    try {
      const documentResult = await fetchHotfixContent(roomId);
      if (documentResult.versionBlocks.length === 0) {
        setError('未识别到可选择的热更版本，请检查热更文档格式');
        return;
      }

      setHotfixPickerModal({
        documentId: documentResult.documentId,
        versionBlocks: documentResult.versionBlocks,
        selectedVersionLines: documentResult.versionBlocks[0] ? [documentResult.versionBlocks[0].versionLine] : [],
        refreshedToken: documentResult.refreshedToken,
      });
      setSuccess(documentResult.refreshedToken ? '热更版本已加载，token 已自动刷新' : '热更版本已加载');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '热更内容获取失败');
    } finally {
      setFetchingHotfixContent(false);
    }
  }

  function handleDeleteMessageLocally(message: ChatMessage) {
    if (!me || message.senderIp !== me.ip) {
      return;
    }

    const confirmed = window.confirm('删除后仅当前设备不再展示这条消息，其他成员仍可见，确认删除吗？');
    if (!confirmed) {
      return;
    }

    if (resendDraftSource?.id === message.id) {
      setResendDraftSource(null);
      setMessageText('');
      setActiveMentionQuery(null);
      setActiveMentionIndex(0);
    }

    setHiddenMessageIds((current) => (current.includes(message.id) ? current : [...current, message.id]));
    setPreview((current) => (isPreviewForMessage(current, message.id) ? null : current));
    setCopiedMessageId((current) => (current === message.id ? null : current));
    setHighlightedMessageId((current) => (current === message.id ? null : current));
    setReplyDraftMessageId((current) => (current === message.id ? null : current));
    setTaskNotifyModal((current) => (current?.messageId === message.id ? null : current));
  }

  async function handleSendMessage() {
    const normalizedText = messageText.trim();
    const hasUploadingAttachments = pendingAttachmentsRef.current.some((attachment) => attachment.uploadStatus === 'uploading');
    const readyAttachments = pendingAttachmentsRef.current.filter(
      (attachment) => attachment.uploadStatus === 'uploaded' && Boolean(attachment.uploadId),
    );

    if (resendDraftSource) {
      if (!normalizedText) {
        setError('编辑后的消息内容不能为空');
        return;
      }

      setSending(true);
      setError(null);
      try {
        const mentionPayload = resendDraftSource.taskContent ? null : getMessageMentionPayload(normalizedText);
        const updated = resendDraftSource.taskContent
          ? await editTaskMessage(roomId, resendDraftSource.id, { text: normalizedText })
          : await editMessage(roomId, resendDraftSource.id, {
              text: normalizedText,
              mentionAll: mentionPayload?.mentionAll,
              mentionedIps: mentionPayload?.mentionedIps,
            });
        setMessages((current) => upsertMessage(current, updated));
        setMessageText('');
        setResendDraftSource(null);
        setActiveMentionQuery(null);
        setActiveMentionIndex(0);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : '编辑失败');
      } finally {
        setSending(false);
      }
      return;
    }

    if (!normalizedText && readyAttachments.length === 0) {
      if (hasUploadingAttachments) {
        setError('附件仍在上传中，上传完成后再点击发送');
      }
      return;
    }

    if (replyDraftSource && !normalizedText) {
      setError('回复消息需要输入文字内容');
      return;
    }

    if (normalizedText && readyAttachments.length > 0 && hasUploadingAttachments) {
      setError('附件仍在上传中，上传完成后再点击发送');
      return;
    }

    shouldStickToBottomRef.current = true;
    setShowScrollToLatest(false);
    setSending(true);
    setError(null);
    const failureMessages: string[] = [];

    const clearSentAttachments = (attachments: PendingAttachment[]) => {
      const sentAttachmentIds = new Set(attachments.map((attachment) => attachment.id));
      attachments.forEach((attachment) => {
        URL.revokeObjectURL(attachment.previewUrl);
        setPreview((current) => (current?.sourceKey === `pending-${attachment.id}` ? null : current));
      });
      updatePendingAttachments((current) => current.filter((item) => !sentAttachmentIds.has(item.id)));
    };

    if (normalizedText && readyAttachments.length > 0) {
      try {
        const mentionPayload = getMessageMentionPayload(normalizedText);
        const result = await commitPendingUploads(roomId, {
          uploadIds: readyAttachments.map((attachment) => attachment.uploadId as string),
          text: normalizedText,
          mentionAll: mentionPayload.mentionAll,
          mentionedIps: mentionPayload.mentionedIps,
          replyMessageId: replyDraftSource?.id,
        });
        setMessages((current) => mergeMessagesById(current, result.items));
        clearSentAttachments(readyAttachments);
        setMessageText('');
        setReplyDraftMessageId(null);
        setActiveMentionQuery(null);
        setActiveMentionIndex(0);
      } catch (requestError) {
        failureMessages.push(requestError instanceof Error ? requestError.message : '富文本发送失败');
      }
    } else {
      if (normalizedText) {
        try {
          if (!socketRef.current) {
            throw new Error('实时连接未就绪，请稍后重试');
          }

          const mentionPayload = getMessageMentionPayload(normalizedText);
          await new Promise<void>((resolveSend, rejectSend) => {
            socketRef.current?.emit(
              'message:text',
              {
                roomId,
                text: normalizedText,
                mentionAll: mentionPayload.mentionAll,
                mentionedIps: mentionPayload.mentionedIps,
                replyMessageId: replyDraftSource?.id,
              },
              (payload: { ok: boolean; message?: string }) => {
                if (payload.ok) {
                  resolveSend();
                  return;
                }
                rejectSend(new Error(payload.message ?? '发送失败'));
              },
            );
          });
          setMessageText('');
          setReplyDraftMessageId(null);
          setActiveMentionQuery(null);
          setActiveMentionIndex(0);
        } catch (requestError) {
          failureMessages.push(requestError instanceof Error ? requestError.message : '文本发送失败');
        }
      }

      if (readyAttachments.length > 0) {
        try {
          const result = await commitPendingUploads(roomId, {
            uploadIds: readyAttachments.map((attachment) => attachment.uploadId as string),
          });
          setMessages((current) => mergeMessagesById(current, result.items));
          clearSentAttachments(readyAttachments);
        } catch (requestError) {
          failureMessages.push(requestError instanceof Error ? requestError.message : '附件发送失败');
        }
      }
    }

    if (failureMessages.length > 0) {
      setError(failureMessages.join('；'));
    }

    setSending(false);
    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = '';
    }
  }

  async function handleRecallMessage(message: ChatMessage) {
    const confirmMessage = room?.role === 'owner' && me && message.senderIp !== me.ip
      ? `确认以群主身份撤回 ${message.senderNickname} 的这条消息吗？撤回后无法恢复。`
      : '确认撤回这条消息吗？撤回后无法恢复。';

    if (!window.confirm(confirmMessage)) {
      return;
    }

    setError(null);
    try {
      const recalled = await recallMessage(roomId, message.id);
      setMessages((current) => upsertMessage(current, recalled));
      setPreview((current) => (isPreviewForMessage(current, recalled.id) ? null : current));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '撤回失败');
    }
  }

  async function handleDangerAction() {
    if (!room) {
      return;
    }

    if (!confirmRoomDangerAction(room.role, room.roomId)) {
      return;
    }

    setSending(true);
    setError(null);
    try {
      if (room.role === 'owner') {
        await dissolveRoom(room.roomId);
      } else {
        await leaveRoom(room.roomId);
      }
      navigate('/');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '群组操作失败');
    } finally {
      setSending(false);
      setSettingsOpen(false);
    }
  }

  async function copyRoomId() {
    if (!room) {
      return;
    }

    setError(null);
    setSuccess(null);

    try {
      await copyTextToClipboard(room.roomId, '请复制房间 ID');
      setSuccess('房间号已复制');
      setRoomIdCopied(true);
      if (copiedRoomIdResetTimerRef.current) {
        window.clearTimeout(copiedRoomIdResetTimerRef.current);
      }
      copiedRoomIdResetTimerRef.current = window.setTimeout(() => {
        setRoomIdCopied(false);
        copiedRoomIdResetTimerRef.current = null;
      }, 1600);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '复制房间号失败，请手动复制');
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.files.length) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    queueAttachments(Array.from(event.dataTransfer.files));
  }

  if (loading) {
    return (
      <AppShell>
        <FloatingFeedbackToasts error={error} success={success} />
        <div className="empty-state full-page">群组加载中…</div>
      </AppShell>
    );
  }

  if (!room) {
    return (
      <AppShell>
        <FloatingFeedbackToasts error={error} success={success} />
        <div className="panel-card error-layout">
          <h2>无法进入群组</h2>
          <p>当前群组不存在，或者你已经不在这个群组中。</p>
          <Link className="primary-button as-link-button" to="/">
            返回主页
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <FloatingFeedbackToasts error={error} success={success} />
      <div className="chat-layout">
        <aside className="sidebar-card">
          <div className="section-head align-start room-id-head">
            <div>
              <div className="eyebrow">ROOM ID</div>
              <h2>{room.roomId}</h2>
              <p className="room-topic-text">主题：{getDisplayRoomName(room.roomName, room.roomId)}</p>
            </div>
            <button
              className={`message-action-button room-id-copy-button ${roomIdCopied ? 'message-action-button-copied' : ''}`}
              type="button"
              onClick={() => void copyRoomId()}
              aria-label="复制房间号"
              title={roomIdCopied ? '已复制' : '复制房间号'}
            >
              <CopyIcon className="message-action-icon-svg" />
            </button>
          </div>

          <div className="stack-gap">
            <div className="member-highlight">
              <span>当前身份</span>
              <strong>{room.role === 'owner' ? '群主' : '成员'}</strong>
            </div>
            <UserIdentityCard me={me} displayName={meMember?.nickname ?? me?.nickname ?? '--'} />
          </div>

          <section className={`collapsible-panel room-settings-panel desktop-settings-panel ${settingsOpen ? 'expanded' : 'collapsed'}`}>
            <button className="collapsible-trigger" type="button" onClick={() => setSettingsOpen((value) => !value)}>
              <div>
                <h3>房间设置</h3>
                <p>退出或解散群组</p>
              </div>
              <span className="collapsible-indicator" aria-hidden="true">{settingsOpen ? '收起' : '展开'}</span>
            </button>
            {settingsOpen ? (
              <div className="settings-menu collapsible-content">
                <button className="danger-button" type="button" onClick={() => void handleDangerAction()} disabled={sending || uploadingCount > 0}>
                  {room.role === 'owner' ? '解散群组' : '退出群组'}
                </button>
              </div>
            ) : null}
          </section>

          <section className={`collapsible-panel members-panel ${membersExpanded ? 'expanded' : 'collapsed'}`}>
            <button className="collapsible-trigger" type="button" onClick={() => setMembersExpanded((value) => !value)}>
              <div>
                <h3>当前成员</h3>
                <p>{onlineMemberCount} 人在线 · {room.members.length} 人成员</p>
              </div>
              <span className="collapsible-indicator" aria-hidden="true">{membersExpanded ? '收起' : '展开'}</span>
            </button>
            {membersExpanded ? (
              <div className="member-list collapsible-content">
                {room.members.map((member) => {
                  const isOnline = onlineMemberIpSet.has(member.ip);

                  return (
                    <div key={member.ip} className="member-item">
                      <div className="member-item-main">
                        <strong>{member.nickname}</strong>
                        <div className="muted-line">{member.ip}</div>
                      </div>
                      <div className="member-item-badges">
                        <span className={`member-presence-badge ${isOnline ? 'member-presence-online' : 'member-presence-offline'}`}>
                          {isOnline ? '在线' : '不在聊天'}
                        </span>
                        <span className="role-badge">{member.role === 'owner' ? '群主' : '成员'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        </aside>

        <section className="chat-panel">
          <div className="chat-header">
            {joinedRoomTabs.length > 0 ? (
              <div className="chat-room-switcher">
                <div className="chat-room-switcher-head">
                  <strong>我的房间</strong>
                  <span>{joinedRoomTabs.length} 个 · 左右拖动快速切换</span>
                </div>
                <div
                  ref={roomStripRef}
                  className={`chat-room-switcher-track ${roomStripDragging ? 'dragging' : ''}`}
                  onPointerDown={handleRoomStripPointerDown}
                  onPointerMove={handleRoomStripPointerMove}
                  onPointerUp={handleRoomStripPointerEnd}
                  onPointerCancel={handleRoomStripPointerEnd}
                >
                  {joinedRoomTabs.map((joinedRoom) => {
                    const isActiveRoom = joinedRoom.roomId === roomId;
                    return (
                      <button
                        key={joinedRoom.roomId}
                        className={`chat-room-switcher-chip ${isActiveRoom ? 'active' : ''}`}
                        type="button"
                        onClick={() => handleSwitchRoom(joinedRoom.roomId)}
                        aria-current={isActiveRoom ? 'page' : undefined}
                        title={`${getDisplayRoomName(joinedRoom.roomName, joinedRoom.roomId)} (${joinedRoom.roomId})`}
                      >
                        <span className="chat-room-switcher-chip-title">
                          {getDisplayRoomName(joinedRoom.roomName, joinedRoom.roomId)}
                        </span>
                        <span className="chat-room-switcher-chip-meta">#{joinedRoom.roomId}</span>
                        {joinedRoom.unreadMentionCount > 0 ? (
                          <span className="chat-room-switcher-chip-badge">
                            @{joinedRoom.unreadMentionCount}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="chat-header-main">
              <div className="chat-header-copy">
                <h1>{getDisplayRoomName(room.roomName, room.roomId)}</h1>
                <p>房间号：{room.roomId} · 支持文本、图片、文件；可直接粘贴附件，或拖拽到输入框区域。</p>
              </div>
              <button
                className="secondary-button chat-home-button"
                type="button"
                onClick={() => navigate('/')}
                aria-label="返回主页"
                title="返回主页"
              >
                返回
              </button>
            </div>
            <div className="mobile-chat-toolbar">
              <div className="mobile-room-chip-wrap">
                <div className="mobile-room-chip">
                  <span>房间号：{room.roomId}</span>
                  <strong>{getDisplayRoomName(room.roomName, room.roomId)}</strong>
                </div>
                <button
                  className={`message-action-button room-id-copy-button room-id-copy-button-mobile ${roomIdCopied ? 'message-action-button-copied' : ''}`}
                  type="button"
                  onClick={() => void copyRoomId()}
                  aria-label="复制房间号"
                  title={roomIdCopied ? '已复制' : '复制房间号'}
                >
                  <CopyIcon className="message-action-icon-svg" />
                </button>
              </div>
              <section className={`collapsible-panel room-settings-panel mobile-settings-panel ${settingsOpen ? 'expanded' : 'collapsed'}`}>
                <button className="collapsible-trigger" type="button" onClick={() => setSettingsOpen((value) => !value)}>
                  <div>
                    <h3>房间设置</h3>
                    <p>退出或解散群组</p>
                  </div>
                  <span className="collapsible-indicator" aria-hidden="true">{settingsOpen ? '收起' : '展开'}</span>
                </button>
                {settingsOpen ? (
                  <div className="settings-menu collapsible-content">
                    <button className="danger-button" type="button" onClick={() => void handleDangerAction()} disabled={sending || uploadingCount > 0}>
                      {room.role === 'owner' ? '解散群组' : '退出群组'}
                    </button>
                  </div>
                ) : null}
              </section>
            </div>
          </div>

          <div className="message-list-shell">
            <div ref={scrollRef} className="message-list" onScroll={updateMessageListScrollState}>
              {visibleMessages.length === 0 ? (
                <div className="empty-state">{messages.length === 0 ? '还没有消息，先发一句吧。' : '当前没有可见消息。'}</div>
              ) : null}

              {visibleMessages.map((message) => {
                const isSelf = me?.ip === message.senderIp;
                const canCopyText = canCopyTextMessage(message);
                const canConvertTask = canConvertTextMessageToTask(message);
                const canRefreshHotfixTask = canShowHotfixRefreshButton(message);
                const canNotifyTask = canShowTaskNotifyButton(message);
                const canEditResend = canEditResendMessage(message);
                const canDeleteLocally = canDeleteMessageLocally(message);
                const canReply = canReplyMessage(message);
                const canRecall = canRecallMessage(message);
                const mentionsCurrentUser = isMessageMentioningCurrentUser(message, me);
                const hasPendingMention = mentionsCurrentUser && !message.isRecalled && message.id > (lastSeenMessageId ?? 0);
                const mentionHint = getMessageMentionHint(message, me, hasPendingMention);
                const convertActionKey = getTaskConvertActionKey(message.id);
                const notifyActionKey = getTaskNotifyActionKey(message.id);
                const taskNotifyReady = areAllTaskItemsCompleted(message.taskContent);
                const replyContent = message.replyContent;
                return (
                  <div key={message.id} data-message-id={message.id} className={`message-row ${isSelf ? 'self' : ''} ${hasPendingMention ? 'mentioned' : ''}`}>
                    <div className={`message-bubble ${hasPendingMention ? 'message-bubble-mentioned' : ''} ${highlightedMessageId === message.id ? 'message-bubble-linked-target' : ''}`}>
                      <div className="message-meta message-meta-top">
                        <div className="message-meta-main">
                          <div className="message-meta-main-topline">
                            <strong>{message.senderNickname}</strong>
                          </div>
                          <span>{formatDateTime(message.createdAt)}</span>
                        </div>
                        {canCopyText || canConvertTask || canRefreshHotfixTask || canNotifyTask || canEditResend || canDeleteLocally || canReply || canRecall ? (
                          <div className="message-actions">
                            {canReply ? (
                              <button
                                className="message-action-button"
                                type="button"
                                onClick={() => handleStartReply(message)}
                                aria-label={`回复 ${message.senderNickname} 的消息`}
                                title="回复消息"
                              >
                                <ReplyIcon className="message-action-icon-svg" />
                              </button>
                            ) : null}
                            {canCopyText ? (
                              <button
                                className={`message-action-button ${copiedMessageId === message.id ? 'message-action-button-copied' : ''}`}
                                type="button"
                                onClick={() => void handleCopyMessageText(message)}
                                aria-label={`复制 ${message.senderNickname} 的文案`}
                                title={copiedMessageId === message.id ? '已复制' : '复制文案'}
                              >
                                <CopyIcon className="message-action-icon-svg" />
                              </button>
                            ) : null}
                            {canConvertTask ? (
                              <button
                                className="message-action-button message-action-button-label"
                                type="button"
                                onClick={() => void handleConvertMessageTask(message)}
                                disabled={isTaskActionBusy(convertActionKey)}
                                aria-label={`将 ${message.senderNickname} 的消息转为任务`}
                                title="转任务"
                              >
                                <TaskConvertIcon className="message-action-icon-svg" />
                                <span>{isTaskActionBusy(convertActionKey) ? '转换中' : '转任务'}</span>
                              </button>
                            ) : null}
                            {canRefreshHotfixTask ? (
                              <button
                                className="message-action-button message-action-button-label"
                                type="button"
                                onClick={() => void handleRefreshHotfixTask(message)}
                                disabled={isTaskActionBusy(getHotfixRefreshActionKey(message.id))}
                                aria-label={`刷新 ${message.senderNickname} 的热更任务`}
                                title="刷新热更任务"
                              >
                                <RefreshIcon className="message-action-icon-svg" />
                                <span>{isTaskActionBusy(getHotfixRefreshActionKey(message.id)) ? '刷新中' : '刷新'}</span>
                              </button>
                            ) : null}
                            {canNotifyTask || (message.taskContent && message.taskNotifiedAt) ? (
                              <div className="message-task-notify-actions">
                                {canNotifyTask ? (
                                  <button
                                    className="message-action-button message-action-button-label message-action-button-accent"
                                    type="button"
                                    onClick={() => handleOpenTaskNotifyModal(message)}
                                    disabled={isTaskActionBusy(notifyActionKey) || !taskNotifyReady}
                                    aria-label={`发送 ${message.senderNickname} 的任务通知`}
                                    title={taskNotifyReady ? '发送飞书通知' : '任务全部完成后才可发送通知'}
                                  >
                                    <TaskNotifyIcon className="message-action-icon-svg" />
                                    <span>{isTaskActionBusy(notifyActionKey) ? '发送中' : '通知'}</span>
                                  </button>
                                ) : null}
                                {message.taskContent && message.taskNotifiedAt ? (
                                  <span className="task-notified-badge" title={`飞书通知已发送：${formatDateTime(message.taskNotifiedAt)}`}>
                                    已发
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            {canEditResend ? (
                              <button
                                className="message-action-button"
                                type="button"
                                onClick={() => handleStartEditResend(message)}
                                aria-label={`编辑 ${message.senderNickname} 的消息`}
                                title="编辑消息"
                              >
                                <EditResendIcon className="message-action-icon-svg" />
                              </button>
                            ) : null}
                            {canDeleteLocally ? (
                              <button
                                className="message-action-button message-action-button-danger"
                                type="button"
                                onClick={() => handleDeleteMessageLocally(message)}
                                aria-label={`删除 ${message.senderNickname} 的消息，仅当前设备可见`}
                                title="删除消息（仅自己不可见）"
                              >
                                <DeleteMessageIcon className="message-action-icon-svg" />
                              </button>
                            ) : null}
                            {canRecall ? (
                              <button
                                className="message-action-button"
                                type="button"
                                onClick={() => void handleRecallMessage(message)}
                                aria-label={`撤回 ${message.senderNickname} 的消息`}
                                title="撤回消息"
                              >
                                <RecallIcon className="message-action-icon-svg" />
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      {!message.isRecalled && mentionHint ? (
                        <div className={`mention-notice ${hasPendingMention ? 'mention-notice-target' : ''}`}>
                          {mentionHint}
                        </div>
                      ) : null}

                      {!message.isRecalled && replyContent ? (
                        <ReplyReferencePreview
                          roomId={roomId}
                          replyContent={replyContent}
                          className="message-reply-reference"
                          onClick={() => void jumpToMessage(replyContent.messageId, '暂时无法定位原消息，请稍后重试')}
                        />
                      ) : null}

                      {message.isRecalled ? (
                        <div className="recalled-message">
                          {getRecalledMessageText(message, room)}
                        </div>
                      ) : null}

                      {!message.isRecalled && message.type === 'rich' ? (
                        <div className="rich-message-card">
                          {message.richContent?.attachments.length ? (
                            <div className="rich-message-attachments">
                              {message.richContent.attachments.map((attachment) => (
                                <RichAttachmentCard
                                  key={attachment.id}
                                  messageId={message.id}
                                  attachment={attachment}
                                  onPreview={setPreview}
                                />
                              ))}
                            </div>
                          ) : null}
                          {message.textContent?.trim() ? (
                            <div className="message-text rich-message-text">
                              {renderMessageTextWithMentions(message.textContent)}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {!message.isRecalled && message.type === 'text' ? (
                        <>
                          {message.taskContent ? (
                            <TaskMessageCardView
                              taskContent={message.taskContent}
                              messageId={message.id}
                              isTaskActionBusy={isTaskActionBusy}
                              installBusy={openingAdbInstallPackageUrl !== null}
                              onInstallPackage={(resource) => {
                                void handleOpenAdbInstallModal(resource);
                              }}
                              onToggleItem={(taskItemId, completed) => {
                                void handleToggleTaskItem(message, taskItemId, completed);
                              }}
                            />
                          ) : (
                            <div className="message-text">{renderMessageTextWithMentions(message.textContent ?? '')}</div>
                          )}
                          {isMessageEdited(message) ? <div className="message-edited-hint">已编辑</div> : null}
                        </>
                      ) : null}

                      {!message.isRecalled && message.type === 'image' && message.imageUrl ? (
                      <div className="attachment-card">
                        <button className="image-preview-button" type="button" onClick={() => setPreview(toMessagePreview(message))}>
                          <img className="chat-image" src={message.imageUrl} alt={message.imageName ?? '图片消息'} />
                        </button>
                        <div className="attachment-meta">
                          <strong>{message.imageName ?? '图片附件'}</strong>
                          <span>{formatFileSize(message.imageSize)}</span>
                        </div>
                        <div className="attachment-actions attachment-actions-image">
                          <button
                            className="attachment-action-icon"
                            type="button"
                            onClick={() => setPreview(toMessagePreview(message))}
                            aria-label={`预览 ${message.imageName ?? '图片附件'}`}
                            title="预览图片"
                          >
                            <EyeIcon className="attachment-action-icon-svg" />
                          </button>
                          <a
                            className="attachment-action-icon"
                            href={message.fileUrl ?? message.imageUrl}
                            download={message.fileName ?? message.imageName ?? 'image'}
                            aria-label={`下载 ${message.imageName ?? '图片附件'}`}
                            title="下载图片"
                          >
                            <DownloadIcon className="attachment-action-icon-svg" />
                          </a>
                        </div>
                      </div>
                    ) : null}

                    {!message.isRecalled && message.type === 'file' && message.fileUrl ? (
                      <div className="attachment-card file-card">
                        <div className="file-card-main">
                          <div className="file-icon"><FileCardIcon className="file-icon-svg" /></div>
                          <div className="attachment-meta">
                            <strong>{message.fileName ?? '文件附件'}</strong>
                            <span>
                              {message.fileMime ?? '未知类型'} · {formatFileSize(message.fileSize)}
                            </span>
                          </div>
                        </div>
                        <a
                          className="attachment-action-icon file-download-icon"
                          href={message.fileUrl}
                          download={message.fileName ?? 'file'}
                          aria-label={`下载 ${message.fileName ?? '文件附件'}`}
                          title="下载文件"
                        >
                          <DownloadIcon className="attachment-action-icon-svg" />
                        </a>
                      </div>
                    ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            {showMentionJump && latestUnreadMentionId ? (
              <button className="mention-jump-button" type="button" onClick={() => void jumpToUnreadMention()}>
                下一条@你{unreadMentionCount > 1 ? ` · ${unreadMentionCount}` : ''}
              </button>
            ) : null}
            {showScrollToLatest ? (
              <button className="scroll-to-latest-button" type="button" onClick={() => scrollMessageListToLatest()}>
                回到最新
              </button>
            ) : null}
          </div>

          <div
            className={`composer drop-zone ${dragActive ? 'drop-zone-active' : ''}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="drop-hint">可粘贴或拖拽图片 / 文件，先加入待发送区，点击发送后统一发出。</div>
            {uploadProgress !== null ? (
              <div className="upload-progress-card">
                <div className="upload-progress-head">
                  <span>{uploadingFileName ? `正在上传：${uploadingFileName}` : '正在上传附件'}</span>
                  <strong>{uploadProgress}%</strong>
                </div>
                <div className="upload-progress-track" aria-hidden="true">
                  <div className="upload-progress-fill" style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
            ) : null}
            {resendDraftSource ? (
              <div className="composer-resend-banner">
                <div className="composer-resend-copy">
                  <strong>编辑消息中</strong>
                  <span>{resendDraftSource.textContent ?? ''}</span>
                </div>
                <button
                  className="composer-resend-cancel"
                  type="button"
                  onClick={() => {
                    setResendDraftSource(null);
                    setMessageText('');
                    setActiveMentionQuery(null);
                    setActiveMentionIndex(0);
                  }}
                >
                  取消
                </button>
              </div>
            ) : null}
            {replyDraftSource ? (
              <div className="composer-reply-banner">
                <ReplyReferencePreview
                  roomId={roomId}
                  replyContent={buildReplyContentFromMessage(replyDraftSource)}
                  className="composer-reply-reference"
                  onClick={() => void jumpToMessage(replyDraftSource.id, '暂时无法定位原消息，请稍后重试')}
                />
                <button
                  className="composer-reply-close"
                  type="button"
                  aria-label="取消回复"
                  title="取消回复"
                  onClick={() => setReplyDraftMessageId(null)}
                >
                  <CloseIcon className="message-action-icon-svg" />
                </button>
              </div>
            ) : null}
            <div className="composer-row">
              <input
                ref={attachmentInputRef}
                className="hidden-input"
                type="file"
                multiple
                onChange={(event) => queueAttachments(Array.from(event.target.files ?? []))}
              />
              <div className={`composer-input-shell ${composerExpanded ? 'composer-input-shell-expanded' : ''}`}>
                {activeMentionQuery ? (
                  <div className="mention-picker" role="listbox" aria-label="选择要@的成员">
                    {filteredMentionOptions.length > 0 ? (
                      filteredMentionOptions.map((option, index) => (
                        <button
                          key={option.key}
                          className={`mention-picker-item ${index === activeMentionIndex ? 'active' : ''}`}
                          type="button"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            applyMentionOption(option);
                          }}
                        >
                          <strong>{option.label}</strong>
                          <span>{option.type === 'all' ? '提醒当前群组全部成员' : option.ip}</span>
                        </button>
                      ))
                    ) : (
                      <div className="mention-picker-empty">没有匹配的成员</div>
                    )}
                  </div>
                ) : null}
                {pendingAttachments.length > 0 ? (
                  <div className="composer-draft-attachments" aria-label="待发送附件">
                    {pendingAttachments.map((attachment) => (
                      <PendingComposerAttachment
                        key={attachment.id}
                        attachment={attachment}
                        onPreview={setPreview}
                        onRemove={() => void removePendingAttachment(attachment.id)}
                        disabled={sending || attachment.uploadStatus === 'uploading'}
                      />
                    ))}
                  </div>
                ) : null}
                <div className="composer-input-main">
                  <textarea
                    ref={composerTextareaRef}
                    className="composer-input"
                    placeholder="输入消息，也可先粘贴截图、图片或文件；输入 @ 可提及成员，Ctrl+Enter 发送，Enter 换行"
                    value={messageText}
                    onChange={(event) => {
                      const nextText = event.target.value;
                      setMessageText(nextText);
                      syncActiveMentionQuery(nextText, event.target.selectionStart ?? nextText.length);
                    }}
                    onClick={(event) => syncActiveMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
                    onSelect={(event) => syncActiveMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
                    onPaste={(event) => {
                      const files = extractClipboardFiles(event);
                      if (files.length > 0) {
                        event.preventDefault();
                        queueAttachments(files);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (activeMentionQuery && filteredMentionOptions.length > 0) {
                        if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          setActiveMentionIndex((current) => (current + 1) % filteredMentionOptions.length);
                          return;
                        }
                        if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          setActiveMentionIndex((current) => (current - 1 + filteredMentionOptions.length) % filteredMentionOptions.length);
                          return;
                        }
                        if (event.key === 'Enter' || event.key === 'Tab') {
                          event.preventDefault();
                          applyMentionOption(filteredMentionOptions[activeMentionIndex] ?? filteredMentionOptions[0]);
                          return;
                        }
                      }

                      if (activeMentionQuery && event.key === 'Escape') {
                        event.preventDefault();
                        setActiveMentionQuery(null);
                        setActiveMentionIndex(0);
                        return;
                      }

                      if (event.key === 'Enter' && event.ctrlKey) {
                        event.preventDefault();
                        void handleSendMessage();
                      }
                    }}
                  />
                  <button
                    className={`composer-expand-toggle ${composerExpanded ? 'composer-expand-toggle-active' : ''}`}
                    type="button"
                    aria-label={composerExpanded ? '收起输入框' : '展开输入框'}
                    title={composerExpanded ? '收起输入框' : '展开输入框'}
                    onClick={handleToggleComposerExpanded}
                  >
                    {composerExpanded ? (
                      <ComposerCollapseIcon className="composer-expand-toggle-icon" />
                    ) : (
                      <ComposerExpandIcon className="composer-expand-toggle-icon" />
                    )}
                  </button>
                </div>
              </div>
              <div className="composer-actions">
                <button
                  className="composer-hotfix-button composer-package-button"
                  type="button"
                  aria-label="包体分配"
                  title="包体分配"
                  onClick={handleOpenPackageDistributionModal}
                  disabled={sending || fetchingHotfixContent || processingHotfixSelection || fetchingPackageDistributionPreview || sendingPackageDistributionTask}
                >
                  <PackageIcon className="composer-inline-attach-icon" />
                  <span>包体分配</span>
                </button>
                <button
                  className="composer-hotfix-button"
                  type="button"
                  aria-label="获取热更"
                  title="获取热更"
                  onClick={() => void handleFetchHotfix()}
                  disabled={sending || fetchingHotfixContent || processingHotfixSelection}
                >
                  <HotfixIcon className="composer-inline-attach-icon" />
                  <span>{fetchingHotfixContent ? '获取中...' : '获取热更'}</span>
                </button>
                <button
                  className="composer-attach-button"
                  type="button"
                  aria-label="添加附件"
                  title="添加附件"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={sending}
                >
                  <PaperclipIcon className="composer-inline-attach-icon" />
                  <span>添加附件</span>
                </button>
                <button
                  className="primary-button composer-send-button"
                  type="button"
                  onClick={() => void handleSendMessage()}
                  disabled={!canSubmitMessage || sending}
                >
                  {resendDraftSource && messageText.trim().length > 0
                    ? '保存编辑'
                    : (readyAttachmentCount > 0 ? `发送 (${readyAttachmentCount})` : '发送')}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      <AttachmentPreviewModal preview={preview} onClose={() => setPreview(null)} />
      {taskNotifyModal && activeTaskNotifyMessage && taskNotifyConfig ? (
        <TaskNotifyModal
          message={activeTaskNotifyMessage}
          members={taskNotifyConfig.members}
          selectedMemberIds={taskNotifyModal.selectedMemberIds}
          busy={isTaskActionBusy(getTaskNotifyActionKey(activeTaskNotifyMessage.id))}
          onToggleMember={handleToggleTaskNotifyMember}
          onCancel={() => setTaskNotifyModal(null)}
          onConfirm={() => void handleConfirmTaskNotify()}
        />
      ) : null}
      {hotfixPickerModal ? (
        <HotfixVersionPickerModal
          blocks={hotfixPickerModal.versionBlocks}
          selectedVersionLines={hotfixPickerModal.selectedVersionLines}
          refreshedToken={hotfixPickerModal.refreshedToken}
          busy={processingHotfixSelection}
          onToggleVersion={handleToggleHotfixVersion}
          onCancel={() => setHotfixPickerModal(null)}
          onSendText={() => void handleSendSelectedHotfix(false)}
          onSendTask={() => void handleSendSelectedHotfix(true)}
        />
      ) : null}
      {packageDistributionModal ? (
        <PackageDistributionModal
          modal={packageDistributionModal}
          previewBusy={fetchingPackageDistributionPreview}
          sendBusy={sendingPackageDistributionTask}
          onChangeLink={handleChangePackageDistributionLink}
          onAddLink={handleAddPackageDistributionLink}
          onRemoveLink={handleRemovePackageDistributionLink}
          onClearLinks={handleClearPackageDistributionLinks}
          onFetchPreview={() => void handleFetchPackageDistributionPreview()}
          onToggleAssignee={handleTogglePackageDistributionAssignee}
          onCancel={() => setPackageDistributionModal(null)}
          onSend={() => void handleSendPackageDistributionTask()}
        />
      ) : null}
      {adbInstallModal ? (
        <AdbInstallModal
          packageName={adbInstallModal.packageName}
          packageUrl={adbInstallModal.packageUrl}
          devices={adbInstallModal.devices}
          onClose={() => setAdbInstallModal(null)}
        />
      ) : null}
    </AppShell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/server/files" element={<FileCleanupPage />} />
      <Route path="/server/rooms" element={<RoomManagementPage />} />
      <Route path="/server/feishu" element={<FeishuBotSettingsPage />} />
      <Route path="/server/hotfix" element={<HotfixSettingsPage />} />
      <Route path="/server/package-testers" element={<PackageTesterSettingsPage />} />
      <Route path="/rooms/:roomId" element={<RoomPage />} />
    </Routes>
  );
}
