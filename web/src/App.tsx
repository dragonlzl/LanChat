import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { io, type Socket } from 'socket.io-client';
import {
  commitPendingUploads,
  createRoom,
  deletePendingUpload,
  deleteServerFiles,
  dissolveRoom,
  editMessage,
  getMe,
  getMessages,
  getMyRooms,
  getRoom,
  getServerFiles,
  openServerFileFolder,
  joinRoom,
  leaveRoom,
  markRoomRead,
  recallMessage,
  updateMe,
  uploadPendingAttachment,
} from './api';
import type {
  ChatMessage,
  MeResponse,
  MemberEventPayload,
  MemberSummary,
  RoomDissolvedPayload,
  RoomReadState,
  RoomErrorPayload,
  RoomListItem,
  RoomSummary,
  StoredFileItem,
} from './types';

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

const CLEANUP_PASSWORD_STORAGE_KEY = 'webchat_cleanup_password';
const ROOM_VISIT_STORAGE_KEY = 'webchat_recent_room_visits';
const MENTION_SEEN_STORAGE_KEY = 'webchat_seen_mentions_v1';
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

function renderMessageTextWithMentions(text: string): ReactNode {
  const segments = text.split(/(@所有人|@[^\s@]+)/g);
  return segments.map((segment, index) => {
    if (!segment) {
      return null;
    }

    if (segment.startsWith('@')) {
      return <span key={`mention-${index}`} className="mention-inline-token">{segment}</span>;
    }

    return <span key={`text-${index}`}>{segment}</span>;
  });
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

function getRequestErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null;
  }

  const { status } = error as { status?: unknown };
  return typeof status === 'number' ? status : null;
}

const MESSAGE_LIST_BOTTOM_THRESHOLD = 72;

function isMessageListNearBottom(container: HTMLDivElement): boolean {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distance <= MESSAGE_LIST_BOTTOM_THRESHOLD;
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
          <button className="secondary-button" type="button" onClick={onClose}>
            关闭
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
  const [joinRoomId, setJoinRoomId] = useState('');
  const [roomNameInput, setRoomNameInput] = useState('');
  const [nicknameInput, setNicknameInput] = useState('');
  const [cleanupPasswordInput, setCleanupPasswordInput] = useState(() => readStoredCleanupPassword());
  const [roomSearchInput, setRoomSearchInput] = useState('');
  const [roomPage, setRoomPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [nicknameNeedsAttention, setNicknameNeedsAttention] = useState(false);
  useAutoDismissMessage(error, setError);
  useAutoDismissMessage(success, setSuccess);
  const nicknameInputRef = useRef<HTMLInputElement | null>(null);
  const nicknameAttentionTimerRef = useRef<number | null>(null);

  async function loadHome(options?: { silent?: boolean; syncNicknameInput?: boolean }) {
    const silent = Boolean(options?.silent);
    const syncNicknameInput = options?.syncNicknameInput ?? true;

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    try {
      const [meResponse, roomsResponse] = await Promise.all([getMe(), getMyRooms()]);
      setMe(meResponse);
      setRooms(roomsResponse);
      if (syncNicknameInput) {
        setNicknameInput(meResponse.nickname ?? '');
      }
    } catch (requestError) {
      if (!silent) {
        setError(requestError instanceof Error ? requestError.message : '加载主页失败');
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void loadHome();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) {
        void loadHome({ silent: true, syncNicknameInput: false });
      }
    }, 5000);

    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    return () => {
      if (nicknameAttentionTimerRef.current) {
        window.clearTimeout(nicknameAttentionTimerRef.current);
      }
    };
  }, []);

  const visibleRooms = useMemo(() => {
    const recentVisits = readRoomVisitMap();
    const normalizedKeyword = roomSearchInput.trim().toLowerCase();

    const sortedRooms = [...rooms].sort((left, right) => {
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

  useEffect(() => {
    setRoomPage(1);
  }, [roomSearchInput]);

  useEffect(() => {
    if (roomPage > totalRoomPages) {
      setRoomPage(totalRoomPages);
    }
  }, [roomPage, totalRoomPages]);

  function promptSaveNickname(message: string) {
    setSuccess(null);
    setError(message);
    setNicknameNeedsAttention(false);

    window.requestAnimationFrame(() => {
      setNicknameNeedsAttention(true);
      nicknameInputRef.current?.focus();
      nicknameInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    if (nicknameAttentionTimerRef.current) {
      window.clearTimeout(nicknameAttentionTimerRef.current);
    }

    nicknameAttentionTimerRef.current = window.setTimeout(() => {
      setNicknameNeedsAttention(false);
      nicknameAttentionTimerRef.current = null;
    }, 1400);
  }

  async function handleSaveNickname() {
    const nickname = nicknameInput.trim();
    if (!nickname) {
      setError('请输入昵称后再保存');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const meResponse = await updateMe(nickname);
      setMe(meResponse);
      setNicknameInput(meResponse.nickname ?? nickname);
      setNicknameNeedsAttention(false);
      if (nicknameAttentionTimerRef.current) {
        window.clearTimeout(nicknameAttentionTimerRef.current);
        nicknameAttentionTimerRef.current = null;
      }
      setSuccess('昵称已更新');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '昵称更新失败');
    } finally {
      setBusy(false);
    }
  }

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

  async function executeCreateOrJoin(action: 'create' | 'join') {
    const nickname = nicknameInput.trim();
    const savedNickname = me?.nickname?.trim() ?? '';
    const roomName = roomNameInput.trim();
    const hasSavedNickname = Boolean(me?.hasProfile && savedNickname);
    const hasUnsavedNicknameChange = nickname !== savedNickname;

    if (!nickname) {
      promptSaveNickname('请先在主页填写昵称，并点击“保存昵称”后再继续');
      return;
    }

    if (!hasSavedNickname) {
      promptSaveNickname('请先保存昵称后，再创建群组或加入群组');
      return;
    }

    if (hasUnsavedNicknameChange) {
      promptSaveNickname('检测到昵称尚未保存，请先保存昵称后再继续');
      return;
    }

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

  async function handleRoomAction(room: RoomListItem) {
    if (!confirmRoomDangerAction(room.role, room.roomId)) {
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      if (room.role === 'owner') {
        await dissolveRoom(room.roomId);
      } else {
        await leaveRoom(room.roomId);
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
          <h1>局域网聊天</h1>
          <p>同一局域网设备可直接创建群组、加入群组、发送文本、图片和文件。</p>
        </div>
        <div className="status-grid">
          <div className="status-chip">
            <span>当前 IP</span>
            <strong>{me?.ip ?? '--'}</strong>
          </div>
          <div className="status-chip">
            <span>当前昵称</span>
            <strong>{me?.nickname ?? '未设置'}</strong>
          </div>
        </div>
      </header>

      <section className="card-grid card-grid-three">
        <article className="panel-card home-action-card">
          <div className="home-action-copy">
            <h2>昵称</h2>
            <p>这个昵称会在所有群组中复用；首次创建或加入前，需要先在这里保存昵称。</p>
          </div>
          <div className="stack-gap home-action-form">
            <input
              ref={nicknameInputRef}
              className={`text-input ${nicknameNeedsAttention ? 'input-attention-flash' : ''}`}
              maxLength={20}
              placeholder="请输入昵称"
              value={nicknameInput}
              onChange={(event) => setNicknameInput(event.target.value)}
            />
            <button className="primary-button" type="button" onClick={() => void handleSaveNickname()} disabled={loading || busy}>
              保存昵称
            </button>
          </div>
        </article>

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
      </section>

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
                  <div>
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
                    <button className="danger-button" type="button" onClick={() => void handleRoomAction(room)} disabled={busy}>
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

function RoomPage() {
  const navigate = useNavigate();
  const params = useParams();
  const roomId = (params.roomId ?? '').toUpperCase();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState('');
  const [resendDraftSource, setResendDraftSource] = useState<ChatMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useAutoDismissMessage(error, setError);
  const [sending, setSending] = useState(false);
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
  const meRef = useRef<MeResponse | null>(null);
  const loadingOlderMessagesRef = useRef(false);

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
    lastSeenMessageIdRef.current = null;
    lastRequestedReadMessageIdRef.current = null;
    loadingOlderMessagesRef.current = false;
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

  async function jumpToUnreadMention() {
    const targetMessageId = latestUnreadMentionId;
    if (!targetMessageId) {
      return;
    }

    const loaded = await ensureMessageLoaded(targetMessageId);
    if (!loaded) {
      setError('暂时无法定位这条 @ 消息，请稍后重试');
      return;
    }

    window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      const element = container?.querySelector<HTMLElement>(`.message-row[data-message-id="${targetMessageId}"]`);
      if (!element) {
        return;
      }

      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => updateMessageListScrollState(), 220);
    });
  }

  useEffect(() => {
    let cancelled = false;

    async function loadRoomPage() {
      setLoading(true);
      setError(null);
      try {
        const [meResponse, roomResponse, messageResponse] = await Promise.all([getMe(), getRoom(roomId), getMessages(roomId)]);
        if (cancelled) {
          return;
        }
        setMe(meResponse);
        setRoom(roomResponse);
        applyRoomReadState(roomResponse);
        setMessages(messageResponse.items);
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

    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('room:joinLive', { roomId });
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
      if (payload.id >= (latestUnreadMentionIdRef.current ?? 0) || isMessageMentioningCurrentUser(payload, meRef.current)) {
        void refreshRoomReadState().catch(() => undefined);
      }
    });

    socket.on('message:recalled', (payload: ChatMessage) => {
      if (payload.roomId !== roomId) {
        return;
      }
      setMessages((current) => upsertMessage(current, payload));
      setPreview((current) => (current?.sourceKey === `message-${payload.id}` ? null : current));
      setResendDraftSource((current) => (current?.id === payload.id ? null : current));
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
  }, [latestUnreadMentionId, messages, unreadMentionCount]);

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

  function canEditResendMessage(message: ChatMessage): boolean {
    return Boolean(
      me
      && !message.isRecalled
      && message.type === 'text'
      && message.senderIp === me.ip
      && message.textContent?.trim()
      && isWithinRecallWindow(message.createdAt, recallClock),
    );
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
    setActiveMentionQuery(null);
    setActiveMentionIndex(0);
    setError(null);
    focusComposerForEditing(nextText);
  }

  async function handleSendMessage() {
    const normalizedText = messageText.trim();
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
        const mentionPayload = getMessageMentionPayload(normalizedText);
        const updated = await editMessage(roomId, resendDraftSource.id, {
          text: normalizedText,
          mentionAll: mentionPayload.mentionAll,
          mentionedIps: mentionPayload.mentionedIps,
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
      if (pendingAttachmentsRef.current.some((attachment) => attachment.uploadStatus === 'uploading')) {
        setError('附件仍在上传中，上传完成后再点击发送');
      }
      return;
    }

    shouldStickToBottomRef.current = true;
    setShowScrollToLatest(false);
    setSending(true);
    setError(null);
    const failureMessages: string[] = [];

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
        setActiveMentionQuery(null);
        setActiveMentionIndex(0);
      } catch (requestError) {
        failureMessages.push(requestError instanceof Error ? requestError.message : '文本发送失败');
      }
    }

    if (readyAttachments.length > 0) {
      try {
        const result = await commitPendingUploads(
          roomId,
          readyAttachments.map((attachment) => attachment.uploadId as string),
        );
        setMessages((current) => result.items.reduce((next, item) => upsertMessage(next, item), current));

        const sentAttachmentIds = new Set(readyAttachments.map((attachment) => attachment.id));
        readyAttachments.forEach((attachment) => {
          URL.revokeObjectURL(attachment.previewUrl);
          setPreview((current) => (current?.sourceKey === `pending-${attachment.id}` ? null : current));
        });
        updatePendingAttachments((current) => current.filter((item) => !sentAttachmentIds.has(item.id)));
      } catch (requestError) {
        failureMessages.push(requestError instanceof Error ? requestError.message : '附件发送失败');
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
      setPreview((current) => (current?.sourceKey === `message-${recalled.id}` ? null : current));
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

    try {
      await navigator.clipboard.writeText(room.roomId);
    } catch {
      window.prompt('请复制房间 ID', room.roomId);
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
        <FloatingFeedbackToasts error={error} />
        <div className="empty-state full-page">群组加载中…</div>
      </AppShell>
    );
  }

  if (!room) {
    return (
      <AppShell>
        <FloatingFeedbackToasts error={error} />
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
      <FloatingFeedbackToasts error={error} />
      <div className="chat-layout">
        <aside className="sidebar-card">
          <div className="section-head align-start">
            <div>
              <div className="eyebrow">ROOM ID</div>
              <h2>{room.roomId}</h2>
              <p className="room-topic-text">主题：{getDisplayRoomName(room.roomName, room.roomId)}</p>
            </div>
            <button className="secondary-button" type="button" onClick={() => void copyRoomId()}>
              复制
            </button>
          </div>

          <div className="stack-gap">
            <div className="member-highlight">
              <span>当前身份</span>
              <strong>{room.role === 'owner' ? '群主' : '成员'}</strong>
            </div>
            <div className="member-highlight">
              <span>你的昵称</span>
              <strong>{meMember?.nickname ?? me?.nickname ?? '--'}</strong>
            </div>
          </div>

          <section className={`collapsible-panel room-settings-panel desktop-settings-panel ${settingsOpen ? 'expanded' : 'collapsed'}`}>
            <button className="collapsible-trigger" type="button" onClick={() => setSettingsOpen((value) => !value)}>
              <div>
                <h3>房间设置</h3>
                <p>返回主页、退出或解散群组</p>
              </div>
              <span className="collapsible-indicator" aria-hidden="true">{settingsOpen ? '收起' : '展开'}</span>
            </button>
            {settingsOpen ? (
              <div className="settings-menu collapsible-content">
                <button className="danger-button" type="button" onClick={() => void handleDangerAction()} disabled={sending || uploadingCount > 0}>
                  {room.role === 'owner' ? '解散群组' : '退出群组'}
                </button>
                <button className="secondary-button" type="button" onClick={() => navigate('/')}>
                  返回主页
                </button>
              </div>
            ) : null}
          </section>

          <section className={`collapsible-panel members-panel ${membersExpanded ? 'expanded' : 'collapsed'}`}>
            <button className="collapsible-trigger" type="button" onClick={() => setMembersExpanded((value) => !value)}>
              <div>
                <h3>当前成员</h3>
                <p>{room.members.length} 人在线记录</p>
              </div>
              <span className="collapsible-indicator" aria-hidden="true">{membersExpanded ? '收起' : '展开'}</span>
            </button>
            {membersExpanded ? (
              <div className="member-list collapsible-content">
                {room.members.map((member) => (
                  <div key={member.ip} className="member-item">
                    <div>
                      <strong>{member.nickname}</strong>
                      <div className="muted-line">{member.ip}</div>
                    </div>
                    <span className="role-badge">{member.role === 'owner' ? '群主' : '成员'}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </aside>

        <section className="chat-panel">
          <div className="chat-header">
            <div>
              <h1>{getDisplayRoomName(room.roomName, room.roomId)}</h1>
              <p>房间号：{room.roomId} · 支持文本、图片、文件；可直接粘贴附件，或拖拽到输入框区域。</p>
            </div>
            <div className="mobile-chat-toolbar">
              <div className="mobile-room-chip">
                <span>房间号：{room.roomId}</span>
                <strong>{getDisplayRoomName(room.roomName, room.roomId)}</strong>
              </div>
              <section className={`collapsible-panel room-settings-panel mobile-settings-panel ${settingsOpen ? 'expanded' : 'collapsed'}`}>
                <button className="collapsible-trigger" type="button" onClick={() => setSettingsOpen((value) => !value)}>
                  <div>
                    <h3>房间设置</h3>
                    <p>复制房间号、返回主页、退出或解散群组</p>
                  </div>
                  <span className="collapsible-indicator" aria-hidden="true">{settingsOpen ? '收起' : '展开'}</span>
                </button>
                {settingsOpen ? (
                  <div className="settings-menu collapsible-content">
                    <button className="secondary-button" type="button" onClick={() => void copyRoomId()}>
                      复制房间号
                    </button>
                    <button className="danger-button" type="button" onClick={() => void handleDangerAction()} disabled={sending || uploadingCount > 0}>
                      {room.role === 'owner' ? '解散群组' : '退出群组'}
                    </button>
                    <button className="secondary-button" type="button" onClick={() => navigate('/')}>
                      返回主页
                    </button>
                  </div>
                ) : null}
              </section>
            </div>
          </div>

          <div className="message-list-shell">
            <div ref={scrollRef} className="message-list" onScroll={updateMessageListScrollState}>
              {messages.length === 0 ? <div className="empty-state">还没有消息，先发一句吧。</div> : null}

              {messages.map((message) => {
                const isSelf = me?.ip === message.senderIp;
                const canEditResend = canEditResendMessage(message);
                const canRecall = canRecallMessage(message);
                const mentionsCurrentUser = isMessageMentioningCurrentUser(message, me);
                const hasPendingMention = mentionsCurrentUser && !message.isRecalled && message.id > (lastSeenMessageId ?? 0);
                const mentionHint = getMessageMentionHint(message, me, hasPendingMention);
                return (
                  <div key={message.id} data-message-id={message.id} className={`message-row ${isSelf ? 'self' : ''} ${hasPendingMention ? 'mentioned' : ''}`}>
                    <div className={`message-bubble ${hasPendingMention ? 'message-bubble-mentioned' : ''}`}>
                      <div className="message-meta message-meta-top">
                        <div className="message-meta-main">
                          <strong>{message.senderNickname}</strong>
                          <span>{formatDateTime(message.createdAt)}</span>
                        </div>
                        {canEditResend || canRecall ? (
                          <div className="message-actions">
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

                      {message.isRecalled ? (
                        <div className="recalled-message">
                          {getRecalledMessageText(message, room)}
                        </div>
                      ) : null}

                      {!message.isRecalled && message.type === 'text' ? (
                        <>
                          <div className="message-text">{renderMessageTextWithMentions(message.textContent ?? '')}</div>
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
            {pendingAttachments.length > 0 ? (
              <div className="pending-attachments" aria-label="待发送附件">
                {pendingAttachments.map((attachment) => (
                  <div key={attachment.id} className={`pending-attachment-item pending-attachment-item-${attachment.uploadStatus}`}>
                    <button className="pending-attachment-link" type="button" onClick={() => setPreview(toPendingPreview(attachment))}>
                      {attachment.file.name}
                    </button>
                    <span className={`pending-attachment-meta pending-attachment-meta-${attachment.uploadStatus}`}>
                      {getPendingAttachmentStatusLabel(attachment)}
                    </span>
                    <button
                      className="pending-attachment-remove"
                      type="button"
                      aria-label={`移除 ${attachment.file.name}`}
                      title="移除附件"
                      onClick={() => void removePendingAttachment(attachment.id)}
                      disabled={sending || attachment.uploadStatus === 'uploading'}
                    >
                      ×
                    </button>
                  </div>
                ))}
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
            <div className="composer-row">
              <input
                ref={attachmentInputRef}
                className="hidden-input"
                type="file"
                multiple
                onChange={(event) => queueAttachments(Array.from(event.target.files ?? []))}
              />
              <div className="composer-input-shell">
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
                <textarea
                  ref={composerTextareaRef}
                  className="composer-input"
                  placeholder="输入消息，也可先粘贴截图、图片或文件；输入 @ 可提及成员"
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

                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void handleSendMessage();
                    }
                  }}
                />
                <button
                  className="composer-inline-attach"
                  type="button"
                  aria-label="选择附件"
                  title="选择附件"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={sending}
                >
                  <PaperclipIcon className="composer-inline-attach-icon" />
                </button>
              </div>
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
        </section>
      </div>

      <AttachmentPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </AppShell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/server/files" element={<FileCleanupPage />} />
      <Route path="/rooms/:roomId" element={<RoomPage />} />
    </Routes>
  );
}