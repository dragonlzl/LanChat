import type Database from 'better-sqlite3';
import type { HotfixTaskItem, HotfixVersionBlock } from './hotfix-content.js';
import { buildHotfixTaskContentFromBlocks, extractHotfixEntryTaskItems, isHotfixVersionLine, parseHotfixVersionBlocks } from './hotfix-content.js';
import { createRoomId } from './room-id.js';
import { areAllTaskContentItemsCompleted, flattenTaskContentItems, updateTaskContentItemCompletion } from './task-tree.js';
import type {
  ActiveRoomListItem,
  AdminDissolveRoomsResult,
  AttachmentRecordInput,
  AttachmentAccessResult,
  ChatMessage,
  CommitPendingUploadsResult,
  JoinResult,
  ManagedRoomItem,
  MemberEventPayload,
  MessageReplyContent,
  MemberSummary,
  MessagePage,
  MeResponse,
  PendingUploadSummary,
  ProfileUpdateResult,
  RecallResult,
  RichAttachmentAccessResult,
  RichMessageContent,
  RoomAccess,
  RoomListItem,
  RoomReadState,
  RoomSummary,
  StoredFileCleanupResult,
  StoredFileItem,
  TaskMessageItemResource,
  TaskMessageContent,
  TaskMessageGroup,
  TaskMessageItem,
  PackageTaskEntry,
  PackageTaskSectionSource,
  TaskMessageSection,
} from './types.js';

type RoomRow = {
  room_id: string;
  room_name: string | null;
  owner_ip: string;
  role: 'owner' | 'member';
  status: 'active' | 'dissolved';
  created_at: string;
  joined_at: string;
  dissolved_at: string | null;
  last_message_at: string | null;
  last_seen_message_id: number | null;
};

type RoomListRow = RoomRow & {
  member_count: number;
};

type ActiveRoomRow = {
  room_id: string;
  room_name: string | null;
  owner_ip: string;
  role: 'owner' | 'member' | null;
  created_at: string;
  joined_at: string | null;
  last_message_at: string | null;
  last_seen_message_id: number | null;
  member_count: number;
};

type ManagedRoomRow = {
  room_id: string;
  room_name: string | null;
  owner_ip: string;
  status: 'active' | 'dissolved';
  created_at: string;
  dissolved_at: string | null;
  member_count: number;
};

type MemberRow = {
  ip: string;
  nickname: string;
  role: 'owner' | 'member';
  joined_at: string;
};

type MessageRow = {
  id: number;
  room_id: string;
  sender_ip: string;
  sender_nickname: string;
  type: 'text' | 'image' | 'file' | 'rich';
  text_content: string | null;
  file_path: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  is_recalled: number;
  recalled_at: string | null;
  recalled_by_ip: string | null;
  mention_all: number;
  mentioned_ips: string;
  edited_at: string | null;
  task_payload: string | null;
  task_notified_at: string | null;
  reply_payload: string | null;
  rich_payload: string | null;
  created_at: string;
};

type MessageMentionInput = {
  mentionAll?: boolean;
  mentionedIps?: string[];
  replyMessageId?: number;
};

type AccessRow = {
  room_id: string;
  owner_ip: string;
  role: 'owner' | 'member';
  member_ip: string;
  nickname: string;
  room_status: 'active' | 'dissolved';
};

type StoredFileRow = {
  message_id: number;
  room_id: string;
  room_name: string | null;
  sender_ip: string;
  sender_nickname: string;
  type: 'image' | 'file';
  file_path: string;
  file_name: string;
  file_mime: string;
  file_size: number;
  created_at: string;
};

type PendingUploadRow = {
  upload_id: string;
  room_id: string;
  uploader_ip: string;
  type: 'image' | 'file';
  file_path: string;
  file_name: string;
  file_mime: string;
  file_size: number;
  created_at: string;
};

type MentionSummaryRow = {
  unread_count: number;
  latest_unread_mention_id: number | null;
  latest_unread_mention_at: string | null;
};

type StoredRichAttachmentPayload = {
  id: string;
  type: 'image' | 'file';
  fileName: string;
  fileMime: string;
  fileSize: number;
  relativePath: string;
};

type StoredRichMessagePayload = {
  attachments: StoredRichAttachmentPayload[];
};

const ROOM_RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TASK_CONVERT_ERROR_MESSAGE = '该格式无法转换';
const REPLY_PREVIEW_MAX_LENGTH = 72;
const SIMPLE_TASK_SECTION_TITLE = '任务清单';
const SIMPLE_TASK_ASSIGNEE = '未分配';
const SIMPLE_TASK_SHORT_LINE_MAX_LENGTH = 10;
const SIMPLE_TASK_LONG_LINE_MIN_LENGTH = 18;
const SIMPLE_TASK_SENTENCE_PUNCTUATION_REGEX = /[。！？!?；;：:]/u;
const SIMPLE_TASK_TERMINAL_PUNCTUATION_REGEX = /[。！？!?；;：:]$/u;
const SIMPLE_TASK_CONTINUATION_PREFIX_REGEX = /^[,，.。!！?？;；:：、)\]）】》〉]/u;
const SIMPLE_TASK_ORDERED_ITEM_PREFIX_REGEX = /^(?:\d+[.)](?!\d)|\d+、|[（(]\d+[)）])\s*/u;
const SIMPLE_TASK_EXPLICIT_ITEM_PREFIX_REGEX = /^(?:-\s+|\d+[.)](?!\d)\s*|\d+、\s*|[（(]\d+[)）]\s*|[一二三四五六七八九十]+[、.．]\s*)/u;
const ASCII_WORD_END_REGEX = /[A-Za-z0-9]$/u;
const ASCII_WORD_START_REGEX = /^[A-Za-z0-9]/u;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ChatRepository {
  constructor(private readonly database: Database.Database) {}

  getMe(ip: string): MeResponse {
    const row = this.database
      .prepare<[string], { nickname: string }>('SELECT nickname FROM profiles WHERE ip = ?')
      .get(ip);

    return {
      ip,
      hasProfile: Boolean(row),
      nickname: row?.nickname ?? null,
    };
  }

  private now(): string {
    return new Date().toISOString();
  }

  private normalizeNicknameInput(nickname: string | undefined, emptyMessage: string): string {
    const normalizedNickname = (nickname ?? '').trim();
    if (!normalizedNickname) {
      throw new HttpError(400, emptyMessage);
    }

    return normalizedNickname;
  }

  private ensureNicknameAvailable(nickname: string, currentIp?: string): void {
    const existing = this.database
      .prepare<[string], { ip: string }>('SELECT ip FROM profiles WHERE TRIM(nickname) COLLATE NOCASE = ? LIMIT 1')
      .get(nickname);

    if (existing && existing.ip !== currentIp) {
      throw new HttpError(409, '昵称已被其他设备使用，请更换一个昵称');
    }
  }

  private ensureNickname(ip: string, nickname?: string): string {
    const existing = this.database
      .prepare<[string], { nickname: string }>('SELECT nickname FROM profiles WHERE ip = ?')
      .get(ip);

    if (existing) {
      return existing.nickname;
    }

    const normalizedNickname = this.normalizeNicknameInput(nickname, '首次使用需要先填写昵称');
    this.ensureNicknameAvailable(normalizedNickname, ip);

    const timestamp = this.now();
    this.database
      .prepare('INSERT INTO profiles (ip, nickname, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(ip, normalizedNickname, timestamp, timestamp);

    return normalizedNickname;
  }

  updateProfile(ip: string, nickname: string): ProfileUpdateResult {
    const normalizedNickname = this.normalizeNicknameInput(nickname, '昵称不能为空');

    const transaction = this.database.transaction(() => {
      this.ensureNicknameAvailable(normalizedNickname, ip);

      const timestamp = this.now();
      const existing = this.database
        .prepare<[string], { ip: string }>('SELECT ip FROM profiles WHERE ip = ?')
        .get(ip);

      if (existing) {
        this.database
          .prepare('UPDATE profiles SET nickname = ?, updated_at = ? WHERE ip = ?')
          .run(normalizedNickname, timestamp, ip);
      } else {
        this.database
          .prepare('INSERT INTO profiles (ip, nickname, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(ip, normalizedNickname, timestamp, timestamp);
      }

      return {
        me: this.getMe(ip),
        affectedRoomIds: this.listRoomsForMember(ip).map((room) => room.roomId),
      } satisfies ProfileUpdateResult;
    });

    return transaction();
  }

  private requireRoomRow(roomId: string): RoomRow {
    const roomRow = this.database
      .prepare<[string], RoomRow>(`
        SELECT
          rooms.room_id,
          rooms.room_name,
          rooms.owner_ip,
          room_members.role,
          rooms.status,
          rooms.created_at,
          room_members.joined_at,
          rooms.dissolved_at,
          room_members.last_seen_message_id,
          (
            SELECT MAX(messages.created_at)
            FROM messages
            WHERE messages.room_id = rooms.room_id
          ) AS last_message_at
        FROM rooms
        JOIN room_members ON room_members.room_id = rooms.room_id AND room_members.member_ip = rooms.owner_ip
        WHERE rooms.room_id = ?
      `)
      .get(roomId);

    if (!roomRow) {
      throw new HttpError(404, '群组不存在');
    }

    return roomRow;
  }

  private resolveRoomName(roomId: string, roomName: string | null | undefined): string {
    const normalized = (roomName ?? '').trim();
    return normalized || `房间 ${roomId}`;
  }

  private getMemberRows(roomId: string): MemberSummary[] {
    const rows = this.database
      .prepare<[string], MemberRow>(`
        SELECT
          room_members.member_ip AS ip,
          profiles.nickname,
          room_members.role,
          room_members.joined_at
        FROM room_members
        JOIN profiles ON profiles.ip = room_members.member_ip
        WHERE room_members.room_id = ? AND room_members.status = 'active'
        ORDER BY CASE room_members.role WHEN 'owner' THEN 0 ELSE 1 END, room_members.joined_at ASC
      `)
      .all(roomId);

    return rows.map((row: MemberRow) => ({
      ip: row.ip,
      nickname: row.nickname,
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }

  private getRoomMaxMessageId(roomId: string): number | null {
    const row = this.database
      .prepare<[string], { id: number | null }>('SELECT MAX(id) AS id FROM messages WHERE room_id = ?')
      .get(roomId);

    return row?.id ?? null;
  }

  private getUnreadMentionState(roomId: string, ip: string, lastSeenMessageId: number | null | undefined): RoomReadState {
    const row = this.database
      .prepare<[string, number, string, string], MentionSummaryRow>(`
        SELECT
          COUNT(*) AS unread_count,
          MIN(id) AS latest_unread_mention_id,
          MIN(created_at) AS latest_unread_mention_at
        FROM messages
        WHERE room_id = ?
          AND id > ?
          AND is_recalled = 0
          AND sender_ip <> ?
          AND (mention_all = 1 OR instr(mentioned_ips, '"' || ? || '"') > 0)
      `)
      .get(roomId, lastSeenMessageId ?? 0, ip, ip);

    return {
      lastSeenMessageId: lastSeenMessageId ?? null,
      unreadMentionCount: row?.unread_count ?? 0,
      latestUnreadMentionId: row?.latest_unread_mention_id ?? null,
      latestUnreadMentionAt: row?.latest_unread_mention_at ?? null,
    };
  }

  private createEmptyReadState(): RoomReadState {
    return {
      lastSeenMessageId: null,
      unreadMentionCount: 0,
      latestUnreadMentionId: null,
      latestUnreadMentionAt: null,
    };
  }

  private toRoomSummary(roomRow: RoomRow, memberIp: string): RoomSummary {
    const mentionState = this.getUnreadMentionState(roomRow.room_id, memberIp, roomRow.last_seen_message_id);
    const members = this.getMemberRows(roomRow.room_id);

    return {
      roomId: roomRow.room_id,
      roomName: this.resolveRoomName(roomRow.room_id, roomRow.room_name),
      ownerIp: roomRow.owner_ip,
      role: roomRow.role,
      status: roomRow.status,
      createdAt: roomRow.created_at,
      joinedAt: roomRow.joined_at,
      dissolvedAt: roomRow.dissolved_at,
      lastMessageAt: roomRow.last_message_at,
      memberCount: members.length,
      ...mentionState,
      members,
    };
  }

  listRoomsForMember(ip: string): RoomListItem[] {
    const rows = this.database
      .prepare<[string], RoomListRow>(`
        SELECT
          rooms.room_id,
          rooms.room_name,
          rooms.owner_ip,
          room_members.role,
          rooms.status,
          rooms.created_at,
          room_members.joined_at,
          rooms.dissolved_at,
          room_members.last_seen_message_id,
          (
            SELECT MAX(messages.created_at)
            FROM messages
            WHERE messages.room_id = rooms.room_id
          ) AS last_message_at,
          (
            SELECT COUNT(*)
            FROM room_members AS active_members
            WHERE active_members.room_id = rooms.room_id AND active_members.status = 'active'
          ) AS member_count
        FROM room_members
        JOIN rooms ON rooms.room_id = room_members.room_id
        WHERE room_members.member_ip = ?
          AND room_members.status = 'active'
          AND rooms.status = 'active'
        ORDER BY room_members.joined_at DESC, COALESCE(last_message_at, rooms.created_at) DESC, rooms.created_at DESC
      `)
      .all(ip);

    return rows.map((row: RoomListRow) => ({
      roomId: row.room_id,
      roomName: this.resolveRoomName(row.room_id, row.room_name),
      ownerIp: row.owner_ip,
      role: row.role,
      createdAt: row.created_at,
      joinedAt: row.joined_at,
      lastMessageAt: row.last_message_at,
      memberCount: row.member_count,
      ...this.getUnreadMentionState(row.room_id, ip, row.last_seen_message_id),
    }));
  }

  listActiveRooms(ip: string): ActiveRoomListItem[] {
    const rows = this.database
      .prepare<[string], ActiveRoomRow>(`
        SELECT
          rooms.room_id,
          rooms.room_name,
          rooms.owner_ip,
          my_membership.role,
          rooms.created_at,
          my_membership.joined_at,
          my_membership.last_seen_message_id,
          (
            SELECT MAX(messages.created_at)
            FROM messages
            WHERE messages.room_id = rooms.room_id
          ) AS last_message_at,
          (
            SELECT COUNT(*)
            FROM room_members AS active_members
            WHERE active_members.room_id = rooms.room_id AND active_members.status = 'active'
          ) AS member_count
        FROM rooms
        LEFT JOIN room_members AS my_membership
          ON my_membership.room_id = rooms.room_id
          AND my_membership.member_ip = ?
          AND my_membership.status = 'active'
        WHERE rooms.status = 'active'
        ORDER BY COALESCE(last_message_at, rooms.created_at) DESC, member_count DESC, rooms.created_at DESC
      `)
      .all(ip);

    return rows.map((row: ActiveRoomRow) => {
      const readState = row.role ? this.getUnreadMentionState(row.room_id, ip, row.last_seen_message_id) : this.createEmptyReadState();

      return {
        roomId: row.room_id,
        roomName: this.resolveRoomName(row.room_id, row.room_name),
        ownerIp: row.owner_ip,
        role: row.role,
        createdAt: row.created_at,
        joinedAt: row.joined_at,
        lastMessageAt: row.last_message_at,
        memberCount: row.member_count,
        ...readState,
      } satisfies ActiveRoomListItem;
    });
  }

  private getManagedRoomRow(roomId: string): ManagedRoomRow | null {
    return (
      this.database
        .prepare<[string], ManagedRoomRow>(`
          SELECT
            rooms.room_id,
            rooms.room_name,
            rooms.owner_ip,
            rooms.status,
            rooms.created_at,
            rooms.dissolved_at,
            (
              SELECT COUNT(*)
              FROM room_members AS active_members
              WHERE active_members.room_id = rooms.room_id AND active_members.status = 'active'
            ) AS member_count
          FROM rooms
          WHERE rooms.room_id = ?
        `)
        .get(roomId) ?? null
    );
  }

  private requireManagedRoomRow(roomId: string): ManagedRoomRow {
    const room = this.getManagedRoomRow(roomId);
    if (!room) {
      throw new HttpError(404, '房间不存在');
    }

    return room;
  }

  private toManagedRoomItem(roomRow: ManagedRoomRow): ManagedRoomItem {
    const dissolvedAtMs = roomRow.dissolved_at ? Date.parse(roomRow.dissolved_at) : NaN;
    const restoreExpiresAt = Number.isFinite(dissolvedAtMs) ? new Date(dissolvedAtMs + ROOM_RESTORE_WINDOW_MS).toISOString() : null;
    const canRestore =
      roomRow.status === 'dissolved'
      && Number.isFinite(dissolvedAtMs)
      && dissolvedAtMs + ROOM_RESTORE_WINDOW_MS >= Date.now();

    return {
      roomId: roomRow.room_id,
      roomName: this.resolveRoomName(roomRow.room_id, roomRow.room_name),
      ownerIp: roomRow.owner_ip,
      createdAt: roomRow.created_at,
      status: roomRow.status,
      dissolvedAt: roomRow.dissolved_at,
      restoreExpiresAt,
      canRestore,
      memberCount: roomRow.member_count,
    } satisfies ManagedRoomItem;
  }

  listManagedRooms(): ManagedRoomItem[] {
    const rows = this.database
      .prepare<[], ManagedRoomRow>(`
        SELECT
          rooms.room_id,
          rooms.room_name,
          rooms.owner_ip,
          rooms.status,
          rooms.created_at,
          rooms.dissolved_at,
          (
            SELECT COUNT(*)
            FROM room_members AS active_members
            WHERE active_members.room_id = rooms.room_id AND active_members.status = 'active'
          ) AS member_count
        FROM rooms
        ORDER BY rooms.created_at DESC, rooms.room_id DESC
      `)
      .all();

    return rows.map((row: ManagedRoomRow) => this.toManagedRoomItem(row));
  }

  adminDissolveRooms(roomIds: string[]): AdminDissolveRoomsResult {
    const normalizedIds = Array.from(
      new Set(
        roomIds
          .filter((value) => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim().toUpperCase()),
      ),
    );

    if (normalizedIds.length === 0) {
      throw new HttpError(400, '请选择要解散的房间');
    }

    const placeholders = normalizedIds.map(() => '?').join(', ');
    const transaction = this.database.transaction(() => {
      const activeRooms = this.database
        .prepare<unknown[], { room_id: string }>(`SELECT room_id FROM rooms WHERE room_id IN (${placeholders}) AND status = 'active'`)
        .all(...normalizedIds);

      if (activeRooms.length === 0) {
        return {
          dissolvedRooms: [],
          dissolvedCount: 0,
          skippedCount: normalizedIds.length,
        } satisfies AdminDissolveRoomsResult;
      }

      const timestamp = this.now();
      const activeRoomIds = activeRooms.map((room) => room.room_id);
      const activePlaceholders = activeRoomIds.map(() => '?').join(', ');
      this.database
        .prepare<unknown[]>(`UPDATE rooms SET status = 'dissolved', dissolved_at = ? WHERE room_id IN (${activePlaceholders}) AND status = 'active'`)
        .run(timestamp, ...activeRoomIds);

      return {
        dissolvedRooms: activeRoomIds.map((roomId) => ({ roomId, dissolvedAt: timestamp })),
        dissolvedCount: activeRoomIds.length,
        skippedCount: normalizedIds.length - activeRoomIds.length,
      } satisfies AdminDissolveRoomsResult;
    });

    return transaction();
  }

  restoreManagedRoom(roomId: string): ManagedRoomItem {
    const normalizedRoomId = roomId.trim().toUpperCase();
    if (!normalizedRoomId) {
      throw new HttpError(400, '无效的房间号');
    }

    const transaction = this.database.transaction(() => {
      const room = this.requireManagedRoomRow(normalizedRoomId);
      if (room.status !== 'dissolved') {
        throw new HttpError(409, '房间当前未解散，无需恢复');
      }

      const dissolvedAtMs = room.dissolved_at ? Date.parse(room.dissolved_at) : NaN;
      if (!Number.isFinite(dissolvedAtMs) || dissolvedAtMs + ROOM_RESTORE_WINDOW_MS < Date.now()) {
        throw new HttpError(410, '该房间已超过 24 小时恢复期，无法恢复');
      }

      this.database
        .prepare('UPDATE rooms SET status = ?, dissolved_at = NULL WHERE room_id = ?')
        .run('active', normalizedRoomId);

      return this.toManagedRoomItem({ ...room, status: 'active', dissolved_at: null });
    });

    return transaction();
  }

  private generateUniqueRoomId(): string {
    for (let index = 0; index < 10; index += 1) {
      const roomId = createRoomId();
      const row = this.database
        .prepare<[string], { room_id: string }>('SELECT room_id FROM rooms WHERE room_id = ?')
        .get(roomId);
      if (!row) {
        return roomId;
      }
    }

    throw new Error('Failed to generate unique room id');
  }

  createRoom(ip: string, roomName: string, nickname?: string): RoomSummary {
    const transaction = this.database.transaction(() => {
      const normalizedRoomName = roomName.trim();
      if (!normalizedRoomName) {
        throw new HttpError(400, '房间主题不能为空');
      }

      this.ensureNickname(ip, nickname);
      const roomId = this.generateUniqueRoomId();
      const timestamp = this.now();

      this.database
        .prepare('INSERT INTO rooms (room_id, room_name, owner_ip, status, created_at, dissolved_at) VALUES (?, ?, ?, ?, ?, NULL)')
        .run(roomId, normalizedRoomName, ip, 'active', timestamp);

      this.database
        .prepare(
          'INSERT INTO room_members (room_id, member_ip, role, status, joined_at, left_at, last_seen_message_id) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
        )
        .run(roomId, ip, 'owner', 'active', timestamp);

      return this.getRoom(roomId, ip);
    });

    return transaction();
  }

  joinRoom(roomId: string, ip: string, nickname?: string): JoinResult {
    const transaction = this.database.transaction(() => {
      this.ensureNickname(ip, nickname);
      const room = this.requireRoomRow(roomId);
      if (room.status !== 'active') {
        throw new HttpError(410, '群组已解散');
      }

      const existing = this.database
        .prepare<[string, string], { status: 'active' | 'left'; role: 'owner' | 'member' }>(
          'SELECT status, role FROM room_members WHERE room_id = ? AND member_ip = ?',
        )
        .get(roomId, ip);

      let joined = false;
      const timestamp = this.now();
      const currentRoomMaxMessageId = this.getRoomMaxMessageId(roomId);

      if (!existing) {
        this.database
          .prepare(
            'INSERT INTO room_members (room_id, member_ip, role, status, joined_at, left_at, last_seen_message_id) VALUES (?, ?, ?, ?, ?, NULL, ?)',
          )
          .run(roomId, ip, 'member', 'active', timestamp, currentRoomMaxMessageId);
        joined = true;
      } else if (existing.status === 'left') {
        if (existing.role === 'owner') {
          throw new HttpError(409, '群主不能重新加入已解散或退出的房间');
        }

        this.database
          .prepare('UPDATE room_members SET status = ?, joined_at = ?, left_at = NULL, last_seen_message_id = ? WHERE room_id = ? AND member_ip = ?')
          .run('active', timestamp, currentRoomMaxMessageId, roomId, ip);
        joined = true;
      }

      return {
        room: this.getRoom(roomId, ip),
        joined,
      } satisfies JoinResult;
    });

    return transaction();
  }

  getRoomAccess(roomId: string, ip: string): RoomAccess {
    const row = this.database
      .prepare<[string, string], AccessRow>(`
        SELECT
          rooms.room_id,
          rooms.room_name,
          rooms.owner_ip,
          room_members.role,
          room_members.member_ip,
          profiles.nickname,
          rooms.status AS room_status
        FROM rooms
        JOIN room_members ON room_members.room_id = rooms.room_id
        JOIN profiles ON profiles.ip = room_members.member_ip
        WHERE rooms.room_id = ? AND room_members.member_ip = ? AND room_members.status = 'active'
      `)
      .get(roomId, ip);

    if (!row) {
      throw new HttpError(404, '未找到当前群组或你不在群组中');
    }

    return {
      roomId: row.room_id,
      ownerIp: row.owner_ip,
      role: row.role,
      memberIp: row.member_ip,
      nickname: row.nickname,
      roomStatus: row.room_status,
    };
  }

  getRoom(roomId: string, ip: string): RoomSummary {
    const access = this.getRoomAccess(roomId, ip);
    if (access.roomStatus !== 'active') {
      throw new HttpError(410, '群组已解散');
    }

    const row = this.database
      .prepare<[string, string], RoomRow>(`
        SELECT
          rooms.room_id,
          rooms.room_name,
          rooms.owner_ip,
          room_members.role,
          rooms.status,
          rooms.created_at,
          room_members.joined_at,
          rooms.dissolved_at,
          room_members.last_seen_message_id,
          (
            SELECT MAX(messages.created_at)
            FROM messages
            WHERE messages.room_id = rooms.room_id
          ) AS last_message_at
        FROM rooms
        JOIN room_members ON room_members.room_id = rooms.room_id
        WHERE rooms.room_id = ? AND room_members.member_ip = ? AND room_members.status = 'active'
      `)
      .get(roomId, ip);

    if (!row) {
      throw new HttpError(404, '群组不存在');
    }

    return this.toRoomSummary(row, ip);
  }

  leaveRoom(roomId: string, ip: string): MemberSummary {
    const transaction = this.database.transaction(() => {
      const access = this.getRoomAccess(roomId, ip);

      if (access.roomStatus !== 'active') {
        throw new HttpError(410, '群组已解散');
      }

      if (access.role === 'owner') {
        throw new HttpError(409, '群主不能退出群组，只能解散群组');
      }

      const timestamp = this.now();
      this.database
        .prepare('UPDATE room_members SET status = ?, left_at = ? WHERE room_id = ? AND member_ip = ?')
        .run('left', timestamp, roomId, ip);

      return {
        ip,
        nickname: access.nickname,
        role: access.role,
        joinedAt: timestamp,
      } satisfies MemberSummary;
    });

    return transaction();
  }

  dissolveRoom(roomId: string, ip: string): RoomSummary {
    const transaction = this.database.transaction(() => {
      const access = this.getRoomAccess(roomId, ip);
      if (access.role !== 'owner') {
        throw new HttpError(403, '只有群主可以解散群组');
      }

      const timestamp = this.now();
      this.database
        .prepare('UPDATE rooms SET status = ?, dissolved_at = ? WHERE room_id = ?')
        .run('dissolved', timestamp, roomId);

      const room = this.requireRoomRow(roomId);
      return this.toRoomSummary({ ...room, status: 'dissolved', dissolved_at: timestamp }, ip);
    });

    return transaction();
  }

  private requireActiveAccess(roomId: string, ip: string): RoomAccess {
    const access = this.getRoomAccess(roomId, ip);
    if (access.roomStatus !== 'active') {
      throw new HttpError(410, '群组已解散');
    }

    return access;
  }

  private parseMentionedIps(value: string | null | undefined): string[] {
    if (!value) {
      return [];
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    } catch {
      return [];
    }
  }

  private truncateReplyPreview(text: string): string {
    const normalized = text.trim();
    if (normalized.length <= REPLY_PREVIEW_MAX_LENGTH) {
      return normalized;
    }

    return `${normalized.slice(0, REPLY_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
  }

  private summarizeReplyPreview(message: MessageRow): string {
    if (message.type === 'text' || message.type === 'rich') {
      const normalized = (message.text_content ?? '').replace(/\s+/g, ' ').trim();
      if (normalized) {
        return this.truncateReplyPreview(normalized);
      }

      if (message.type === 'rich') {
        const richPayload = this.parseStoredRichPayload(message.rich_payload);
        const firstAttachment = richPayload?.attachments[0];
        if (firstAttachment) {
          return this.truncateReplyPreview(firstAttachment.fileName.trim() || '富文本消息');
        }

        return '富文本消息';
      }

      return '文本消息';
    }

    if (message.type === 'image') {
      return this.truncateReplyPreview((message.file_name ?? '').trim() || '图片消息');
    }

    return this.truncateReplyPreview((message.file_name ?? '').trim() || '文件附件');
  }

  private parseReplyPayload(value: string | null | undefined): MessageReplyContent | null {
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }

      const { messageId, senderNickname, messageType, previewText } = parsed as {
        messageId?: unknown;
        senderNickname?: unknown;
        messageType?: unknown;
        previewText?: unknown;
      };

      if (
        !Number.isInteger(messageId)
        || Number(messageId) <= 0
        || typeof senderNickname !== 'string'
        || senderNickname.trim().length === 0
        || (messageType !== 'text' && messageType !== 'image' && messageType !== 'file' && messageType !== 'rich')
        || typeof previewText !== 'string'
        || previewText.trim().length === 0
      ) {
        return null;
      }

      return {
        messageId: Number(messageId),
        senderNickname,
        messageType,
        previewText,
      };
    } catch {
      return null;
    }
  }

  private buildReplyPayload(roomId: string, replyMessageId: number | undefined): MessageReplyContent | null {
    if (replyMessageId === undefined) {
      return null;
    }

    if (!Number.isInteger(replyMessageId) || replyMessageId <= 0) {
      throw new HttpError(400, '无效的回复消息 ID');
    }

    const targetMessage = this.getMessageRow(roomId, replyMessageId);
    if (targetMessage.is_recalled === 1) {
      throw new HttpError(409, '原消息已撤回，无法回复');
    }

    return {
      messageId: targetMessage.id,
      senderNickname: targetMessage.sender_nickname,
      messageType: targetMessage.type,
      previewText: this.summarizeReplyPreview(targetMessage),
    };
  }

  private parseStoredRichPayload(value: string | null | undefined): StoredRichMessagePayload | null {
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }

      const attachments = (parsed as { attachments?: unknown }).attachments;
      if (!Array.isArray(attachments) || attachments.length === 0) {
        return null;
      }

      const normalizedAttachments: StoredRichAttachmentPayload[] = [];
      for (const attachment of attachments) {
        if (typeof attachment !== 'object' || attachment === null) {
          return null;
        }

        const {
          id,
          type,
          fileName,
          fileMime,
          fileSize,
          relativePath,
        } = attachment as {
          id?: unknown;
          type?: unknown;
          fileName?: unknown;
          fileMime?: unknown;
          fileSize?: unknown;
          relativePath?: unknown;
        };

        if (
          typeof id !== 'string'
          || id.trim().length === 0
          || (type !== 'image' && type !== 'file')
          || typeof fileName !== 'string'
          || fileName.trim().length === 0
          || typeof fileMime !== 'string'
          || fileMime.trim().length === 0
          || !Number.isInteger(fileSize)
          || Number(fileSize) <= 0
          || typeof relativePath !== 'string'
          || relativePath.trim().length === 0
        ) {
          return null;
        }

        normalizedAttachments.push({
          id,
          type,
          fileName,
          fileMime,
          fileSize: Number(fileSize),
          relativePath,
        });
      }

      return {
        attachments: normalizedAttachments,
      };
    } catch {
      return null;
    }
  }

  private toRichMessageContent(row: MessageRow): RichMessageContent | null {
    const payload = this.parseStoredRichPayload(row.rich_payload);
    if (!payload) {
      return null;
    }

    return {
      attachments: payload.attachments.map((attachment) => {
        const baseUrl = `/api/rooms/${row.room_id}/messages/${row.id}/rich/${attachment.id}`;
        return {
          id: attachment.id,
          type: attachment.type,
          fileName: attachment.fileName,
          fileMime: attachment.fileMime,
          fileSize: attachment.fileSize,
          fileUrl: `${baseUrl}/download`,
          imageUrl: attachment.type === 'image' ? `${baseUrl}/content` : null,
        };
      }),
    };
  }

  private isValidHttpUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private normalizeTaskItemResource(value: unknown): TaskMessageItemResource | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const resource = value as Partial<TaskMessageItemResource>;
    const kind = resource.kind === 'remote-package-file' ? resource.kind : null;
    const sourceUrl = typeof resource.sourceUrl === 'string' ? resource.sourceUrl.trim() : '';
    const fileUrl = typeof resource.fileUrl === 'string' ? resource.fileUrl.trim() : '';
    const fileName = typeof resource.fileName === 'string' ? resource.fileName.trim() : '';
    const filePath = typeof resource.filePath === 'string' ? resource.filePath.trim() : '';

    if (!kind || !sourceUrl || !fileUrl || !fileName || !filePath) {
      return null;
    }
    if (!this.isValidHttpUrl(sourceUrl) || !this.isValidHttpUrl(fileUrl)) {
      return null;
    }

    return {
      kind,
      sourceUrl,
      fileUrl,
      fileName,
      filePath,
    };
  }

  private normalizePackageTaskEntries(value: unknown): PackageTaskEntry[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const entries: PackageTaskEntry[] = [];
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }

      const record = entry as Partial<PackageTaskEntry>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      const entryType = record.entryType === 'file' || record.entryType === 'directory' ? record.entryType : null;
      const url = typeof record.url === 'string' ? record.url.trim() : '';

      if (!id || !name || !path || !entryType || !url || !this.isValidHttpUrl(url)) {
        return null;
      }

      entries.push({
        id,
        name,
        path,
        entryType,
        url,
      });
    }

    return entries;
  }

  private normalizePackageTaskSource(value: unknown): PackageTaskSectionSource | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const source = value as Partial<PackageTaskSectionSource>;
    const sourceUrl = typeof source.sourceUrl === 'string' ? source.sourceUrl.trim() : '';
    const entries = this.normalizePackageTaskEntries(source.entries);

    if (!sourceUrl || !this.isValidHttpUrl(sourceUrl) || entries === null) {
      return null;
    }

    return {
      sourceUrl,
      entries,
    };
  }

  private normalizeTaskItems(value: unknown): TaskMessageItem[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const normalizedItems: TaskMessageItem[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) {
        return null;
      }

      const {
        id: itemId,
        text,
        completed,
        completedByNickname: rawCompletedByNickname,
        changed: rawChanged,
        resource: rawResource,
        children: rawChildren,
      } = item as {
        id?: unknown;
        text?: unknown;
        completed?: unknown;
        completedByNickname?: unknown;
        changed?: unknown;
        resource?: unknown;
        children?: unknown;
      };
      if (typeof itemId !== 'string' || typeof text !== 'string' || text.trim().length === 0 || typeof completed !== 'boolean') {
        return null;
      }

      const completedByNickname =
        typeof rawCompletedByNickname === 'string' && rawCompletedByNickname.trim().length > 0
          ? rawCompletedByNickname.trim()
          : null;
      const changed = typeof rawChanged === 'boolean' ? rawChanged : false;
      const resource = this.normalizeTaskItemResource(rawResource);
      if (rawResource !== undefined && rawResource !== null && !resource) {
        return null;
      }

      const children =
        rawChildren === undefined
          ? undefined
          : this.normalizeTaskItems(rawChildren);
      if (rawChildren !== undefined && !children) {
        return null;
      }

      normalizedItems.push({
        id: itemId,
        text,
        completed,
        completedByNickname: completed ? completedByNickname : null,
        changed,
        resource,
        ...(children && children.length > 0 ? { children } : {}),
      });
    }

    return normalizedItems.length > 0 ? normalizedItems : null;
  }

  private normalizeTaskGroups(value: unknown): TaskMessageGroup[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const normalizedGroups: TaskMessageGroup[] = [];
    for (const group of value) {
      if (typeof group !== 'object' || group === null) {
        return null;
      }

      const { id, assignee, items } = group as { id?: unknown; assignee?: unknown; items?: unknown };
      if (typeof id !== 'string' || typeof assignee !== 'string' || assignee.trim().length === 0 || !Array.isArray(items)) {
        return null;
      }

      const normalizedItems = this.normalizeTaskItems(items);
      if (!normalizedItems || normalizedItems.length === 0) {
        return null;
      }

      normalizedGroups.push({
        id,
        assignee,
        items: normalizedItems,
      });
    }

    return normalizedGroups.length > 0 ? normalizedGroups : null;
  }

  private normalizeTaskContentValue(value: unknown): TaskMessageContent | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const parsedRecord = value as { kind?: unknown; sections?: unknown; title?: unknown; groups?: unknown };
    const normalizedSections: TaskMessageSection[] = [];
    const kind = parsedRecord.kind === 'package-distribution' ? 'package-distribution' : 'standard';

    if (Array.isArray(parsedRecord.sections)) {
      for (const section of parsedRecord.sections) {
        if (typeof section !== 'object' || section === null) {
          return null;
        }

        const { id, title, groups, packageSource: rawPackageSource } = section as {
          id?: unknown;
          title?: unknown;
          groups?: unknown;
          packageSource?: unknown;
        };
        if (typeof id !== 'string' || typeof title !== 'string' || title.trim().length === 0) {
          return null;
        }

        const normalizedGroups = this.normalizeTaskGroups(groups);
        const packageSource = this.normalizePackageTaskSource(rawPackageSource);
        if (!normalizedGroups) {
          return null;
        }
        if (rawPackageSource !== undefined && rawPackageSource !== null && !packageSource) {
          return null;
        }

        normalizedSections.push({
          id,
          title,
          groups: normalizedGroups,
          packageSource,
        });
      }
    } else if (typeof parsedRecord.title === 'string') {
      const normalizedGroups = this.normalizeTaskGroups(parsedRecord.groups);
      if (!normalizedGroups || parsedRecord.title.trim().length === 0) {
        return null;
      }

      normalizedSections.push({
        id: 'section-1',
        title: parsedRecord.title,
        groups: normalizedGroups,
        packageSource: null,
      });
    }

    return normalizedSections.length > 0
      ? { kind, sections: normalizedSections }
      : null;
  }

  private parseTaskPayload(value: string | null | undefined): TaskMessageContent | null {
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      return this.normalizeTaskContentValue(parsed);
    } catch {
      return null;
    }
  }

  private parseTaskContentFromText(textContent: string): TaskMessageContent {
    const rawLines = textContent
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    const lines = rawLines.map((line) => line.trim());

    if (lines.length === 0) {
      throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
    }

    const hotfixTaskContent = this.parseHotfixTaskContentFromRawText(textContent);
    if (hotfixTaskContent) {
      return hotfixTaskContent;
    }

    const looksLikeStructuredTask = lines.some((line) => /^@/.test(line));
    if (looksLikeStructuredTask) {
      return this.parseStructuredTaskContentFromLines(rawLines);
    }

    const explicitDefaultTaskContent = this.parseExplicitSimpleTaskContentFromLines(rawLines);
    if (explicitDefaultTaskContent) {
      return explicitDefaultTaskContent;
    }

    const simpleTaskContent = this.parseSimpleTaskContentFromLines(rawLines);
    if (simpleTaskContent) {
      return simpleTaskContent;
    }

    throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
  }

  private parseHotfixTaskContentFromRawText(textContent: string): TaskMessageContent | null {
    const versionBlocks = parseHotfixVersionBlocks(textContent);
    if (versionBlocks.length === 0) {
      return null;
    }

    const hasImplicitTaskLines = versionBlocks.some((block) =>
      block.entries.some((entry) => entry.contentLines.some((line) => !/^\s*-\s+/.test(line))),
    );
    if (!hasImplicitTaskLines) {
      return null;
    }

    return this.buildTaskContentFromHotfixVersionBlocks(versionBlocks);
  }

  private buildTaskContentFromHotfixVersionBlocks(versionBlocks: HotfixVersionBlock[]): TaskMessageContent | null {
    const sections: TaskMessageSection[] = [];
    let sectionIndex = 0;
    let groupIndex = 0;
    let itemIndex = 0;

    for (const block of versionBlocks) {
      const groups: TaskMessageGroup[] = [];

      for (const entry of block.entries) {
        const assignee = entry.assigneeLine.replace(/^@\s*/, '').trim();
        const items = extractHotfixEntryTaskItems(entry.contentLines);
        if (!assignee || items.length === 0) {
          continue;
        }

        groups.push({
          id: `group-${++groupIndex}`,
          assignee,
          items: this.createTaskItemsFromHotfixItems(items, () => `task-${++itemIndex}`),
        });
      }

      if (groups.length === 0) {
        continue;
      }

      sections.push({
        id: `section-${++sectionIndex}`,
        title: block.versionLine,
        groups,
      });
    }

    return sections.length > 0 ? { sections } : null;
  }

  private createTaskItemsFromHotfixItems(items: HotfixTaskItem[], createId: () => string): TaskMessageItem[] {
    return items.map((item) => ({
      id: createId(),
      text: item.text,
      completed: false,
      completedByNickname: null,
      changed: false,
      ...(item.children && item.children.length > 0
        ? { children: this.createTaskItemsFromHotfixItems(item.children, createId) }
        : {}),
    }));
  }

  private parseExplicitSimpleTaskContentFromLines(rawLines: string[]): TaskMessageContent | null {
    if (rawLines.length === 0) {
      return null;
    }

    const hasExplicitTaskSyntax = rawLines.some((line) => SIMPLE_TASK_EXPLICIT_ITEM_PREFIX_REGEX.test(line.trim()));
    if (!hasExplicitTaskSyntax) {
      return null;
    }

    const taskItems = extractHotfixEntryTaskItems(rawLines);
    if (taskItems.length === 0) {
      return null;
    }

    let itemIndex = 0;
    return {
      sections: [
        {
          id: 'section-1',
          title: SIMPLE_TASK_SECTION_TITLE,
          groups: [
            {
              id: 'group-1',
              assignee: SIMPLE_TASK_ASSIGNEE,
              items: this.createTaskItemsFromHotfixItems(taskItems, () => `task-${++itemIndex}`),
            },
          ],
        },
      ],
    };
  }

  private preserveTaskItemsCompletionState(
    sectionTitle: string,
    assignee: string,
    items: TaskMessageItem[],
    previousItemsByKey: Map<string, TaskMessageItem[]>,
    parentPath: string[] = [],
  ): TaskMessageItem[] {
    return items.map((item) => {
      const path = [...parentPath, item.text];
      const matchedItem = previousItemsByKey.get(this.buildTaskItemRefreshKey(sectionTitle, assignee, path))?.shift();
      const children = item.children
        ? this.preserveTaskItemsCompletionState(sectionTitle, assignee, item.children, previousItemsByKey, path)
        : undefined;
      if (!matchedItem) {
        return {
          ...item,
          ...(children ? { children } : {}),
        };
      }

      return {
        ...item,
        completed: matchedItem.completed,
        completedByNickname: matchedItem.completed ? matchedItem.completedByNickname : null,
        changed: matchedItem.changed,
        ...(children ? { children } : {}),
      };
    });
  }

  private preserveTaskItemCompletionState(
    previousTaskContent: TaskMessageContent,
    nextTaskContent: TaskMessageContent,
  ): TaskMessageContent {
    const previousItemsByKey = new Map<string, TaskMessageItem[]>();

    for (const { item, sectionTitle, assignee, path } of flattenTaskContentItems(previousTaskContent)) {
      const key = this.buildTaskItemRefreshKey(sectionTitle, assignee, path);
      const queue = previousItemsByKey.get(key);
      if (queue) {
        queue.push(item);
        continue;
      }

      previousItemsByKey.set(key, [item]);
    }

    return {
      ...nextTaskContent,
      sections: nextTaskContent.sections.map((section) => ({
        ...section,
        groups: section.groups.map((group) => ({
          ...group,
          items: this.preserveTaskItemsCompletionState(section.title, group.assignee, group.items, previousItemsByKey),
        })),
      })),
    };
  }

  private buildTaskItemRefreshKey(sectionTitle: string, assignee: string, path: string[]): string {
    return [sectionTitle, assignee, ...path].join('\u0000');
  }

  private applyHotfixRefreshItemsState(
    sectionTitle: string,
    assignee: string,
    items: TaskMessageItem[],
    previousItemsByKey: Map<string, TaskMessageItem[]>,
    parentPath: string[] = [],
  ): TaskMessageItem[] {
    return items.map((item) => {
      const path = [...parentPath, item.text];
      const children = item.children
        ? this.applyHotfixRefreshItemsState(sectionTitle, assignee, item.children, previousItemsByKey, path)
        : undefined;
      const key = this.buildTaskItemRefreshKey(sectionTitle, assignee, path);
      const matchedItem = previousItemsByKey.get(key)?.shift();
      if (!matchedItem) {
        return {
          ...item,
          completed: false,
          completedByNickname: null,
          changed: true,
          ...(children ? { children } : {}),
        };
      }

      return {
        ...item,
        completed: matchedItem.completed,
        completedByNickname: matchedItem.completed ? matchedItem.completedByNickname : null,
        changed: false,
        ...(children ? { children } : {}),
      };
    });
  }

  private applyHotfixRefreshState(
    previousTaskContent: TaskMessageContent,
    nextTaskContent: TaskMessageContent,
  ): TaskMessageContent {
    const previousItemsByKey = new Map<string, TaskMessageItem[]>();

    for (const { item, sectionTitle, assignee, path } of flattenTaskContentItems(previousTaskContent)) {
      const key = this.buildTaskItemRefreshKey(sectionTitle, assignee, path);
      const queue = previousItemsByKey.get(key);
      if (queue) {
        queue.push(item);
        continue;
      }

      previousItemsByKey.set(key, [item]);
    }

    return {
      ...nextTaskContent,
      sections: nextTaskContent.sections.map((section) => ({
        ...section,
        groups: section.groups.map((group) => ({
          ...group,
          items: this.applyHotfixRefreshItemsState(section.title, group.assignee, group.items, previousItemsByKey),
        })),
      })),
    };
  }

  private isStructuredTaskContentForNotification(taskContent: TaskMessageContent): boolean {
    return (
      taskContent.sections.length > 0
      && taskContent.sections.every((section) =>
        section.title.trim().length > 0
        && section.title !== SIMPLE_TASK_SECTION_TITLE
        && section.groups.length > 0
        && section.groups.every((group) =>
          group.assignee.trim().length > 0
          && group.assignee !== SIMPLE_TASK_ASSIGNEE
          && group.items.length > 0,
        ),
      )
    );
  }

  private isHotfixTaskContent(taskContent: TaskMessageContent): boolean {
    return (
      this.isStructuredTaskContentForNotification(taskContent)
      && taskContent.sections.every((section) => isHotfixVersionLine(section.title))
    );
  }

  private isPackageDistributionTaskContent(taskContent: TaskMessageContent): boolean {
    return taskContent.kind === 'package-distribution';
  }

  private normalizeTaskText(textContent: string | null | undefined): string {
    return (textContent ?? '').replace(/\r\n?/g, '\n').trim();
  }

  private areAllTaskItemsCompleted(taskContent: TaskMessageContent): boolean {
    return areAllTaskContentItemsCompleted(taskContent);
  }

  private parseStructuredTaskItemsFromLines(contentLines: string[], createId: () => string): TaskMessageItem[] {
    if (contentLines.length === 0) {
      return [];
    }

    const hasExplicitTaskSyntax = contentLines.some((line) => SIMPLE_TASK_EXPLICIT_ITEM_PREFIX_REGEX.test(line.trim()));
    if (!hasExplicitTaskSyntax) {
      throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
    }

    const hasUnsupportedTopLevelPlainLine = contentLines.some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !SIMPLE_TASK_EXPLICIT_ITEM_PREFIX_REGEX.test(trimmed) && !/^\s+/.test(line);
    });
    if (hasUnsupportedTopLevelPlainLine) {
      throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
    }

    return this.createTaskItemsFromHotfixItems(extractHotfixEntryTaskItems(contentLines), createId);
  }

  private parseStructuredTaskContentFromLines(rawLines: string[]): TaskMessageContent {
    const sections: TaskMessageSection[] = [];
    let currentSection: TaskMessageSection | null = null;
    let currentGroup: TaskMessageGroup | null = null;
    let currentGroupContentLines: string[] = [];
    let sectionIndex = 0;
    let groupIndex = 0;
    let itemIndex = 0;

    const flushCurrentGroup = (): void => {
      if (!currentGroup) {
        return;
      }

      const items = this.parseStructuredTaskItemsFromLines(currentGroupContentLines, () => `task-${++itemIndex}`);
      if (items.length === 0) {
        throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
      }

      currentGroup.items = items;
      currentGroupContentLines = [];
    };

    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      const assigneeMatch = /^@(.+)$/.exec(line);
      if (assigneeMatch) {
        if (!currentSection) {
          throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
        }
        if (currentGroup) {
          flushCurrentGroup();
        }

        const assignee = assigneeMatch[1]?.trim() ?? '';
        if (!assignee) {
          throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
        }

        currentGroup = {
          id: `group-${++groupIndex}`,
          assignee,
          items: [],
        };
        currentSection.groups.push(currentGroup);
        continue;
      }

      if (currentGroup) {
        const looksLikeTaskLine =
          SIMPLE_TASK_EXPLICIT_ITEM_PREFIX_REGEX.test(line)
          || /^\s+/.test(rawLine);
        if (looksLikeTaskLine) {
          currentGroupContentLines.push(rawLine);
          continue;
        }

        flushCurrentGroup();
      }

      if (currentSection && currentSection.groups.length === 0) {
        throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
      }

      currentSection = {
        id: `section-${++sectionIndex}`,
        title: line,
        groups: [],
      };
      currentGroup = null;
      sections.push(currentSection);
    }

    if (currentGroup) {
      flushCurrentGroup();
    }

    if (
      sections.length === 0
      || sections.some((section) => section.groups.length === 0)
      || sections.some((section) => section.groups.some((group) => group.items.length === 0))
    ) {
      throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
    }

    return {
      sections,
    };
  }

  private parseSimpleTaskContentFromLines(rawLines: string[]): TaskMessageContent | null {
    if (rawLines.length === 0) {
      return null;
    }

    const tasks: string[] = [];
    const normalizedLines = rawLines.map((line) => line.trim());

    for (let index = 0; index < rawLines.length; index += 1) {
      const rawLine = rawLines[index];
      const line = normalizedLines[index];
      if (!line || /^@/.test(line) || /^-\s*/.test(line)) {
        return null;
      }

      const previousTask = tasks.at(-1);
      if (previousTask && this.shouldMergeSimpleTaskLine(previousTask, line, rawLine, tasks.length)) {
        tasks[tasks.length - 1] = this.joinSimpleTaskText(previousTask, line);
        continue;
      }

      tasks.push(line);
    }

    if (tasks.length === 0) {
      return null;
    }

    let itemIndex = 0;
    return {
      sections: [
        {
          id: 'section-1',
          title: SIMPLE_TASK_SECTION_TITLE,
          groups: [
            {
              id: 'group-1',
              assignee: SIMPLE_TASK_ASSIGNEE,
              items: tasks.map((text) => ({
                id: `task-${++itemIndex}`,
                text,
                completed: false,
                completedByNickname: null,
                changed: false,
              })),
            },
          ],
        },
      ],
    };
  }

  private shouldMergeSimpleTaskLine(previousTask: string, line: string, rawLine: string, taskCount: number): boolean {
    if (SIMPLE_TASK_ORDERED_ITEM_PREFIX_REGEX.test(line)) {
      return false;
    }

    if (rawLine !== rawLine.trimStart()) {
      return true;
    }

    if (SIMPLE_TASK_CONTINUATION_PREFIX_REGEX.test(line)) {
      return true;
    }

    if (!SIMPLE_TASK_TERMINAL_PUNCTUATION_REGEX.test(previousTask) && previousTask.length >= SIMPLE_TASK_LONG_LINE_MIN_LENGTH) {
      return true;
    }

    return (
      taskCount >= 2
      && previousTask.length <= SIMPLE_TASK_SHORT_LINE_MAX_LENGTH
      && line.length >= SIMPLE_TASK_LONG_LINE_MIN_LENGTH
      && SIMPLE_TASK_SENTENCE_PUNCTUATION_REGEX.test(line)
    );
  }

  private joinSimpleTaskText(previousTask: string, line: string): string {
    if (ASCII_WORD_END_REGEX.test(previousTask) && ASCII_WORD_START_REGEX.test(line)) {
      return `${previousTask} ${line}`;
    }

    return `${previousTask}${line}`;
  }

  private normalizeMessageMentions(roomId: string, senderIp: string, input?: MessageMentionInput): { mentionAll: boolean; mentionedIps: string[] } {
    const mentionAll = Boolean(input?.mentionAll);
    const requestedIps = Array.from(new Set((input?.mentionedIps ?? []).map((value) => value.trim()).filter((value) => value.length > 0)));

    if (requestedIps.length === 0) {
      return { mentionAll, mentionedIps: [] };
    }

    const activeMemberIps = new Set(this.getMemberRows(roomId).map((member) => member.ip));
    const normalizedMentionedIps = requestedIps.filter((ip) => ip !== senderIp);
    const invalidIps = normalizedMentionedIps.filter((ip) => !activeMemberIps.has(ip));

    if (invalidIps.length > 0) {
      throw new HttpError(400, '包含无效的被@成员');
    }

    return {
      mentionAll,
      mentionedIps: normalizedMentionedIps,
    };
  }

  private isWithinMessageEditWindow(createdAt: string): boolean {
    const createdAtMs = Date.parse(createdAt);
    return Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= 2 * 60 * 1000;
  }

  private getMessageRow(roomId: string, messageId: number): MessageRow {
    const row = this.database
      .prepare<[string, number], MessageRow>('SELECT * FROM messages WHERE room_id = ? AND id = ?')
      .get(roomId, messageId);

    if (!row) {
      throw new HttpError(404, '消息不存在');
    }

    return row;
  }

  private toMessage(row: MessageRow): ChatMessage {
    const isRecalled = row.is_recalled === 1;
    const baseAttachmentUrl = !isRecalled && row.file_path ? `/api/rooms/${row.room_id}/messages/${row.id}` : null;
    const downloadUrl = baseAttachmentUrl ? `${baseAttachmentUrl}/download` : null;
    const contentUrl = baseAttachmentUrl ? `${baseAttachmentUrl}/content` : null;
    const isImage = row.type === 'image' && !isRecalled;
    const richContent = !isRecalled && row.type === 'rich' ? this.toRichMessageContent(row) : null;

    return {
      id: row.id,
      roomId: row.room_id,
      senderIp: row.sender_ip,
      senderNickname: row.sender_nickname,
      type: row.type,
      textContent: isRecalled ? null : row.text_content,
      fileUrl: downloadUrl,
      fileName: isRecalled ? null : row.file_name,
      fileMime: isRecalled ? null : row.file_mime,
      fileSize: isRecalled ? null : row.file_size,
      imageUrl: isImage ? contentUrl : null,
      imageName: isImage ? row.file_name : null,
      imageMime: isImage ? row.file_mime : null,
      imageSize: isImage ? row.file_size : null,
      isRecalled,
      recalledAt: row.recalled_at,
      recalledByIp: row.recalled_by_ip,
      mentionAll: row.mention_all === 1,
      mentionedIps: this.parseMentionedIps(row.mentioned_ips),
      editedAt: row.edited_at,
      taskContent: isRecalled ? null : this.parseTaskPayload(row.task_payload),
      taskNotifiedAt: isRecalled ? null : row.task_notified_at,
      replyContent: isRecalled ? null : this.parseReplyPayload(row.reply_payload),
      richContent,
      createdAt: row.created_at,
    };
  }

  listMessages(roomId: string, ip: string, cursor?: number, limit = 50): MessagePage {
    this.requireActiveAccess(roomId, ip);

    const rows = cursor
      ? this.database
          .prepare<[string, number, number], MessageRow>(`
          SELECT *
          FROM messages
          WHERE room_id = ? AND id < ?
          ORDER BY id DESC
          LIMIT ?
        `)
          .all(roomId, cursor, limit)
      : this.database
          .prepare<[string, number], MessageRow>(`
          SELECT *
          FROM messages
          WHERE room_id = ?
          ORDER BY id DESC
          LIMIT ?
        `)
          .all(roomId, limit);

    rows.reverse();
    return {
      items: rows.map((row: MessageRow) => this.toMessage(row)),
      nextCursor: rows.length === limit ? rows[0]?.id ?? null : null,
    };
  }

  markRoomReadUpTo(roomId: string, ip: string, messageId: number): RoomReadState {
    const transaction = this.database.transaction(() => {
      this.requireActiveAccess(roomId, ip);

      const boundedMessageId = this.database
        .prepare<[string, number], { id: number | null }>('SELECT MAX(id) AS id FROM messages WHERE room_id = ? AND id <= ?')
        .get(roomId, messageId)?.id ?? null;

      if (boundedMessageId === null) {
        return this.getUnreadMentionState(roomId, ip, null);
      }

      const currentLastSeenMessageId = this.database
        .prepare<[string, string], { last_seen_message_id: number | null }>(
          'SELECT last_seen_message_id FROM room_members WHERE room_id = ? AND member_ip = ?',
        )
        .get(roomId, ip)?.last_seen_message_id ?? null;

      const nextLastSeenMessageId = currentLastSeenMessageId === null
        ? boundedMessageId
        : Math.max(currentLastSeenMessageId, boundedMessageId);

      this.database
        .prepare('UPDATE room_members SET last_seen_message_id = ? WHERE room_id = ? AND member_ip = ?')
        .run(nextLastSeenMessageId, roomId, ip);

      return this.getUnreadMentionState(roomId, ip, nextLastSeenMessageId);
    });

    return transaction();
  }

  addTextMessage(roomId: string, ip: string, textContent: string, mentionInput?: MessageMentionInput): ChatMessage {
    const normalizedText = textContent.trim();
    if (!normalizedText) {
      throw new HttpError(400, '消息内容不能为空');
    }

    const transaction = this.database.transaction(() => {
      const access = this.requireActiveAccess(roomId, ip);
      const mentions = this.normalizeMessageMentions(roomId, ip, mentionInput);
      const replyPayload = this.buildReplyPayload(roomId, mentionInput?.replyMessageId);
      const timestamp = this.now();
      const result = this.database
        .prepare(
          `INSERT INTO messages (
            room_id,
            sender_ip,
            sender_nickname,
            type,
            text_content,
            file_path,
            file_name,
            file_mime,
            file_size,
            is_recalled,
            recalled_at,
            recalled_by_ip,
            mention_all,
            mentioned_ips,
            edited_at,
            task_payload,
            reply_payload,
            rich_payload,
            created_at
          ) VALUES (?, ?, ?, 'text', ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, ?)`,
        )
        .run(
          roomId,
          ip,
          access.nickname,
          normalizedText,
          mentions.mentionAll ? 1 : 0,
          JSON.stringify(mentions.mentionedIps),
          replyPayload ? JSON.stringify(replyPayload) : null,
          timestamp,
        );

      const row = this.database.prepare<[number], MessageRow>('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid));
      if (!row) {
        throw new Error('Failed to load inserted message');
      }

      return this.toMessage(row);
    });

    return transaction();
  }

  addStructuredTaskMessage(roomId: string, ip: string, textContent: string, taskContent: TaskMessageContent): ChatMessage {
    const normalizedText = textContent.trim();
    if (!normalizedText) {
      throw new HttpError(400, '任务内容不能为空');
    }

    const normalizedTaskContent = this.normalizeTaskContentValue(taskContent);
    if (!normalizedTaskContent) {
      throw new HttpError(400, '任务结构无效');
    }

    const transaction = this.database.transaction(() => {
      const access = this.requireActiveAccess(roomId, ip);
      const timestamp = this.now();
      const result = this.database
        .prepare(
          `INSERT INTO messages (
            room_id,
            sender_ip,
            sender_nickname,
            type,
            text_content,
            file_path,
            file_name,
            file_mime,
            file_size,
            is_recalled,
            recalled_at,
            recalled_by_ip,
            mention_all,
            mentioned_ips,
            edited_at,
            task_payload,
            reply_payload,
            rich_payload,
            created_at
          ) VALUES (?, ?, ?, 'text', ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, '[]', NULL, ?, NULL, NULL, ?)`,
        )
        .run(
          roomId,
          ip,
          access.nickname,
          normalizedText,
          JSON.stringify(normalizedTaskContent),
          timestamp,
        );

      const row = this.database.prepare<[number], MessageRow>('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid));
      if (!row) {
        throw new Error('Failed to load inserted task message');
      }

      return this.toMessage(row);
    });

    return transaction();
  }



  createPendingUpload(roomId: string, ip: string, uploadId: string, attachment: AttachmentRecordInput): PendingUploadSummary {
    const transaction = this.database.transaction(() => {
      this.requireActiveAccess(roomId, ip);
      const timestamp = this.now();
      this.database
        .prepare(
          `INSERT INTO pending_uploads (
            upload_id,
            room_id,
            uploader_ip,
            type,
            file_path,
            file_name,
            file_mime,
            file_size,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          uploadId,
          roomId,
          ip,
          attachment.type,
          attachment.relativePath,
          attachment.originalName,
          attachment.mimeType,
          attachment.size,
          timestamp,
        );

      return {
        uploadId,
        type: attachment.type,
        fileName: attachment.originalName,
        fileMime: attachment.mimeType,
        fileSize: attachment.size,
        createdAt: timestamp,
      } satisfies PendingUploadSummary;
    });

    return transaction();
  }

  deletePendingUpload(roomId: string, uploadId: string, ip: string): string | null {
    const transaction = this.database.transaction(() => {
      const row = this.database
        .prepare<[string, string, string], PendingUploadRow>(`
          SELECT *
          FROM pending_uploads
          WHERE room_id = ? AND upload_id = ? AND uploader_ip = ?
        `)
        .get(roomId, uploadId, ip);

      if (!row) {
        return null;
      }

      this.database
        .prepare('DELETE FROM pending_uploads WHERE upload_id = ?')
        .run(uploadId);

      return row.file_path;
    });

    return transaction();
  }

  commitPendingUploads(
    roomId: string,
    ip: string,
    uploadIds: string[],
    options?: {
      textContent?: string;
      mentionAll?: boolean;
      mentionedIps?: string[];
      replyMessageId?: number;
    },
  ): CommitPendingUploadsResult {
    const normalizedIds = Array.from(
      new Set(
        uploadIds
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    );
    const normalizedText = (options?.textContent ?? '').trim();

    if (normalizedIds.length === 0) {
      throw new HttpError(400, '请选择已上传完成的附件');
    }

    const placeholders = normalizedIds.map(() => '?').join(', ');

    const transaction = this.database.transaction(() => {
      const access = this.requireActiveAccess(roomId, ip);
      const mentions = normalizedText
        ? this.normalizeMessageMentions(roomId, ip, {
            mentionAll: options?.mentionAll,
            mentionedIps: options?.mentionedIps,
          })
        : { mentionAll: false, mentionedIps: [] };
      const replyPayload = normalizedText ? this.buildReplyPayload(roomId, options?.replyMessageId) : null;
      const rows = this.database
        .prepare<unknown[], PendingUploadRow>(`
          SELECT *
          FROM pending_uploads
          WHERE room_id = ?
            AND uploader_ip = ?
            AND upload_id IN (${placeholders})
          ORDER BY created_at ASC
        `)
        .all(roomId, ip, ...normalizedIds);

      const rowMap = new Map(rows.map((row) => [row.upload_id, row]));
      const loadMessageStatement = this.database.prepare<[number], MessageRow>('SELECT * FROM messages WHERE id = ?');
      const deleteUploadStatement = this.database.prepare('DELETE FROM pending_uploads WHERE upload_id = ?');
      const items: ChatMessage[] = [];
      const timestamp = this.now();

      if (normalizedText && rows.length > 0) {
        const attachments = normalizedIds.flatMap((uploadId) => {
          const row = rowMap.get(uploadId);
          if (!row) {
            return [];
          }

          return [{
            id: row.upload_id,
            type: row.type,
            fileName: row.file_name,
            fileMime: row.file_mime,
            fileSize: row.file_size,
            relativePath: row.file_path,
          } satisfies StoredRichAttachmentPayload];
        });

        if (attachments.length === 0) {
          throw new HttpError(400, '未找到可发送的附件');
        }

        const result = this.database
          .prepare(
            `INSERT INTO messages (
              room_id,
              sender_ip,
              sender_nickname,
              type,
              text_content,
              file_path,
              file_name,
              file_mime,
              file_size,
              is_recalled,
              recalled_at,
              recalled_by_ip,
              mention_all,
              mentioned_ips,
              edited_at,
              task_payload,
              reply_payload,
              rich_payload,
              created_at
            ) VALUES (?, ?, ?, 'rich', ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?)`,
          )
          .run(
            roomId,
            ip,
            access.nickname,
            normalizedText,
            mentions.mentionAll ? 1 : 0,
            JSON.stringify(mentions.mentionedIps),
            replyPayload ? JSON.stringify(replyPayload) : null,
            JSON.stringify({ attachments }),
            timestamp,
          );

        const insertedRow = loadMessageStatement.get(Number(result.lastInsertRowid));
        if (!insertedRow) {
          throw new Error('Failed to load committed rich message');
        }

        items.push(this.toMessage(insertedRow));
        for (const uploadId of normalizedIds) {
          if (rowMap.has(uploadId)) {
            deleteUploadStatement.run(uploadId);
          }
        }

        return { items } satisfies CommitPendingUploadsResult;
      }

      for (const uploadId of normalizedIds) {
        const row = rowMap.get(uploadId);
        if (!row) {
          continue;
        }

        const result = this.database
          .prepare(
            `INSERT INTO messages (
              room_id,
              sender_ip,
              sender_nickname,
              type,
              text_content,
              file_path,
              file_name,
              file_mime,
              file_size,
              is_recalled,
              recalled_at,
              recalled_by_ip,
              mention_all,
              mentioned_ips,
              edited_at,
              task_payload,
              reply_payload,
              rich_payload,
              created_at
            ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL, 0, '[]', NULL, NULL, NULL, NULL, ?)`,
          )
          .run(
            roomId,
            ip,
            access.nickname,
            row.type,
            row.file_path,
            row.file_name,
            row.file_mime,
            row.file_size,
            timestamp,
          );

        const insertedRow = loadMessageStatement.get(Number(result.lastInsertRowid));
        if (!insertedRow) {
          throw new Error('Failed to load committed upload message');
        }

        items.push(this.toMessage(insertedRow));
        deleteUploadStatement.run(uploadId);
      }

      return { items } satisfies CommitPendingUploadsResult;
    });

    return transaction();
  }

  listStoredFiles(): StoredFileItem[] {
    const rows = this.database
      .prepare<[], StoredFileRow>(`
        SELECT
          messages.id AS message_id,
          messages.room_id,
          rooms.room_name,
          messages.sender_ip,
          messages.sender_nickname,
          messages.type,
          messages.file_path,
          messages.file_name,
          messages.file_mime,
          messages.file_size,
          messages.created_at
        FROM messages
        JOIN rooms ON rooms.room_id = messages.room_id
        WHERE messages.type IN ('image', 'file')
          AND messages.file_path IS NOT NULL
          AND messages.file_name IS NOT NULL
          AND messages.file_mime IS NOT NULL
          AND messages.file_size IS NOT NULL
        ORDER BY messages.created_at DESC, messages.id DESC
      `)
      .all();

    return rows.map((row) => ({
      messageId: row.message_id,
      roomId: row.room_id,
      roomName: this.resolveRoomName(row.room_id, row.room_name),
      senderIp: row.sender_ip,
      senderNickname: row.sender_nickname,
      type: row.type,
      fileName: row.file_name,
      fileMime: row.file_mime,
      fileSize: row.file_size,
      createdAt: row.created_at,
      relativePath: row.file_path,
      downloadUrl: `/api/rooms/${row.room_id}/messages/${row.message_id}/download`,
      previewUrl: row.type === 'image' ? `/api/rooms/${row.room_id}/messages/${row.message_id}/content` : null,
    } satisfies StoredFileItem));
  }

  cleanupStoredFiles(messageIds: number[], recalledByIp: string): StoredFileCleanupResult {
    const normalizedIds = Array.from(
      new Set(
        messageIds
          .filter((value) => Number.isInteger(value) && value > 0)
          .map((value) => Number(value)),
      ),
    );

    if (normalizedIds.length === 0) {
      throw new HttpError(400, '请选择要删除的文件');
    }

    const placeholders = normalizedIds.map(() => '?').join(', ');

    const transaction = this.database.transaction(() => {
      const rows = this.database
        .prepare<unknown[], MessageRow>(`
          SELECT *
          FROM messages
          WHERE id IN (${placeholders})
            AND type IN ('image', 'file')
            AND file_path IS NOT NULL
            AND file_name IS NOT NULL
            AND file_mime IS NOT NULL
            AND file_size IS NOT NULL
        `)
        .all(...normalizedIds);

      const timestamp = this.now();
      const updateStatement = this.database.prepare(
        `UPDATE messages
         SET text_content = NULL,
             file_path = NULL,
             file_name = NULL,
             file_mime = NULL,
             file_size = NULL,
             is_recalled = 1,
             recalled_at = ?,
             recalled_by_ip = ?
         WHERE id = ?`,
      );
      const loadStatement = this.database.prepare<[number], MessageRow>('SELECT * FROM messages WHERE id = ?');

      const items: ChatMessage[] = [];
      const deletedRelativePaths: string[] = [];
      let cleanedSize = 0;

      for (const row of rows) {
        updateStatement.run(timestamp, recalledByIp, row.id);
        const updatedRow = loadStatement.get(row.id);
        if (updatedRow) {
          items.push(this.toMessage(updatedRow));
        }
        if (row.file_path) {
          deletedRelativePaths.push(row.file_path);
        }
        cleanedSize += row.file_size ?? 0;
      }

      return {
        items,
        deletedRelativePaths,
        cleanedCount: items.length,
        cleanedSize,
        skippedCount: normalizedIds.length - items.length,
      } satisfies StoredFileCleanupResult;
    });

    return transaction();
  }

  getAttachmentAccess(roomId: string, messageId: number, ip: string): AttachmentAccessResult {
    this.requireActiveAccess(roomId, ip);
    const message = this.getMessageRow(roomId, messageId);

    if (message.is_recalled === 1 || !message.file_path || !message.file_name || !message.file_mime || !message.file_size) {
      throw new HttpError(404, '附件不存在或已撤回');
    }

    if (message.type !== 'image' && message.type !== 'file') {
      throw new HttpError(404, '该消息不包含附件');
    }

    return {
      roomId: message.room_id,
      messageId: message.id,
      type: message.type,
      relativePath: message.file_path,
      originalName: message.file_name,
      mimeType: message.file_mime,
      size: message.file_size,
    } satisfies AttachmentAccessResult;
  }

  getRichAttachmentAccess(roomId: string, messageId: number, attachmentId: string, ip: string): RichAttachmentAccessResult {
    const normalizedAttachmentId = attachmentId.trim();
    if (!normalizedAttachmentId) {
      throw new HttpError(400, '无效的附件 ID');
    }

    this.requireActiveAccess(roomId, ip);
    const message = this.getMessageRow(roomId, messageId);

    if (message.is_recalled === 1) {
      throw new HttpError(404, '附件不存在或已撤回');
    }

    if (message.type !== 'rich') {
      throw new HttpError(404, '该消息不包含富文本附件');
    }

    const payload = this.parseStoredRichPayload(message.rich_payload);
    const attachment = payload?.attachments.find((item) => item.id === normalizedAttachmentId);
    if (!attachment) {
      throw new HttpError(404, '附件不存在或已撤回');
    }

    return {
      roomId: message.room_id,
      messageId: message.id,
      attachmentId: attachment.id,
      type: attachment.type,
      relativePath: attachment.relativePath,
      originalName: attachment.fileName,
      mimeType: attachment.fileMime,
      size: attachment.fileSize,
    } satisfies RichAttachmentAccessResult;
  }

  addAttachmentMessage(roomId: string, ip: string, attachment: AttachmentRecordInput): ChatMessage {
    const transaction = this.database.transaction(() => {
      const access = this.requireActiveAccess(roomId, ip);
      const timestamp = this.now();
      const result = this.database
        .prepare(
          `INSERT INTO messages (
            room_id,
            sender_ip,
            sender_nickname,
            type,
            text_content,
            file_path,
            file_name,
            file_mime,
            file_size,
            is_recalled,
            recalled_at,
            recalled_by_ip,
            mention_all,
            mentioned_ips,
            edited_at,
            task_payload,
            reply_payload,
            rich_payload,
            created_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL, 0, '[]', NULL, NULL, NULL, NULL, ?)`,
        )
        .run(
          roomId,
          ip,
          access.nickname,
          attachment.type,
          attachment.relativePath,
          attachment.originalName,
          attachment.mimeType,
          attachment.size,
          timestamp,
        );

      const row = this.database.prepare<[number], MessageRow>('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid));
      if (!row) {
        throw new Error('Failed to load inserted attachment message');
      }

      return this.toMessage(row);
    });

    return transaction();
  }

  editTextMessage(roomId: string, messageId: number, actorIp: string, textContent: string, mentionInput?: MessageMentionInput): ChatMessage {
    const normalizedText = textContent.trim();
    if (!normalizedText) {
      throw new HttpError(400, '编辑后的消息内容不能为空');
    }

    const transaction = this.database.transaction(() => {
      const access = this.requireActiveAccess(roomId, actorIp);
      const message = this.getMessageRow(roomId, messageId);

      if (message.is_recalled === 1) {
        throw new HttpError(409, '消息已撤回，无法编辑');
      }
      if (message.type !== 'text') {
        throw new HttpError(409, '仅支持编辑文本消息');
      }
      if (message.task_payload) {
        throw new HttpError(409, '消息已转为任务，无法编辑');
      }
      if (message.sender_ip !== actorIp) {
        throw new HttpError(403, '你只能编辑自己的消息');
      }
      if (!this.isWithinMessageEditWindow(message.created_at)) {
        throw new HttpError(403, '消息发送超过 2 分钟，无法编辑');
      }

      const mentions = this.normalizeMessageMentions(roomId, actorIp, mentionInput);
      const editedAt = this.now();
      this.database.prepare(
        `UPDATE messages
         SET text_content = ?,
             mention_all = ?,
             mentioned_ips = ?,
             edited_at = ?
         WHERE room_id = ? AND id = ?`,
      ).run(normalizedText, mentions.mentionAll ? 1 : 0, JSON.stringify(mentions.mentionedIps), editedAt, roomId, messageId);

      return this.toMessage(this.getMessageRow(roomId, messageId));
    });

    return transaction();
  }

  editTaskMessage(roomId: string, messageId: number, actorIp: string, textContent: string): ChatMessage {
    const normalizedText = textContent.trim();
    if (!normalizedText) {
      throw new HttpError(400, '编辑后的消息内容不能为空');
    }

    const transaction = this.database.transaction(() => {
      this.requireActiveAccess(roomId, actorIp);
      const message = this.getMessageRow(roomId, messageId);

      if (message.is_recalled === 1) {
        throw new HttpError(409, '消息已撤回，无法编辑');
      }
      if (message.type !== 'text') {
        throw new HttpError(409, '仅支持编辑文本消息');
      }
      if (!message.task_payload) {
        throw new HttpError(409, '消息未转为任务，无法编辑');
      }
      if (message.sender_ip !== actorIp) {
        throw new HttpError(403, '你只能编辑自己的消息');
      }
      if (!this.isWithinMessageEditWindow(message.created_at)) {
        throw new HttpError(403, '消息发送超过 2 分钟，无法编辑');
      }

      const previousTaskContent = this.parseTaskPayload(message.task_payload);
      if (!previousTaskContent) {
        throw new HttpError(404, '任务不存在');
      }
      if (this.isPackageDistributionTaskContent(previousTaskContent)) {
        throw new HttpError(409, '包体分配任务暂不支持编辑');
      }

      const nextTaskContent = this.preserveTaskItemCompletionState(
        previousTaskContent,
        this.parseTaskContentFromText(normalizedText),
      );
      const editedAt = this.now();
      this.database.prepare(
        `UPDATE messages
         SET text_content = ?,
             task_payload = ?,
             task_notified_at = NULL,
             edited_at = ?
         WHERE room_id = ? AND id = ?`,
      ).run(normalizedText, JSON.stringify(nextTaskContent), editedAt, roomId, messageId);

      return this.toMessage(this.getMessageRow(roomId, messageId));
    });

    return transaction();
  }

  getTaskNotificationMessage(roomId: string, messageId: number, actorIp: string): ChatMessage {
    this.requireActiveAccess(roomId, actorIp);
    const message = this.getMessageRow(roomId, messageId);

    if (message.is_recalled === 1) {
      throw new HttpError(409, '消息已撤回，无法发送通知');
    }
    if (message.type !== 'text') {
      throw new HttpError(409, '仅支持为文本任务发送通知');
    }
    if (!message.task_payload) {
      throw new HttpError(409, '消息未转为任务，无法发送通知');
    }

    const taskContent = this.parseTaskPayload(message.task_payload);
    if (!taskContent) {
      throw new HttpError(404, '任务不存在');
    }
    if (!this.isStructuredTaskContentForNotification(taskContent)) {
      throw new HttpError(409, '当前任务格式不支持发送通知');
    }
    if (!this.areAllTaskItemsCompleted(taskContent)) {
      throw new HttpError(409, '任务未全部完成，无法发送通知');
    }

    return this.toMessage(message);
  }

  convertTextMessageToTask(roomId: string, messageId: number, actorIp: string): ChatMessage {
    const transaction = this.database.transaction(() => {
      const access = this.requireActiveAccess(roomId, actorIp);
      const message = this.getMessageRow(roomId, messageId);

      if (message.is_recalled === 1) {
        throw new HttpError(409, '消息已撤回，无法转任务');
      }
      if (message.type !== 'text') {
        throw new HttpError(409, '仅支持将文本消息转为任务');
      }
      if (message.task_payload) {
        throw new HttpError(409, '该消息已转为任务');
      }
      if (!message.text_content?.trim()) {
        throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
      }

      const taskContent = this.parseTaskContentFromText(message.text_content);
      this.database
        .prepare('UPDATE messages SET task_payload = ?, task_notified_at = NULL WHERE room_id = ? AND id = ?')
        .run(JSON.stringify(taskContent), roomId, messageId);

      return this.toMessage(this.getMessageRow(roomId, messageId));
    });

    return transaction();
  }

  updateTaskMessageItem(roomId: string, messageId: number, taskItemId: string, completed: boolean, actorIp: string): ChatMessage {
    const normalizedTaskItemId = taskItemId.trim();
    if (!normalizedTaskItemId) {
      throw new HttpError(400, '无效的任务 ID');
    }

    const transaction = this.database.transaction(() => {
      const access = this.requireActiveAccess(roomId, actorIp);
      const message = this.getMessageRow(roomId, messageId);

      if (message.is_recalled === 1) {
        throw new HttpError(409, '消息已撤回，无法更新任务');
      }
      if (message.type !== 'text') {
        throw new HttpError(409, '仅支持更新文本任务');
      }

      const taskContent = this.parseTaskPayload(message.task_payload);
      if (!taskContent) {
        throw new HttpError(404, '任务不存在');
      }

      let found = false;
      const completedByNickname = completed ? access.nickname : null;
      const updateResult = updateTaskContentItemCompletion(taskContent, normalizedTaskItemId, completed, completedByNickname);
      const nextTaskContent = updateResult.taskContent;
      found = updateResult.found;

      if (!found) {
        throw new HttpError(404, '任务不存在');
      }

      this.database
        .prepare('UPDATE messages SET task_payload = ? WHERE room_id = ? AND id = ?')
        .run(JSON.stringify(nextTaskContent), roomId, messageId);

      return this.toMessage(this.getMessageRow(roomId, messageId));
    });

    return transaction();
  }

  markTaskNotificationSent(roomId: string, messageId: number, actorIp: string): ChatMessage {
    const transaction = this.database.transaction(() => {
      this.requireActiveAccess(roomId, actorIp);
      const message = this.getMessageRow(roomId, messageId);

      if (message.is_recalled === 1) {
        throw new HttpError(409, '消息已撤回，无法更新通知状态');
      }
      if (message.type !== 'text' || !message.task_payload) {
        throw new HttpError(409, '仅支持为任务消息记录通知状态');
      }

      const taskContent = this.parseTaskPayload(message.task_payload);
      if (!taskContent) {
        throw new HttpError(404, '任务不存在');
      }

      const notifiedAt = this.now();
      this.database
        .prepare('UPDATE messages SET task_notified_at = ? WHERE room_id = ? AND id = ?')
        .run(notifiedAt, roomId, messageId);

      return this.toMessage(this.getMessageRow(roomId, messageId));
    });

    return transaction();
  }

  refreshHotfixTaskMessage(
    roomId: string,
    messageId: number,
    actorIp: string,
    latestVersionBlocks: HotfixVersionBlock[],
  ): ChatMessage {
    const transaction = this.database.transaction(() => {
      this.requireActiveAccess(roomId, actorIp);
      const message = this.getMessageRow(roomId, messageId);

      if (message.is_recalled === 1) {
        throw new HttpError(409, '消息已撤回，无法刷新热更任务');
      }
      if (message.type !== 'text') {
        throw new HttpError(409, '仅支持刷新文本任务');
      }

      const previousTaskContent = this.parseTaskPayload(message.task_payload);
      if (!previousTaskContent) {
        throw new HttpError(404, '任务不存在');
      }
      if (!this.isHotfixTaskContent(previousTaskContent)) {
        throw new HttpError(409, '当前任务不是热更版本任务，无法刷新');
      }

      const latestBlocksByVersion = new Map<string, HotfixVersionBlock>();
      for (const block of latestVersionBlocks) {
        if (!latestBlocksByVersion.has(block.versionLine)) {
          latestBlocksByVersion.set(block.versionLine, block);
        }
      }

      const selectedBlocks = previousTaskContent.sections.flatMap((section) => {
        const matchedBlock = latestBlocksByVersion.get(section.title.trim());
        return matchedBlock ? [matchedBlock] : [];
      });

      if (selectedBlocks.length === 0) {
        throw new HttpError(409, '当前热更文档中未找到该任务对应的版本');
      }

      const nextTextContent = buildHotfixTaskContentFromBlocks(selectedBlocks);
      const parsedTaskContent = this.parseTaskContentFromText(nextTextContent);
      const nextTaskContent = this.applyHotfixRefreshState(previousTaskContent, parsedTaskContent);
      const currentTextContent = this.normalizeTaskText(message.text_content);
      const normalizedNextTextContent = this.normalizeTaskText(nextTextContent);
      const nextTaskPayload = JSON.stringify(nextTaskContent);

      if (currentTextContent === normalizedNextTextContent && message.task_payload === nextTaskPayload) {
        return this.toMessage(message);
      }

      const contentChanged = currentTextContent !== normalizedNextTextContent;
      const editedAt = contentChanged ? this.now() : message.edited_at;
      const taskNotifiedAt = contentChanged ? null : message.task_notified_at;
      this.database
        .prepare(
          `UPDATE messages
           SET text_content = ?,
               task_payload = ?,
               task_notified_at = ?,
               edited_at = ?
           WHERE room_id = ? AND id = ?`,
        )
        .run(nextTextContent, nextTaskPayload, taskNotifiedAt, editedAt, roomId, messageId);

      return this.toMessage(this.getMessageRow(roomId, messageId));
    });

    return transaction();
  }

  recallMessage(roomId: string, messageId: number, actorIp: string): RecallResult {
    const transaction = this.database.transaction(() => {
      const access = this.requireActiveAccess(roomId, actorIp);
      const message = this.getMessageRow(roomId, messageId);

      if (message.is_recalled === 1) {
        throw new HttpError(409, '消息已撤回');
      }

      const actorIsOwner = access.role === 'owner';
      const actorIsSender = message.sender_ip === actorIp;
      const createdAtMs = Date.parse(message.created_at);
      const withinRecallWindow = Number.isFinite(createdAtMs)
        ? Date.now() - createdAtMs <= 2 * 60 * 1000
        : false;

      if (!actorIsOwner) {
        if (!actorIsSender) {
          throw new HttpError(403, '你只能撤回自己的消息');
        }
        if (!withinRecallWindow) {
          throw new HttpError(403, '消息发送超过 2 分钟，无法撤回');
        }
      }

      const deletedRelativePaths = message.type === 'rich'
        ? (this.parseStoredRichPayload(message.rich_payload)?.attachments ?? []).map((attachment) => attachment.relativePath)
        : message.file_path
          ? [message.file_path]
          : [];
      const timestamp = this.now();
      this.database
        .prepare(
          `UPDATE messages
           SET text_content = NULL,
               file_path = NULL,
               file_name = NULL,
               file_mime = NULL,
               file_size = NULL,
               task_payload = NULL,
               rich_payload = NULL,
               is_recalled = 1,
               recalled_at = ?,
               recalled_by_ip = ?
           WHERE room_id = ? AND id = ?`,
        )
        .run(timestamp, actorIp, roomId, messageId);

      const recalledRow = this.getMessageRow(roomId, messageId);
      return {
        message: this.toMessage(recalledRow),
        deletedRelativePaths,
      } satisfies RecallResult;
    });

    return transaction();
  }

  getMemberEvent(roomId: string, ip: string): MemberEventPayload {
    const row = this.database
      .prepare<[string, string], MemberRow>(`
        SELECT
          room_members.member_ip AS ip,
          profiles.nickname,
          room_members.role,
          room_members.joined_at
        FROM room_members
        JOIN profiles ON profiles.ip = room_members.member_ip
        WHERE room_members.room_id = ? AND room_members.member_ip = ?
      `)
      .get(roomId, ip);

    if (!row) {
      throw new HttpError(404, '成员不存在');
    }

    return {
      roomId,
      member: {
        ip: row.ip,
        nickname: row.nickname,
        role: row.role,
        joinedAt: row.joined_at,
      },
    };
  }
}
