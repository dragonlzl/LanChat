import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, relative, resolve } from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { Server as SocketIOServer } from 'socket.io';
import { openDatabase } from './db.js';
import { getRequestIp, getSocketIp } from './ip.js';
import { configureLogger, logError, logInfo, logWarn } from './logger.js';
import { ChatRepository, HttpError } from './repository.js';
import type {
  AdminDissolveRoomsResult,
  AdminRestoreRoomResult,
  AppConfig,
  HomeRoomPresencePayload,
  ManagedRoomListResponse,
  MemberPresencePayload,
  OpenStoredFileFolderResult,
  RoomDissolvedPayload,
  RoomPresenceSnapshotPayload,
  StoredFileListResponse,
} from './types.js';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE = 1024 * 1024 * 1024;
const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);
const ADMIN_PASSWORD = process.env.WEBCHAT_ADMIN_PASSWORD?.trim() || 'admin';

function getRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }

  return value ?? '';
}

function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void> | void,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function safeUnlink(filePath: string | undefined) {
  if (!filePath) {
    return;
  }

  try {
    unlinkSync(filePath);
  } catch {
    return;
  }
}

function isPreviewableImage(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIMES.has(mimeType);
}

function getAdminPasswordHeader(request: Request): string {
  const header = request.headers['x-admin-password'];
  if (Array.isArray(header)) {
    return header[0]?.trim() ?? '';
  }

  return typeof header === 'string' ? header.trim() : '';
}

function requireCleanupAdmin(request: Request, ip: string) {
  const providedPassword = getAdminPasswordHeader(request);
  if (providedPassword === ADMIN_PASSWORD) {
    return;
  }

  logWarn('file_cleanup', '服务器文件清理密码校验失败', { ip });
  throw new HttpError(401, '管理员密码错误');
}

function requireRoomManageAdmin(request: Request, ip: string) {
  const providedPassword = getAdminPasswordHeader(request);
  if (providedPassword === ADMIN_PASSWORD) {
    return;
  }

  logWarn('room_manage', '房间管理密码校验失败', { ip });
  throw new HttpError(401, '管理员密码错误');
}

function openFolderInFileManager(folderPath: string): Promise<void> {
  const normalizedPath = process.platform === 'win32' ? folderPath.replace(/\//g, '\\') : folderPath;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';

  return new Promise((resolveOpen, rejectOpen) => {
    const child = spawn(command, [normalizedPath], { stdio: 'ignore' });
    let settled = false;

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectOpen(error);
    });

    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;

      if (code === 0 || code === null) {
        resolveOpen();
        return;
      }

      rejectOpen(new Error(`${command} exited with code ${code}`));
    });
  });
}

export function createChatApp(config: AppConfig) {
  configureLogger(config.logsDir);
  mkdirSync(config.uploadsDir, { recursive: true });
  const database = openDatabase(config.databasePath);
  const repository = new ChatRepository(database);

  logInfo('server', '聊天服务初始化完成', {
    databasePath: config.databasePath,
    uploadsDir: config.uploadsDir,
    logsDir: config.logsDir,
    webDistDir: config.webDistDir,
  });

  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });
  let closed = false;

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use((request, response, next) => {
    const startedAt = process.hrtime.bigint();
    const ip = getRequestIp(request, config.allowDebugIp);

    response.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logInfo('http', `${request.method} ${request.originalUrl}`, {
        ip,
        status: response.statusCode,
        durationMs: durationMs.toFixed(1),
        contentLength: request.headers['content-length'],
      });
    });

    next();
  });

  httpServer.requestTimeout = 0;
  httpServer.timeout = 0;

  const storage = multer.diskStorage({
    destination: (request, _file, callback) => {
      const roomId = getRouteParam(request.params.roomId);
      const roomDir = resolve(config.uploadsDir, roomId);
      mkdirSync(roomDir, { recursive: true });
      callback(null, roomDir);
    },
    filename: (_request, file, callback) => {
      const extension = extname(file.originalname) || '.bin';
      const safeExtension = extension.replace(/[^.a-zA-Z0-9]/g, '') || '.bin';
      callback(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExtension}`);
    },
  });

  const imageUpload = multer({
    storage,
    limits: { fileSize: MAX_IMAGE_SIZE },
    fileFilter: (_request, file, callback) => {
      if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
        callback(new HttpError(400, '仅支持 png、jpg、jpeg、webp、gif 图片'));
        return;
      }

      callback(null, true);
    },
  });

  const attachmentUpload = multer({
    storage,
    limits: { fileSize: MAX_ATTACHMENT_SIZE },
  });

  const emitProfileUpdate = (ip: string, roomIds: string[]) => {
    for (const roomId of roomIds) {
      io.to(roomId).emit('member:updated', repository.getMemberEvent(roomId, ip));
    }
  };

  const roomPresenceMap = new Map<string, Map<string, Set<string>>>();
  const socketPresenceMap = new Map<string, { roomId: string; ip: string }>();

  function getRoomOnlineMemberIps(roomId: string): string[] {
    const roomPresence = roomPresenceMap.get(roomId);
    if (!roomPresence) {
      return [];
    }

    return Array.from(roomPresence.entries())
      .filter(([, socketIds]) => socketIds.size > 0)
      .map(([memberIp]) => memberIp)
      .sort();
  }

  function getRoomChattingMemberCount(roomId: string): number {
    return getRoomOnlineMemberIps(roomId).length;
  }

  function decorateRoomChattingCount<T extends { roomId: string }>(item: T): T & { chattingMemberCount: number; onlineMemberCount: number } {
    const onlineMemberCount = getRoomChattingMemberCount(item.roomId);
    return {
      ...item,
      chattingMemberCount: onlineMemberCount,
      onlineMemberCount,
    };
  }

  function decorateRoomChattingCounts<T extends { roomId: string }>(items: T[]): Array<T & { chattingMemberCount: number; onlineMemberCount: number }> {
    return items.map((item) => decorateRoomChattingCount(item));
  }

  function emitHomeRoomPresence(roomId: string) {
    io.emit('home:roomPresence', {
      roomId,
      onlineMemberCount: getRoomChattingMemberCount(roomId),
    } satisfies HomeRoomPresencePayload);
  }

  function emitHomeRoomsChanged(roomId?: string) {
    io.emit('home:roomsChanged', roomId ? { roomId } : {});
  }

  function removeSocketPresence(socketId: string) {
    const current = socketPresenceMap.get(socketId);
    if (!current) {
      return null;
    }

    const roomPresence = roomPresenceMap.get(current.roomId);
    const socketIds = roomPresence?.get(current.ip);
    if (!roomPresence || !socketIds) {
      socketPresenceMap.delete(socketId);
      return null;
    }

    socketIds.delete(socketId);
    socketPresenceMap.delete(socketId);

    const becameOffline = socketIds.size === 0;
    if (becameOffline) {
      roomPresence.delete(current.ip);
    }

    if (roomPresence.size === 0) {
      roomPresenceMap.delete(current.roomId);
    }

    return { ...current, becameOffline };
  }

  function addSocketPresence(roomId: string, ip: string, socketId: string) {
    const removedPresence = removeSocketPresence(socketId);
    const roomPresence = roomPresenceMap.get(roomId) ?? new Map<string, Set<string>>();
    const socketIds = roomPresence.get(ip) ?? new Set<string>();
    const becameOnline = socketIds.size === 0;

    socketIds.add(socketId);
    roomPresence.set(ip, socketIds);
    roomPresenceMap.set(roomId, roomPresence);
    socketPresenceMap.set(socketId, { roomId, ip });

    return {
      previous: removedPresence,
      becameOnline,
      onlineMemberIps: getRoomOnlineMemberIps(roomId),
    };
  }


  const handlePendingAttachmentUpload = (request: Request, response: Response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const file = request.file;
    if (!file) {
      throw new HttpError(400, '请选择文件');
    }

    const type = isPreviewableImage(file.mimetype) ? 'image' : 'file';
    if (type === 'image' && file.size > MAX_IMAGE_SIZE) {
      safeUnlink(file.path);
      throw new HttpError(400, '图片大小不能超过 10MB');
    }

    try {
      const relativePath = relative(config.uploadsDir, file.path).split('\\').join('/');
      const pendingUpload = repository.createPendingUpload(roomId, ip, randomUUID(), {
        relativePath,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        type,
      });
      logInfo('pending_upload', '附件已上传待发送区', {
        ip,
        roomId,
        uploadId: pendingUpload.uploadId,
        type,
        name: file.originalname,
        size: file.size,
      });
      response.status(201).json(pendingUpload);
    } catch (error) {
      safeUnlink(file.path);
      logWarn('pending_upload', '待发送附件上传失败', {
        ip,
        roomId,
        name: file.originalname,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  };

  const handleAttachmentUpload = (request: Request, response: Response, fieldName: 'image' | 'file') => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const file = request.file;
    if (!file) {
      throw new HttpError(400, '请选择文件');
    }

    const type = fieldName === 'image'
      ? 'image'
      : isPreviewableImage(file.mimetype)
        ? 'image'
        : 'file';

    if (fieldName === 'image' && !isPreviewableImage(file.mimetype)) {
      safeUnlink(file.path);
      throw new HttpError(400, '仅支持 png、jpg、jpeg、webp、gif 图片');
    }

    if (type === 'image' && file.size > MAX_IMAGE_SIZE) {
      safeUnlink(file.path);
      throw new HttpError(400, '图片大小不能超过 10MB');
    }

    try {
      const relativePath = relative(config.uploadsDir, file.path).split('\\').join('/');
      const message = repository.addAttachmentMessage(roomId, ip, {
        relativePath,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        type,
      });
      logInfo('file_upload', '附件上传成功', {
        ip,
        roomId,
        messageId: message.id,
        type,
        name: file.originalname,
        size: file.size,
      });
      io.to(message.roomId).emit('message:new', message);
      response.status(201).json(message);
    } catch (error) {
      safeUnlink(file.path);
      logWarn('file_upload', '附件上传失败', {
        ip,
        roomId,
        fieldName,
        name: file.originalname,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  };

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/me', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    response.json(repository.getMe(ip));
  });

  app.put('/api/me', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const result = repository.updateProfile(ip, request.body?.nickname ?? '');
    logInfo('profile', '昵称已更新', { ip, nickname: result.me.nickname, affectedRooms: result.affectedRoomIds.length });
    emitProfileUpdate(ip, result.affectedRoomIds);
    response.json(result.me);
  });

  app.get('/api/me/rooms', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    response.json({ items: decorateRoomChattingCounts(repository.listRoomsForMember(ip)) });
  });

  app.get('/api/rooms', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    response.json({ items: decorateRoomChattingCounts(repository.listActiveRooms(ip)) });
  });

  app.post('/api/rooms', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const room = repository.createRoom(ip, request.body?.roomName ?? '', request.body?.nickname);
    logInfo('room', '群组已创建', { ip, roomId: room.roomId, roomName: room.roomName });
    emitHomeRoomPresence(room.roomId);
    emitHomeRoomsChanged(room.roomId);
    response.status(201).json(decorateRoomChattingCount(room));
  });

  app.post('/api/rooms/:roomId/join', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const result = repository.joinRoom(getRouteParam(request.params.roomId).toUpperCase(), ip, request.body?.nickname);
    logInfo('room', result.joined ? '加入群组成功' : '已在群组中，复用现有成员身份', { ip, roomId: result.room.roomId, roomName: result.room.roomName });
    if (result.joined) {
      io.to(result.room.roomId).emit('member:joined', repository.getMemberEvent(result.room.roomId, ip));
      emitHomeRoomPresence(result.room.roomId);
      emitHomeRoomsChanged(result.room.roomId);
    }
    response.json({
      ...result,
      room: decorateRoomChattingCount(result.room),
    });
  });

  app.post('/api/rooms/:roomId/leave', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const member = repository.leaveRoom(roomId, ip);
    logInfo('room', '成员已退出群组', { ip, roomId, nickname: member.nickname });
    io.to(roomId).emit('member:left', { roomId, member });
    emitHomeRoomPresence(roomId);
    emitHomeRoomsChanged(roomId);
    response.json({ ok: true });
  });

  app.post('/api/rooms/:roomId/dissolve', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const room = repository.dissolveRoom(roomId, ip);
    logWarn('room', '群组已解散', { ip, roomId, roomName: room.roomName });
    const payload: RoomDissolvedPayload = {
      roomId,
      dissolvedAt: room.dissolvedAt ?? new Date().toISOString(),
    };
    io.to(roomId).emit('room:dissolved', payload);
    emitHomeRoomPresence(roomId);
    emitHomeRoomsChanged(roomId);
    response.json(decorateRoomChattingCount(room));
  });

  app.get('/api/rooms/:roomId', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    response.json(decorateRoomChattingCount(repository.getRoom(getRouteParam(request.params.roomId).toUpperCase(), ip)));
  });

  app.get('/api/rooms/:roomId/presence', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    repository.getRoom(roomId, ip);
    response.json({
      roomId,
      onlineMemberIps: getRoomOnlineMemberIps(roomId),
    } satisfies RoomPresenceSnapshotPayload);
  });

  app.get('/api/rooms/:roomId/messages', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const rawCursor = request.query.cursor;
    const cursor = typeof rawCursor === 'string' ? Number(rawCursor) : undefined;
    response.json(repository.listMessages(getRouteParam(request.params.roomId).toUpperCase(), ip, Number.isFinite(cursor) ? cursor : undefined));
  });

  app.post('/api/rooms/:roomId/read', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const messageId = Number(request.body?.messageId);

    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new HttpError(400, '无效的消息 ID');
    }

    const state = repository.markRoomReadUpTo(roomId, ip, messageId);
    logInfo('message', '房间消息已读进度更新', { ip, roomId, messageId, unreadMentionCount: state.unreadMentionCount });
    response.json(state);
  });

  app.put('/api/rooms/:roomId/messages/:messageId', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const messageId = Number(getRouteParam(request.params.messageId));
    const text = typeof request.body?.text === 'string' ? request.body.text : '';
    const mentionAll = Boolean(request.body?.mentionAll);
    const mentionedIps = Array.isArray(request.body?.mentionedIps)
      ? request.body.mentionedIps.filter((value: unknown): value is string => typeof value === 'string')
      : [];

    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new HttpError(400, '无效的消息 ID');
    }

    const message = repository.editTextMessage(roomId, messageId, ip, text, { mentionAll, mentionedIps });
    logInfo('message', '消息已编辑', { ip, roomId, messageId, length: text.trim().length, mentionAll: message.mentionAll, mentionedCount: message.mentionedIps.length });
    io.to(roomId).emit('message:edited', message);
    response.json(message);
  });

  app.post('/api/rooms/:roomId/messages/:messageId/task', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const messageId = Number(getRouteParam(request.params.messageId));

    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new HttpError(400, '无效的消息 ID');
    }

    const message = repository.convertTextMessageToTask(roomId, messageId, ip);
    logInfo('message', '消息已转任务', { ip, roomId, messageId, taskSectionCount: message.taskContent?.sections.length ?? 0 });
    io.to(roomId).emit('message:taskUpdated', message);
    response.json(message);
  });

  app.put('/api/rooms/:roomId/messages/:messageId/task-items/:taskItemId', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const messageId = Number(getRouteParam(request.params.messageId));
    const taskItemId = getRouteParam(request.params.taskItemId);
    const completed = request.body?.completed;

    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new HttpError(400, '无效的消息 ID');
    }
    if (typeof completed !== 'boolean') {
      throw new HttpError(400, '无效的任务状态');
    }

    const message = repository.updateTaskMessageItem(roomId, messageId, taskItemId, completed, ip);
    logInfo('message', '任务勾选状态已更新', { ip, roomId, messageId, taskItemId, completed });
    io.to(roomId).emit('message:taskUpdated', message);
    response.json(message);
  });

  app.post('/api/rooms/:roomId/messages/:messageId/recall', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const messageId = Number(getRouteParam(request.params.messageId));

    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new HttpError(400, '无效的消息 ID');
    }

    const result = repository.recallMessage(roomId, messageId, ip);
    logInfo('message', '消息已撤回', { ip, roomId, messageId, type: result.message.type });
    if (result.deletedRelativePath) {
      safeUnlink(resolve(config.uploadsDir, result.deletedRelativePath));
    }
    io.to(roomId).emit('message:recalled', result.message);
    response.json(result.message);
  });

  app.post(
    '/api/rooms/:roomId/images',
    asyncHandler(async (request, response, next) => {
      const ip = getRequestIp(request, config.allowDebugIp);
      const roomId = getRouteParam(request.params.roomId).toUpperCase();
      repository.getRoomAccess(roomId, ip);
      logInfo('file_upload', '图片上传开始', { ip, roomId, contentLength: request.headers['content-length'] });
      next();
    }),
    imageUpload.single('image'),
    (request, response) => handleAttachmentUpload(request, response, 'image'),
  );

  app.post(
    '/api/rooms/:roomId/attachments',
    asyncHandler(async (request, _response, next) => {
      const ip = getRequestIp(request, config.allowDebugIp);
      const roomId = getRouteParam(request.params.roomId).toUpperCase();
      repository.getRoomAccess(roomId, ip);
      logInfo('file_upload', '文件上传开始', { ip, roomId, contentLength: request.headers['content-length'] });
      next();
    }),
    attachmentUpload.single('file'),
    (request, response) => handleAttachmentUpload(request, response, 'file'),
  );


  app.post(
    '/api/rooms/:roomId/pending-uploads',
    asyncHandler(async (request, _response, next) => {
      const ip = getRequestIp(request, config.allowDebugIp);
      const roomId = getRouteParam(request.params.roomId).toUpperCase();
      repository.getRoomAccess(roomId, ip);
      logInfo('pending_upload', '待发送附件上传开始', { ip, roomId, contentLength: request.headers['content-length'] });
      next();
    }),
    attachmentUpload.single('file'),
    (request, response) => handlePendingAttachmentUpload(request, response),
  );

  app.delete('/api/rooms/:roomId/pending-uploads/:uploadId', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const uploadId = getRouteParam(request.params.uploadId).trim();

    if (!uploadId) {
      throw new HttpError(400, '无效的上传 ID');
    }

    const relativePath = repository.deletePendingUpload(roomId, uploadId, ip);
    if (relativePath) {
      safeUnlink(resolve(config.uploadsDir, relativePath));
      logInfo('pending_upload', '待发送附件已移除', { ip, roomId, uploadId });
    }

    response.json({ ok: true });
  });

  app.post('/api/rooms/:roomId/pending-uploads/commit', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const rawUploadIds: unknown[] = Array.isArray(request.body?.uploadIds) ? request.body.uploadIds : [];
    const uploadIds = rawUploadIds
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());

    const result = repository.commitPendingUploads(roomId, ip, uploadIds);
    for (const message of result.items) {
      io.to(message.roomId).emit('message:new', message);
    }

    logInfo('pending_upload', '待发送附件已正式发送', {
      ip,
      roomId,
      committedCount: result.items.length,
      requestedCount: uploadIds.length,
    });

    response.json(result);
  });

  app.get('/api/rooms/:roomId/messages/:messageId/content', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const messageId = Number(getRouteParam(request.params.messageId));

    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new HttpError(400, '无效的消息 ID');
    }

    const attachment = repository.getAttachmentAccess(roomId, messageId, ip);
    const absolutePath = resolve(config.uploadsDir, attachment.relativePath);
    logInfo('file_download', '附件内容访问', { ip, roomId, messageId, type: attachment.type, name: attachment.originalName });
    response.type(attachment.mimeType);
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`);
    response.sendFile(absolutePath);
  });


  app.get('/api/server/files', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    requireCleanupAdmin(request, ip);
    const allItems = repository.listStoredFiles();
    let missingCount = 0;
    const items = allItems.filter((item) => {
      const fileExists = existsSync(resolve(config.uploadsDir, item.relativePath));
      if (!fileExists) {
        missingCount += 1;
      }
      return fileExists;
    });
    const totalSize = items.reduce((sum, item) => sum + item.fileSize, 0);

    if (missingCount > 0) {
      logWarn('file_cleanup', '发现数据库中引用的附件文件缺失', { ip, missingCount });
    }

    logInfo('file_cleanup', '读取服务器文件列表', { ip, totalCount: items.length, totalSize, missingCount });
    response.json({
      items,
      totalCount: items.length,
      totalSize,
      missingCount,
      storageRootPath: config.uploadsDir,
    } satisfies StoredFileListResponse);
  });

  app.post(
    '/api/server/files/:messageId/open-folder',
    asyncHandler(async (request, response) => {
      const ip = getRequestIp(request, config.allowDebugIp);
      requireCleanupAdmin(request, ip);
      const messageId = Number(getRouteParam(request.params.messageId));

      if (!Number.isInteger(messageId) || messageId <= 0) {
        throw new HttpError(400, '无效的文件 ID');
      }

      const item = repository.listStoredFiles().find((entry) => entry.messageId === messageId);
      if (!item) {
        throw new HttpError(404, '未找到对应文件');
      }

      const folderPath = dirname(resolve(config.uploadsDir, item.relativePath));
      if (!existsSync(folderPath)) {
        throw new HttpError(404, '附件所在文件夹不存在');
      }

      try {
        await (config.openPathInFileManager?.(folderPath) ?? openFolderInFileManager(folderPath));
      } catch (error) {
        logError('file_cleanup', '打开附件目录失败', {
          ip,
          messageId,
          folderPath,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new HttpError(500, `打开文件夹失败，请直接查看服务器目录：${folderPath}`);
      }

      logInfo('file_cleanup', '已在服务器上打开附件目录', { ip, messageId, folderPath });
      response.json({ ok: true, folderPath } satisfies OpenStoredFileFolderResult);
    }),
  );

  app.post('/api/server/files/delete', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    requireCleanupAdmin(request, ip);
    const rawIds: unknown[] = Array.isArray(request.body?.messageIds) ? request.body.messageIds : [];
    const messageIds = rawIds
      .filter((value): value is number => Number.isInteger(value) && Number(value) > 0)
      .map((value) => Number(value));

    if (messageIds.length === 0) {
      throw new HttpError(400, '请选择要删除的文件');
    }

    const result = repository.cleanupStoredFiles(messageIds, `server:cleanup:${ip}`);
    for (const relativePath of result.deletedRelativePaths) {
      safeUnlink(resolve(config.uploadsDir, relativePath));
    }
    for (const message of result.items) {
      io.to(message.roomId).emit('message:recalled', message);
    }

    logWarn('file_cleanup', '服务器文件已批量清理', {
      ip,
      requestedCount: messageIds.length,
      cleanedCount: result.cleanedCount,
      cleanedSize: result.cleanedSize,
      skippedCount: result.skippedCount,
    });

    response.json({
      cleanedCount: result.cleanedCount,
      cleanedSize: result.cleanedSize,
      skippedCount: result.skippedCount,
    });
  });

  app.get('/api/server/rooms', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    requireRoomManageAdmin(request, ip);
    const items = decorateRoomChattingCounts(repository.listManagedRooms());

    logInfo('room_manage', '读取房间管理列表', {
      ip,
      totalCount: items.length,
      activeCount: items.filter((item) => item.status === 'active').length,
      dissolvedCount: items.filter((item) => item.status === 'dissolved').length,
    });

    response.json({
      items,
      totalCount: items.length,
    } satisfies ManagedRoomListResponse);
  });

  app.post('/api/server/rooms/dissolve', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    requireRoomManageAdmin(request, ip);
    const rawIds: unknown[] = Array.isArray(request.body?.roomIds) ? request.body.roomIds : [];
    const roomIds = rawIds
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim().toUpperCase());

    if (roomIds.length === 0) {
      throw new HttpError(400, '请选择要解散的房间');
    }

    const result = repository.adminDissolveRooms(roomIds);
    for (const room of result.dissolvedRooms) {
      io.to(room.roomId).emit('room:dissolved', room);
      emitHomeRoomPresence(room.roomId);
      emitHomeRoomsChanged(room.roomId);
    }

    logWarn('room_manage', '管理员批量解散房间', {
      ip,
      requestedCount: roomIds.length,
      dissolvedCount: result.dissolvedCount,
      skippedCount: result.skippedCount,
    });

    response.json({
      dissolvedRooms: result.dissolvedRooms,
      dissolvedCount: result.dissolvedCount,
      skippedCount: result.skippedCount,
    } satisfies AdminDissolveRoomsResult);
  });

  app.post('/api/server/rooms/:roomId/restore', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    requireRoomManageAdmin(request, ip);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const room = repository.restoreManagedRoom(roomId);

    logInfo('room_manage', '管理员恢复房间', {
      ip,
      roomId: room.roomId,
      roomName: room.roomName,
    });

    emitHomeRoomPresence(room.roomId);
    emitHomeRoomsChanged(room.roomId);
    response.json({ room } satisfies AdminRestoreRoomResult);
  });

  app.get('/api/rooms/:roomId/messages/:messageId/download', (request, response) => {
    const ip = getRequestIp(request, config.allowDebugIp);
    const roomId = getRouteParam(request.params.roomId).toUpperCase();
    const messageId = Number(getRouteParam(request.params.messageId));

    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new HttpError(400, '无效的消息 ID');
    }

    const attachment = repository.getAttachmentAccess(roomId, messageId, ip);
    const absolutePath = resolve(config.uploadsDir, attachment.relativePath);
    logInfo('file_download', '附件下载开始', { ip, roomId, messageId, type: attachment.type, name: attachment.originalName, size: attachment.size });
    response.download(absolutePath, attachment.originalName);
  });

  io.on('connection', (socket) => {
    const ip = getSocketIp(socket, config.allowDebugIp);
    logInfo('socket', '连接已建立', { ip, socketId: socket.id });

    socket.on('disconnect', (reason) => {
      const removedPresence = removeSocketPresence(socket.id);
      if (removedPresence?.becameOffline) {
        io.to(removedPresence.roomId).emit('member:presence', {
          roomId: removedPresence.roomId,
          memberIp: removedPresence.ip,
          isOnline: false,
        } satisfies MemberPresencePayload);
        emitHomeRoomPresence(removedPresence.roomId);
        emitHomeRoomsChanged(removedPresence.roomId);
      }

      logInfo('socket', '连接已断开', { ip, socketId: socket.id, reason });
    });

    socket.on('room:joinLive', ({ roomId }: { roomId?: string }, acknowledge?: (payload: unknown) => void) => {
      try {
        if (!roomId) {
          throw new HttpError(400, '缺少 roomId');
        }

        const room = repository.getRoom(roomId.toUpperCase(), ip);
        socket.join(room.roomId);
        const presence = addSocketPresence(room.roomId, ip, socket.id);

        if (presence.previous && presence.previous.roomId !== room.roomId) {
          socket.leave(presence.previous.roomId);

          if (presence.previous.becameOffline) {
            io.to(presence.previous.roomId).emit('member:presence', {
              roomId: presence.previous.roomId,
              memberIp: presence.previous.ip,
              isOnline: false,
            } satisfies MemberPresencePayload);
            emitHomeRoomPresence(presence.previous.roomId);
            emitHomeRoomsChanged(presence.previous.roomId);
          }
        }

        if (presence.becameOnline) {
          io.to(room.roomId).emit('member:presence', {
            roomId: room.roomId,
            memberIp: ip,
            isOnline: true,
          } satisfies MemberPresencePayload);
          emitHomeRoomPresence(room.roomId);
          emitHomeRoomsChanged(room.roomId);
        }

        logInfo('socket', '加入实时房间成功', { ip, socketId: socket.id, roomId: room.roomId });
        acknowledge?.({
          ok: true,
          roomId: room.roomId,
          onlineMemberIps: presence.onlineMemberIps,
        } satisfies ({ ok: true } & RoomPresenceSnapshotPayload));
      } catch (error) {
        const message = error instanceof Error ? error.message : '加入实时通道失败';
        logWarn('socket', '加入实时房间失败', { ip, socketId: socket.id, roomId, error: message });
        socket.emit('room:error', { roomId, message });
        acknowledge?.({ ok: false, message });
      }
    });

    socket.on(
      'message:text',
      (
        {
          roomId,
          text,
          mentionAll,
          mentionedIps,
        }: { roomId?: string; text?: string; mentionAll?: boolean; mentionedIps?: string[] },
        acknowledge?: (payload: unknown) => void,
      ) => {
        try {
          if (!roomId) {
            throw new HttpError(400, '缺少 roomId');
          }

          const message = repository.addTextMessage(roomId.toUpperCase(), ip, text ?? '', {
            mentionAll,
            mentionedIps,
          });
          logInfo('message', '文本消息已发送', {
            ip,
            socketId: socket.id,
            roomId: message.roomId,
            messageId: message.id,
            length: text?.trim().length ?? 0,
            mentionAll: message.mentionAll,
            mentionedCount: message.mentionedIps.length,
          });
          io.to(message.roomId).emit('message:new', message);
          acknowledge?.({ ok: true, message });
        } catch (error) {
          const message = error instanceof Error ? error.message : '发送消息失败';
          logWarn('message', '文本消息发送失败', { ip, socketId: socket.id, roomId, error: message });
          socket.emit('room:error', { roomId, message });
          acknowledge?.({ ok: false, message });
        }
      },
    );
  });

  if (existsSync(config.webDistDir)) {
    app.use(express.static(config.webDistDir));
    app.get(/.*/, (_request, response, next) => {
      const indexPath = resolve(config.webDistDir, 'index.html');
      response.sendFile(indexPath, (error) => {
        if (error) {
          next(error);
        }
      });
    });
  }

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const ip = getRequestIp(request, config.allowDebugIp);

    if (error instanceof HttpError) {
      logWarn('http_error', error.message, { ip, method: request.method, path: request.originalUrl, status: error.status });
      response.status(error.status).json({ error: error.message });
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      logWarn('http_error', '附件大小超限', { ip, method: request.method, path: request.originalUrl, status: 400 });
      response.status(400).json({ error: '普通附件大小不能超过 1GB，图片仍限制为 10MB' });
      return;
    }

    const message = error instanceof Error ? error.message : '服务异常';
    logError('http_error', '未处理的服务异常', {
      ip,
      method: request.method,
      path: request.originalUrl,
      status: 500,
      error: error instanceof Error ? error.stack ?? error.message : error,
    });
    response.status(500).json({ error: message });
  });

  return {
    app,
    httpServer,
    io,
    repository,
    database,
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      logInfo('server', '开始关闭聊天服务');

      await new Promise<void>((resolveClose, rejectClose) => {
        io.close((socketError) => {
          if (socketError) {
            rejectClose(socketError);
            return;
          }

          if (!httpServer.listening) {
            if (database.open) {
              database.close();
            }
            logInfo('server', '聊天服务已关闭');
            resolveClose();
            return;
          }

          httpServer.close((serverError) => {
            if (serverError) {
              rejectClose(serverError);
              return;
            }

            database.close();
            logInfo('server', '聊天服务已关闭');
            resolveClose();
          });
        });
      });
    },
  };
}
