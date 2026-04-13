export type MemberRole = 'owner' | 'member';
export type RoomStatus = 'active' | 'dissolved';
export type MessageType = 'text' | 'image' | 'file' | 'rich';

export interface MeResponse {
  ip: string;
  hasProfile: boolean;
  nickname: string | null;
}

export interface RoomReadState {
  lastSeenMessageId: number | null;
  unreadMentionCount: number;
  latestUnreadMentionId: number | null;
  latestUnreadMentionAt: string | null;
}

export interface RoomListItem extends RoomReadState {
  roomId: string;
  roomName: string;
  ownerIp: string;
  role: MemberRole;
  createdAt: string;
  joinedAt: string;
  lastMessageAt: string | null;
  memberCount: number;
  chattingMemberCount?: number;
  onlineMemberCount?: number;
}

export interface ActiveRoomListItem extends RoomReadState {
  roomId: string;
  roomName: string;
  ownerIp: string;
  role: MemberRole | null;
  createdAt: string;
  joinedAt: string | null;
  lastMessageAt: string | null;
  memberCount: number;
  chattingMemberCount?: number;
  onlineMemberCount?: number;
}

export interface MemberSummary {
  ip: string;
  nickname: string;
  role: MemberRole;
  joinedAt: string;
}

export interface RoomSummary extends RoomListItem {
  status: RoomStatus;
  dissolvedAt: string | null;
  members: MemberSummary[];
}

export interface TaskMessageItem {
  id: string;
  text: string;
  completed: boolean;
  completedByNickname: string | null;
  changed: boolean;
}

export interface TaskMessageGroup {
  id: string;
  assignee: string;
  items: TaskMessageItem[];
}

export interface TaskMessageSection {
  id: string;
  title: string;
  groups: TaskMessageGroup[];
}

export interface TaskMessageContent {
  sections: TaskMessageSection[];
}

export interface MessageReplyContent {
  messageId: number;
  senderNickname: string;
  messageType: MessageType;
  previewText: string;
}

export interface RichMessageAttachment {
  id: string;
  type: Extract<MessageType, 'image' | 'file'>;
  fileName: string;
  fileMime: string;
  fileSize: number;
  fileUrl: string;
  imageUrl: string | null;
}

export interface RichMessageContent {
  attachments: RichMessageAttachment[];
}

export interface ChatMessage {
  id: number;
  roomId: string;
  senderIp: string;
  senderNickname: string;
  type: MessageType;
  textContent: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  imageUrl: string | null;
  imageName: string | null;
  imageMime: string | null;
  imageSize: number | null;
  isRecalled: boolean;
  recalledAt: string | null;
  recalledByIp: string | null;
  mentionAll: boolean;
  mentionedIps: string[];
  editedAt: string | null;
  taskContent: TaskMessageContent | null;
  taskNotifiedAt: string | null;
  replyContent: MessageReplyContent | null;
  richContent: RichMessageContent | null;
  createdAt: string;
}

export interface MessagePage {
  items: ChatMessage[];
  nextCursor: number | null;
}

export interface JoinResult {
  room: RoomSummary;
  joined: boolean;
}

export interface MemberEventPayload {
  roomId: string;
  member: MemberSummary;
}

export interface MemberPresencePayload {
  roomId: string;
  memberIp: string;
  isOnline: boolean;
}

export interface RoomPresenceSnapshotPayload {
  roomId: string;
  onlineMemberIps: string[];
}

export interface HomeRoomPresencePayload {
  roomId: string;
  onlineMemberCount: number;
}

export interface RoomDissolvedPayload {
  roomId: string;
  dissolvedAt: string;
}

export interface RoomErrorPayload {
  roomId?: string;
  message: string;
}

export interface MemberUpdatedPayload extends MemberEventPayload {}


export interface StoredFileItem {
  messageId: number;
  roomId: string;
  roomName: string;
  senderIp: string;
  senderNickname: string;
  type: Extract<MessageType, 'image' | 'file'>;
  fileName: string;
  fileMime: string;
  fileSize: number;
  createdAt: string;
  downloadUrl: string;
  previewUrl: string | null;
}

export interface StoredFileListResponse {
  items: StoredFileItem[];
  totalCount: number;
  totalSize: number;
  missingCount: number;
  storageRootPath: string;
}

export interface OpenStoredFileFolderResponse {
  ok: true;
  folderPath: string;
}

export interface DeleteStoredFilesResponse {
  cleanedCount: number;
  cleanedSize: number;
  skippedCount: number;
}

export interface ManagedRoomItem {
  roomId: string;
  roomName: string;
  ownerIp: string;
  createdAt: string;
  status: RoomStatus;
  dissolvedAt: string | null;
  restoreExpiresAt: string | null;
  canRestore: boolean;
  memberCount: number;
  chattingMemberCount?: number;
  onlineMemberCount?: number;
}

export interface ManagedRoomListResponse {
  items: ManagedRoomItem[];
  totalCount: number;
}

export interface AdminDissolveRoomsResponse {
  dissolvedCount: number;
  skippedCount: number;
}

export interface AdminRestoreRoomResponse {
  room: ManagedRoomItem;
}

export interface PendingUploadSummary {
  uploadId: string;
  type: Extract<MessageType, 'image' | 'file'>;
  fileName: string;
  fileMime: string;
  fileSize: number;
  createdAt: string;
}

export interface CommitPendingUploadsResult {
  items: ChatMessage[];
}

export interface FeishuBotMember {
  memberId: string;
  memberIdType: string;
  name: string;
  tenantKey: string;
}

export interface FeishuBotSettings {
  webhookUrl: string;
  members: FeishuBotMember[];
  updatedAt: string | null;
  enabled: boolean;
}

export interface FeishuBotPublicConfig {
  enabled: boolean;
  members: FeishuBotMember[];
}

export interface HotfixAuthRecord {
  clientId: string;
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  issuedAt: string;
  expiresAt: string;
  updatedAt: string;
  code: string;
  message: string;
  traceId: string | null;
}

export interface HotfixSettings {
  baseUrl: string;
  documentId: string;
  clientId: string;
  clientSecret: string;
  updatedAt: string | null;
  auth: HotfixAuthRecord | null;
}

export interface HotfixEntry {
  assigneeLine: string;
  contentLines: string[];
}

export interface HotfixVersionBlock {
  versionLine: string;
  entries: HotfixEntry[];
  content: string;
  taskContent: string;
}

export interface HotfixDocumentResult {
  documentId: string;
  content: string;
  versionBlocks: HotfixVersionBlock[];
  fetchedAt: string;
  refreshedToken: boolean;
}

export interface HotfixTaskRefreshResult {
  message: ChatMessage;
  refreshedToken: boolean;
}
