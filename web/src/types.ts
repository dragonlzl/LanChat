export type MemberRole = 'owner' | 'member';
export type RoomStatus = 'active' | 'dissolved';
export type MessageType = 'text' | 'image' | 'file';

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

