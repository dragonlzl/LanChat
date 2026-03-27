import type Database from 'better-sqlite3';
import { createRoomId } from './room-id.js';
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
  MemberSummary,
  MessagePage,
  MeResponse,
  PendingUploadSummary,
  ProfileUpdateResult,
  RecallResult,
  RoomAccess,
  RoomListItem,
  RoomReadState,
  RoomSummary,
  StoredFileCleanupResult,
  StoredFileItem,
  TaskMessageContent,
  TaskMessageGroup,
  TaskMessageItem,
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
  type: 'text' | 'image' | 'file';
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
  created_at: string;
};

type MessageMentionInput = {
  mentionAll?: boolean;
  mentionedIps?: string[];
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

const ROOM_RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TASK_CONVERT_ERROR_MESSAGE = '该格式无法转换';

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

      const normalizedItems: TaskMessageItem[] = [];
      for (const item of items) {
        if (typeof item !== 'object' || item === null) {
          return null;
        }

        const { id: itemId, text, completed } = item as { id?: unknown; text?: unknown; completed?: unknown };
        if (typeof itemId !== 'string' || typeof text !== 'string' || text.trim().length === 0 || typeof completed !== 'boolean') {
          return null;
        }

        normalizedItems.push({
          id: itemId,
          text,
          completed,
        });
      }

      if (normalizedItems.length === 0) {
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

  private parseTaskPayload(value: string | null | undefined): TaskMessageContent | null {
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }

      const parsedRecord = parsed as { sections?: unknown; title?: unknown; groups?: unknown };
      const normalizedSections: TaskMessageSection[] = [];

      if (Array.isArray(parsedRecord.sections)) {
        for (const section of parsedRecord.sections) {
          if (typeof section !== 'object' || section === null) {
            return null;
          }

          const { id, title, groups } = section as { id?: unknown; title?: unknown; groups?: unknown };
          if (typeof id !== 'string' || typeof title !== 'string' || title.trim().length === 0) {
            return null;
          }

          const normalizedGroups = this.normalizeTaskGroups(groups);
          if (!normalizedGroups) {
            return null;
          }

          normalizedSections.push({
            id,
            title,
            groups: normalizedGroups,
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
        });
      }

      return normalizedSections.length > 0
        ? { sections: normalizedSections }
        : null;
    } catch {
      return null;
    }
  }

  private parseTaskContentFromText(textContent: string): TaskMessageContent {
    const lines = textContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 3) {
      throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
    }

    const sections: TaskMessageSection[] = [];
    let currentSection: TaskMessageSection | null = null;
    let currentGroup: TaskMessageGroup | null = null;
    let sectionIndex = 0;
    let groupIndex = 0;
    let itemIndex = 0;

    for (const line of lines) {
      const itemMatch = /^-\s*(.+)$/.exec(line);
      if (itemMatch) {
        if (!currentGroup) {
          throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
        }

        const itemText = itemMatch[1]?.trim() ?? '';
        if (!itemText) {
          throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
        }

        currentGroup.items.push({
          id: `task-${++itemIndex}`,
          text: itemText,
          completed: false,
        });
        continue;
      }

      const assigneeMatch = /^@(.+)$/.exec(line);
      if (assigneeMatch) {
        if (!currentSection) {
          throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
        }
        if (currentGroup && currentGroup.items.length === 0) {
          throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
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

      if (currentGroup && currentGroup.items.length === 0) {
        throw new HttpError(400, TASK_CONVERT_ERROR_MESSAGE);
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
            created_at
          ) VALUES (?, ?, ?, 'text', ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, NULL, NULL, ?)`,
        )
        .run(roomId, ip, access.nickname, normalizedText, mentions.mentionAll ? 1 : 0, JSON.stringify(mentions.mentionedIps), timestamp);

      const row = this.database.prepare<[number], MessageRow>('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid));
      if (!row) {
        throw new Error('Failed to load inserted message');
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

  commitPendingUploads(roomId: string, ip: string, uploadIds: string[]): CommitPendingUploadsResult {
    const normalizedIds = Array.from(
      new Set(
        uploadIds
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    );

    if (normalizedIds.length === 0) {
      throw new HttpError(400, '请选择已上传完成的附件');
    }

    const placeholders = normalizedIds.map(() => '?').join(', ');

    const transaction = this.database.transaction(() => {
      const access = this.requireActiveAccess(roomId, ip);
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
              created_at
            ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL, 0, '[]', NULL, NULL, ?)`,
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
            created_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, NULL, 0, '[]', NULL, NULL, ?)`,
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
      this.requireActiveAccess(roomId, actorIp);
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

  convertTextMessageToTask(roomId: string, messageId: number, actorIp: string): ChatMessage {
    const transaction = this.database.transaction(() => {
      this.requireActiveAccess(roomId, actorIp);
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
        .prepare('UPDATE messages SET task_payload = ? WHERE room_id = ? AND id = ?')
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
      this.requireActiveAccess(roomId, actorIp);
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
      const nextTaskContent: TaskMessageContent = {
        ...taskContent,
        sections: taskContent.sections.map((section) => ({
          ...section,
          groups: section.groups.map((group) => ({
            ...group,
            items: group.items.map((item) => {
              if (item.id !== normalizedTaskItemId) {
                return item;
              }

              found = true;
              return item.completed === completed ? item : { ...item, completed };
            }),
          })),
        })),
      };

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
               is_recalled = 1,
               recalled_at = ?,
               recalled_by_ip = ?
           WHERE room_id = ? AND id = ?`,
        )
        .run(timestamp, actorIp, roomId, messageId);

      const recalledRow = this.getMessageRow(roomId, messageId);
      return {
        message: this.toMessage(recalledRow),
        deletedRelativePath: message.file_path,
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
