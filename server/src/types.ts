import type { HotfixVersionBlock } from './hotfix-content.js';

export type RoomStatus = 'active' | 'dissolved';
export type MemberRole = 'owner' | 'member';
export type MemberStatus = 'active' | 'left';
export type MessageType = 'text' | 'image' | 'file' | 'rich';

export interface MeResponse {
  ip: string;
  hasProfile: boolean;
  nickname: string | null;
}

export interface MemberSummary {
  ip: string;
  nickname: string;
  role: MemberRole;
  joinedAt: string;
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

export interface RoomAccess {
  roomId: string;
  ownerIp: string;
  role: MemberRole;
  memberIp: string;
  nickname: string;
  roomStatus: RoomStatus;
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  uploadsDir: string;
  logsDir: string;
  webDistDir: string;
  allowDebugIp: boolean;
  openPathInFileManager?: (targetPath: string) => Promise<void>;
}

export interface AttachmentRecordInput {
  relativePath: string;
  originalName: string;
  mimeType: string;
  size: number;
  type: Extract<MessageType, 'image' | 'file'>;
}

export interface JoinResult {
  room: RoomSummary;
  joined: boolean;
}

export interface RoomEventPayload {
  roomId: string;
}

export interface MemberEventPayload extends RoomEventPayload {
  member: MemberSummary;
}

export interface MemberPresencePayload extends RoomEventPayload {
  memberIp: string;
  isOnline: boolean;
}

export interface RoomPresenceSnapshotPayload extends RoomEventPayload {
  onlineMemberIps: string[];
}

export interface HomeRoomPresencePayload extends RoomEventPayload {
  onlineMemberCount: number;
}

export interface RoomDissolvedPayload extends RoomEventPayload {
  dissolvedAt: string;
}

export interface RoomErrorPayload extends RoomEventPayload {
  message: string;
}

export interface ProfileUpdateResult {
  me: MeResponse;
  affectedRoomIds: string[];
}

export interface RecallResult {
  message: ChatMessage;
  deletedRelativePaths: string[];
}

export interface AttachmentAccessResult {
  roomId: string;
  messageId: number;
  type: Extract<MessageType, 'image' | 'file'>;
  relativePath: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface RichAttachmentAccessResult extends AttachmentAccessResult {
  attachmentId: string;
}


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
  relativePath: string;
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

export interface OpenStoredFileFolderResult {
  ok: true;
  folderPath: string;
}

export interface StoredFileCleanupResult {
  items: ChatMessage[];
  deletedRelativePaths: string[];
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

export interface AdminDissolveRoomsResult {
  dissolvedRooms: RoomDissolvedPayload[];
  dissolvedCount: number;
  skippedCount: number;
}

export interface AdminRestoreRoomResult {
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

export interface TaskNotificationRecipient {
  memberId: string;
  memberIdType: string;
  name: string;
}
