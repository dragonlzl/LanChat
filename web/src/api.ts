import type {
  ActiveRoomListItem,
  AdminDissolveRoomsResponse,
  AdminRestoreRoomResponse,
  ChatMessage,
  CommitPendingUploadsResult,
  DeleteStoredFilesResponse,
  FeishuBotPublicConfig,
  FeishuBotSettings,
  HotfixDocumentResult,
  HotfixSettings,
  HotfixTaskRefreshResult,
  JoinResult,
  ManagedRoomListResponse,
  OpenStoredFileFolderResponse,
  MeResponse,
  MessagePage,
  PendingUploadSummary,
  RoomListItem,
  RoomPresenceSnapshotPayload,
  RoomReadState,
  RoomSummary,
  StoredFileListResponse,
} from './types';

class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export interface UploadProgressPayload {
  loaded: number;
  total: number | null;
  percent: number;
}

function getCleanupPasswordHeaders(adminPassword?: string): HeadersInit | undefined {
  const normalized = adminPassword?.trim();
  if (!normalized) {
    return undefined;
  }

  return { 'x-admin-password': normalized };
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `请求失败 (${response.status})`;
  } catch {
    return `请求失败 (${response.status})`;
  }
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  const cache = init?.cache ?? (method === 'GET' || method === 'HEAD' ? 'no-store' : undefined);

  const response = await fetch(input, {
    ...init,
    headers,
    cache,
  });

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }

  return (await response.json()) as T;
}

export async function getMe(): Promise<MeResponse> {
  return requestJson<MeResponse>('/api/me');
}

export async function updateMe(nickname: string): Promise<MeResponse> {
  return requestJson<MeResponse>('/api/me', {
    method: 'PUT',
    body: JSON.stringify({ nickname }),
  });
}

export async function getMyRooms(): Promise<RoomListItem[]> {
  const payload = await requestJson<{ items: RoomListItem[] }>('/api/me/rooms');
  return payload.items;
}

export async function getActiveRooms(): Promise<ActiveRoomListItem[]> {
  const payload = await requestJson<{ items: ActiveRoomListItem[] }>('/api/rooms');
  return payload.items;
}

export async function createRoom(roomName: string, nickname?: string): Promise<RoomSummary> {
  return requestJson<RoomSummary>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      roomName,
      ...(nickname ? { nickname } : {}),
    }),
  });
}

export async function joinRoom(roomId: string, nickname?: string): Promise<JoinResult> {
  return requestJson<JoinResult>(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: JSON.stringify(nickname ? { nickname } : {}),
  });
}

export async function leaveRoom(roomId: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/rooms/${roomId}/leave`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function dissolveRoom(roomId: string): Promise<RoomSummary> {
  return requestJson<RoomSummary>(`/api/rooms/${roomId}/dissolve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getRoom(roomId: string): Promise<RoomSummary> {
  return requestJson<RoomSummary>(`/api/rooms/${roomId}`);
}

export async function getRoomPresence(roomId: string): Promise<RoomPresenceSnapshotPayload> {
  return requestJson<RoomPresenceSnapshotPayload>(`/api/rooms/${roomId}/presence`);
}

export async function getMessages(roomId: string, cursor?: number): Promise<MessagePage> {
  const query = cursor ? `?cursor=${cursor}` : '';
  return requestJson<MessagePage>(`/api/rooms/${roomId}/messages${query}`);
}

export async function markRoomRead(roomId: string, messageId: number): Promise<RoomReadState> {
  return requestJson<RoomReadState>(`/api/rooms/${roomId}/read`, {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  });
}

export async function recallMessage(roomId: string, messageId: number): Promise<ChatMessage> {
  return requestJson<ChatMessage>(`/api/rooms/${roomId}/messages/${messageId}/recall`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function editMessage(
  roomId: string,
  messageId: number,
  payload: { text: string; mentionAll?: boolean; mentionedIps?: string[] },
): Promise<ChatMessage> {
  return requestJson<ChatMessage>(`/api/rooms/${roomId}/messages/${messageId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function editTaskMessage(
  roomId: string,
  messageId: number,
  payload: { text: string },
): Promise<ChatMessage> {
  return requestJson<ChatMessage>(`/api/rooms/${roomId}/messages/${messageId}/task`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function convertMessageToTask(roomId: string, messageId: number): Promise<ChatMessage> {
  return requestJson<ChatMessage>(`/api/rooms/${roomId}/messages/${messageId}/task`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function updateMessageTaskItem(
  roomId: string,
  messageId: number,
  taskItemId: string,
  completed: boolean,
): Promise<ChatMessage> {
  return requestJson<ChatMessage>(`/api/rooms/${roomId}/messages/${messageId}/task-items/${taskItemId}`, {
    method: 'PUT',
    body: JSON.stringify({ completed }),
  });
}

export async function uploadAttachment(
  roomId: string,
  file: File,
  onProgress?: (payload: UploadProgressPayload) => void,
): Promise<ChatMessage> {
  const formData = new FormData();
  formData.set('file', file);

  return new Promise<ChatMessage>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${roomId}/attachments`);
    xhr.responseType = 'text';

    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size || 0;
      const loaded = event.loaded;
      const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      onProgress?.({ loaded, total: total > 0 ? total : null, percent });
    };

    xhr.onerror = () => {
      reject(new ApiError('附件上传失败，请检查网络连接', 0));
    };

    xhr.onload = () => {
      const status = xhr.status;
      const raw = xhr.responseText || '';

      if (status >= 200 && status < 300) {
        try {
          resolve(JSON.parse(raw) as ChatMessage);
        } catch {
          reject(new ApiError('附件上传成功，但响应解析失败', status));
        }
        return;
      }

      try {
        const payload = JSON.parse(raw) as { error?: string };
        reject(new ApiError(payload.error ?? `请求失败 (${status})`, status));
      } catch {
        reject(new ApiError(`请求失败 (${status})`, status));
      }
    };

    xhr.send(formData);
  });
}



export async function uploadPendingAttachment(
  roomId: string,
  file: File,
  onProgress?: (payload: UploadProgressPayload) => void,
): Promise<PendingUploadSummary> {
  const formData = new FormData();
  formData.set('file', file);

  return new Promise<PendingUploadSummary>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${roomId}/pending-uploads`);
    xhr.responseType = 'text';

    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size || 0;
      const loaded = event.loaded;
      const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      onProgress?.({ loaded, total: total > 0 ? total : null, percent });
    };

    xhr.onerror = () => {
      reject(new ApiError('附件上传失败，请检查网络连接', 0));
    };

    xhr.onload = () => {
      const status = xhr.status;
      const raw = xhr.responseText || '';

      if (status >= 200 && status < 300) {
        try {
          resolve(JSON.parse(raw) as PendingUploadSummary);
        } catch {
          reject(new ApiError('附件上传成功，但响应解析失败', status));
        }
        return;
      }

      try {
        const payload = JSON.parse(raw) as { error?: string };
        reject(new ApiError(payload.error ?? `请求失败 (${status})`, status));
      } catch {
        reject(new ApiError(`请求失败 (${status})`, status));
      }
    };

    xhr.send(formData);
  });
}

export async function commitPendingUploads(
  roomId: string,
  payload: {
    uploadIds: string[];
    text?: string;
    mentionAll?: boolean;
    mentionedIps?: string[];
    replyMessageId?: number;
  },
): Promise<CommitPendingUploadsResult> {
  return requestJson<CommitPendingUploadsResult>(`/api/rooms/${roomId}/pending-uploads/commit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deletePendingUpload(roomId: string, uploadId: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/rooms/${roomId}/pending-uploads/${uploadId}`, {
    method: 'DELETE',
  });
}

export async function getServerFiles(adminPassword?: string): Promise<StoredFileListResponse> {
  return requestJson<StoredFileListResponse>('/api/server/files', {
    headers: getCleanupPasswordHeaders(adminPassword),
  });
}

export async function deleteServerFiles(messageIds: number[], adminPassword?: string): Promise<DeleteStoredFilesResponse> {
  return requestJson<DeleteStoredFilesResponse>('/api/server/files/delete', {
    method: 'POST',
    headers: getCleanupPasswordHeaders(adminPassword),
    body: JSON.stringify({ messageIds }),
  });
}

export async function openServerFileFolder(messageId: number, adminPassword?: string): Promise<OpenStoredFileFolderResponse> {
  return requestJson<OpenStoredFileFolderResponse>(`/api/server/files/${messageId}/open-folder`, {
    method: 'POST',
    headers: getCleanupPasswordHeaders(adminPassword),
    body: JSON.stringify({}),
  });
}

export async function getManagedRooms(adminPassword?: string): Promise<ManagedRoomListResponse> {
  return requestJson<ManagedRoomListResponse>('/api/server/rooms', {
    headers: getCleanupPasswordHeaders(adminPassword),
  });
}

export async function dissolveManagedRooms(roomIds: string[], adminPassword?: string): Promise<AdminDissolveRoomsResponse> {
  return requestJson<AdminDissolveRoomsResponse>('/api/server/rooms/dissolve', {
    method: 'POST',
    headers: getCleanupPasswordHeaders(adminPassword),
    body: JSON.stringify({ roomIds }),
  });
}

export async function restoreManagedRoom(roomId: string, adminPassword?: string): Promise<AdminRestoreRoomResponse> {
  return requestJson<AdminRestoreRoomResponse>(`/api/server/rooms/${roomId}/restore`, {
    method: 'POST',
    headers: getCleanupPasswordHeaders(adminPassword),
    body: JSON.stringify({}),
  });
}

export async function getFeishuBotSettings(adminPassword?: string): Promise<FeishuBotSettings> {
  return requestJson<FeishuBotSettings>('/api/server/feishu-settings', {
    headers: getCleanupPasswordHeaders(adminPassword),
  });
}

export async function getHotfixSettings(adminPassword?: string): Promise<HotfixSettings> {
  return requestJson<HotfixSettings>('/api/server/hotfix-settings', {
    headers: getCleanupPasswordHeaders(adminPassword),
  });
}

export async function updateFeishuBotSettings(
  payload: { webhookUrl: string; members: FeishuBotSettings['members'] },
  adminPassword?: string,
): Promise<FeishuBotSettings> {
  return requestJson<FeishuBotSettings>('/api/server/feishu-settings', {
    method: 'PUT',
    headers: getCleanupPasswordHeaders(adminPassword),
    body: JSON.stringify(payload),
  });
}

export async function updateHotfixSettings(
  payload: { documentId: string },
  adminPassword?: string,
): Promise<HotfixSettings> {
  return requestJson<HotfixSettings>('/api/server/hotfix-settings', {
    method: 'PUT',
    headers: getCleanupPasswordHeaders(adminPassword),
    body: JSON.stringify(payload),
  });
}

export async function refreshHotfixAuth(adminPassword?: string): Promise<HotfixSettings> {
  return requestJson<HotfixSettings>('/api/server/hotfix-settings/auth', {
    method: 'POST',
    headers: getCleanupPasswordHeaders(adminPassword),
    body: JSON.stringify({}),
  });
}

export async function getTaskNotifyConfig(roomId: string): Promise<FeishuBotPublicConfig> {
  return requestJson<FeishuBotPublicConfig>(`/api/rooms/${roomId}/task-notify-config`);
}

export async function fetchHotfixContent(roomId: string): Promise<HotfixDocumentResult> {
  return requestJson<HotfixDocumentResult>(`/api/rooms/${roomId}/hotfix-content`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function refreshHotfixTask(roomId: string, messageId: number): Promise<HotfixTaskRefreshResult> {
  return requestJson<HotfixTaskRefreshResult>(`/api/rooms/${roomId}/messages/${messageId}/hotfix-refresh`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function sendTaskNotification(
  roomId: string,
  messageId: number,
  payload: { recipientMemberIds: string[] },
): Promise<ChatMessage> {
  const response = await requestJson<{ ok: boolean; message: ChatMessage }>(`/api/rooms/${roomId}/messages/${messageId}/task-notify`, {
    method: 'POST',
    body: JSON.stringify({
      recipientMemberIds: payload.recipientMemberIds,
    }),
  });

  return response.message;
}
