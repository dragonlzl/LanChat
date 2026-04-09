import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createChatApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import type { AppConfig } from '../src/types.js';

describe('chat server', () => {
  let dataDir: string;
  let config: AppConfig;
  let serverBundle: ReturnType<typeof createChatApp>;
  let baseUrl = '';
  const sockets: Socket[] = [];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'webchat-test-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      databasePath: join(dataDir, 'chat.sqlite'),
      uploadsDir: join(dataDir, 'uploads'),
      logsDir: join(dataDir, 'logs'),
      webDistDir: resolve(dataDir, 'web-dist'),
      allowDebugIp: true,
    };
    serverBundle = createChatApp(config);
    await new Promise<void>((resolveStart) => {
      serverBundle.httpServer.listen(0, '127.0.0.1', () => {
        const address = serverBundle.httpServer.address();
        if (address && typeof address !== 'string') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolveStart();
      });
    });
  });

  afterEach(async () => {
    await Promise.allSettled(
      sockets.map(
        (socket) =>
          new Promise<void>((resolveSocket) => {
            if (socket.disconnected) {
              resolveSocket();
              return;
            }

            socket.once('disconnect', () => resolveSocket());
            socket.disconnect();
            setTimeout(() => resolveSocket(), 200);
          }),
      ),
    );
    await serverBundle.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function debugRequest(ip: string, adminPassword?: string) {
    const withHeaders = (requestBuilder: any) => {
      let chain = requestBuilder.set('x-debug-client-ip', ip);
      if (adminPassword) {
        chain = chain.set('x-admin-password', adminPassword);
      }
      return chain;
    };

    return {
      get: (path: string) => withHeaders(request(baseUrl).get(path)),
      post: (path: string) => withHeaders(request(baseUrl).post(path)),
      put: (path: string) => withHeaders(request(baseUrl).put(path)),
    };
  }

  function connectSocket(ip: string): Promise<Socket> {
    return new Promise((resolveSocket, rejectSocket) => {
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: { debugIp: ip },
      });
      sockets.push(socket);
      socket.once('connect', () => resolveSocket(socket));
      socket.once('connect_error', rejectSocket);
    });
  }

  function buildExpectedReplyPreview(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 72) {
      return normalized;
    }

    return `${normalized.slice(0, 71).trimEnd()}…`;
  }

  it('creates a room and reuses profile nickname', async () => {
    const createResponse = await debugRequest('192.168.0.10').post('/api/rooms').send({ nickname: '阿龙', roomName: '阿龙的房间' });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.roomId).toHaveLength(8);
    expect(createResponse.body.roomName).toBe('阿龙的房间');
    expect(createResponse.body.members).toHaveLength(1);

    const meResponse = await debugRequest('192.168.0.10').get('/api/me');
    expect(meResponse.body.nickname).toBe('阿龙');
  });

  it('writes runtime logs into the data directory', async () => {
    const createResponse = await debugRequest('192.168.0.40').post('/api/rooms').send({ nickname: '日志用户', roomName: '日志房间' });

    expect(createResponse.status).toBe(201);

    const logFile = join(dataDir, 'logs', `app-${new Date().toISOString().slice(0, 10)}.log`);
    expect(existsSync(logFile)).toBe(true);

    const content = readFileSync(logFile, 'utf8');
    expect(content).toContain('[INFO] [room] 群组已创建');
    expect(content).toContain('roomName=日志房间');
    expect(content).toContain('[INFO] [http] POST /api/rooms');
  });

  it('updates global nickname and reflects it in active rooms', async () => {
    const createResponse = await debugRequest('192.168.0.20').post('/api/rooms').send({ nickname: '旧昵称', roomName: '旧昵称的房间' });
    const roomId = createResponse.body.roomId;

    const updateResponse = await debugRequest('192.168.0.20').put('/api/me').send({ nickname: '新昵称' });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.nickname).toBe('新昵称');

    const roomResponse = await debugRequest('192.168.0.20').get(`/api/rooms/${roomId}`);
    expect(roomResponse.body.roomName).toBe('旧昵称的房间');
    expect(roomResponse.body.members[0].nickname).toBe('新昵称');
  });

  it('blocks duplicate nickname on first room creation', async () => {
    const firstCreateResponse = await debugRequest('192.168.0.201').post('/api/rooms').send({ nickname: '重复昵称', roomName: '房间一' });
    expect(firstCreateResponse.status).toBe(201);

    const secondCreateResponse = await debugRequest('192.168.0.202').post('/api/rooms').send({ nickname: '重复昵称', roomName: '房间二' });
    expect(secondCreateResponse.status).toBe(409);
    expect(secondCreateResponse.body.error).toContain('昵称已被其他设备使用');
  });

  it('blocks duplicate nickname when saving profile', async () => {
    const firstCreateResponse = await debugRequest('192.168.0.203').post('/api/rooms').send({ nickname: '唯一昵称', roomName: '房间一' });
    expect(firstCreateResponse.status).toBe(201);

    const updateResponse = await debugRequest('192.168.0.204').put('/api/me').send({ nickname: '唯一昵称' });
    expect(updateResponse.status).toBe(409);
    expect(updateResponse.body.error).toContain('昵称已被其他设备使用');
  });

  it('does not duplicate the same IP in one room', async () => {
    const createResponse = await debugRequest('192.168.0.11').post('/api/rooms').send({ nickname: '房主', roomName: '房主的房间' });
    const roomId = createResponse.body.roomId;

    const joinResponse = await debugRequest('192.168.0.11').post(`/api/rooms/${roomId}/join`).send({});
    expect(joinResponse.status).toBe(200);
    expect(joinResponse.body.joined).toBe(false);

    const roomResponse = await debugRequest('192.168.0.11').get(`/api/rooms/${roomId}`);
    expect(roomResponse.body.members).toHaveLength(1);
  });

  it('lists active rooms with member counts and membership status', async () => {
    const joinedIp = '192.168.0.111';
    const ownerRoomResponse = await debugRequest('192.168.0.112').post('/api/rooms').send({ nickname: '群主一', roomName: '活跃房间一' });
    const joinedRoomId = ownerRoomResponse.body.roomId;
    await debugRequest(joinedIp).post(`/api/rooms/${joinedRoomId}/join`).send({ nickname: '成员一' });

    const otherRoomResponse = await debugRequest('192.168.0.113').post('/api/rooms').send({ nickname: '群主二', roomName: '活跃房间二' });
    const otherRoomId = otherRoomResponse.body.roomId;

    const activeRoomsResponse = await debugRequest(joinedIp).get('/api/rooms');
    expect(activeRoomsResponse.status).toBe(200);

    const joinedRoom = activeRoomsResponse.body.items.find((item: { roomId: string }) => item.roomId === joinedRoomId);
    expect(joinedRoom).toMatchObject({
      roomId: joinedRoomId,
      roomName: '活跃房间一',
      role: 'member',
      memberCount: 2,
    });
    expect(joinedRoom.joinedAt).toBeTruthy();

    const otherRoom = activeRoomsResponse.body.items.find((item: { roomId: string }) => item.roomId === otherRoomId);
    expect(otherRoom).toMatchObject({
      roomId: otherRoomId,
      roomName: '活跃房间二',
      role: null,
      memberCount: 1,
    });
    expect(otherRoom.joinedAt).toBeNull();

    const myRoomsResponse = await debugRequest(joinedIp).get('/api/me/rooms');
    expect(myRoomsResponse.status).toBe(200);
    expect(myRoomsResponse.body.items[0]).toMatchObject({
      roomId: joinedRoomId,
      memberCount: 2,
    });
  });

  it('allows member leave but blocks owner leave', async () => {
    const createResponse = await debugRequest('192.168.0.12').post('/api/rooms').send({ nickname: '群主', roomName: '群主的房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest('192.168.0.13').post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const ownerLeave = await debugRequest('192.168.0.12').post(`/api/rooms/${roomId}/leave`).send({});
    expect(ownerLeave.status).toBe(409);

    const memberLeave = await debugRequest('192.168.0.13').post(`/api/rooms/${roomId}/leave`).send({});
    expect(memberLeave.status).toBe(200);

    const roomsResponse = await debugRequest('192.168.0.13').get('/api/me/rooms');
    expect(roomsResponse.body.items).toHaveLength(0);
  });

  it('blocks join and messages after dissolve', async () => {
    const createResponse = await debugRequest('192.168.0.14').post('/api/rooms').send({ nickname: '群主', roomName: '群主的房间' });
    const roomId = createResponse.body.roomId;

    const dissolveResponse = await debugRequest('192.168.0.14').post(`/api/rooms/${roomId}/dissolve`).send({});
    expect(dissolveResponse.status).toBe(200);

    const joinResponse = await debugRequest('192.168.0.15').post(`/api/rooms/${roomId}/join`).send({ nickname: '新成员' });
    expect(joinResponse.status).toBe(410);

    const socket = await connectSocket('192.168.0.14');
    const ack = await new Promise<{ ok: boolean; message?: string }>((resolveAck) => {
      socket.emit('message:text', { roomId, text: 'hello' }, resolveAck);
    });

    expect(ack.ok).toBe(false);
  });

  it('persists data across restart', async () => {
    const createResponse = await debugRequest('192.168.0.16').post('/api/rooms').send({ nickname: '恢复用户', roomName: '恢复房间' });
    const roomId = createResponse.body.roomId;
    const socket = await connectSocket('192.168.0.16');
    await new Promise<void>((resolveJoin) => {
      socket.emit('room:joinLive', { roomId }, () => resolveJoin());
    });
    await new Promise<void>((resolveSend) => {
      socket.emit('message:text', { roomId, text: '持久化消息' }, () => resolveSend());
    });

    await serverBundle.close();
    serverBundle = createChatApp(config);
    await new Promise<void>((resolveStart) => {
      serverBundle.httpServer.listen(0, '127.0.0.1', () => {
        const address = serverBundle.httpServer.address();
        if (address && typeof address !== 'string') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolveStart();
      });
    });

    const roomsResponse = await debugRequest('192.168.0.16').get('/api/me/rooms');
    expect(roomsResponse.body.items[0].roomId).toBe(roomId);
    expect(roomsResponse.body.items[0].roomName).toBe('恢复房间');

    const messagesResponse = await debugRequest('192.168.0.16').get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.body.items).toHaveLength(1);
    expect(messagesResponse.body.items[0].textContent).toBe('持久化消息');
  });

  it('tracks member presence while viewing the room page', async () => {
    const ownerIp = '192.168.0.31';
    const memberIp = '192.168.0.32';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '在线状态房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const ownerSocket = await connectSocket(ownerIp);
    const memberSocket = await connectSocket(memberIp);

    const ownerJoinAck = await new Promise<any>((resolveAck) => {
      ownerSocket.emit('room:joinLive', { roomId }, resolveAck);
    });
    expect(ownerJoinAck).toMatchObject({ ok: true, roomId });
    expect(ownerJoinAck.onlineMemberIps).toContain(ownerIp);
    expect(ownerJoinAck.onlineMemberIps).not.toContain(memberIp);

    const ownerPresenceResponse = await debugRequest(ownerIp).get(`/api/rooms/${roomId}/presence`);
    expect(ownerPresenceResponse.status).toBe(200);
    expect(ownerPresenceResponse.body.onlineMemberIps).toContain(ownerIp);

    const ownerPresenceOnline = new Promise<any>((resolvePresence) => {
      ownerSocket.once('member:presence', resolvePresence);
    });

    const memberJoinAck = await new Promise<any>((resolveAck) => {
      memberSocket.emit('room:joinLive', { roomId }, resolveAck);
    });
    expect(memberJoinAck).toMatchObject({ ok: true, roomId });
    expect(memberJoinAck.onlineMemberIps.sort()).toEqual([memberIp, ownerIp].sort());

    const onlinePayload = await ownerPresenceOnline;
    expect(onlinePayload).toMatchObject({
      roomId,
      memberIp,
      isOnline: true,
    });

    const ownerPresenceOffline = new Promise<any>((resolvePresence) => {
      ownerSocket.once('member:presence', resolvePresence);
    });
    memberSocket.disconnect();

    const offlinePayload = await ownerPresenceOffline;
    expect(offlinePayload).toMatchObject({
      roomId,
      memberIp,
      isOnline: false,
    });

    const finalPresenceResponse = await debugRequest(ownerIp).get(`/api/rooms/${roomId}/presence`);
    expect(finalPresenceResponse.status).toBe(200);
    expect(finalPresenceResponse.body.onlineMemberIps).toEqual([ownerIp]);
  });

  it('keeps homepage online member counts aligned with room presence', async () => {
    const viewerIp = '192.168.0.41';
    const ownerIp = '192.168.0.42';
    const memberIp = '192.168.0.43';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '主页在线人数房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const viewerSocket = await connectSocket(viewerIp);
    const ownerSocket = await connectSocket(ownerIp);
    const memberSocket = await connectSocket(memberIp);

    const ownerHomePresencePromise = new Promise<any>((resolvePresence) => {
      viewerSocket.once('home:roomPresence', resolvePresence);
    });
    const ownerJoinAck = await new Promise<any>((resolveAck) => {
      ownerSocket.emit('room:joinLive', { roomId }, resolveAck);
    });
    expect(ownerJoinAck).toMatchObject({ ok: true, roomId });

    const ownerHomePresence = await ownerHomePresencePromise;
    expect(ownerHomePresence).toMatchObject({ roomId, onlineMemberCount: 1 });

    const ownerVisibleRoomsResponse = await debugRequest(viewerIp).get('/api/rooms');
    const ownerVisibleRoom = ownerVisibleRoomsResponse.body.items.find((item: { roomId: string }) => item.roomId === roomId);
    expect(ownerVisibleRoom).toMatchObject({
      roomId,
      memberCount: 2,
      chattingMemberCount: 1,
      onlineMemberCount: 1,
    });

    const memberHomePresencePromise = new Promise<any>((resolvePresence) => {
      viewerSocket.once('home:roomPresence', resolvePresence);
    });
    const memberJoinAck = await new Promise<any>((resolveAck) => {
      memberSocket.emit('room:joinLive', { roomId }, resolveAck);
    });
    expect(memberJoinAck).toMatchObject({ ok: true, roomId });

    const memberHomePresence = await memberHomePresencePromise;
    expect(memberHomePresence).toMatchObject({ roomId, onlineMemberCount: 2 });

    const myRoomsResponse = await debugRequest(ownerIp).get('/api/me/rooms');
    expect(myRoomsResponse.status).toBe(200);
    expect(myRoomsResponse.body.items[0]).toMatchObject({
      roomId,
      memberCount: 2,
      chattingMemberCount: 2,
      onlineMemberCount: 2,
    });

    const memberOfflinePresencePromise = new Promise<any>((resolvePresence) => {
      viewerSocket.once('home:roomPresence', resolvePresence);
    });
    memberSocket.disconnect();

    const memberOfflinePresence = await memberOfflinePresencePromise;
    expect(memberOfflinePresence).toMatchObject({ roomId, onlineMemberCount: 1 });

    const finalVisibleRoomsResponse = await debugRequest(viewerIp).get('/api/rooms');
    const finalVisibleRoom = finalVisibleRoomsResponse.body.items.find((item: { roomId: string }) => item.roomId === roomId);
    expect(finalVisibleRoom).toMatchObject({
      roomId,
      chattingMemberCount: 1,
      onlineMemberCount: 1,
    });
  });

  it('broadcasts realtime text messages', async () => {
    const createResponse = await debugRequest('192.168.0.17').post('/api/rooms').send({ nickname: '群主', roomName: '群主的房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest('192.168.0.18').post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const ownerSocket = await connectSocket('192.168.0.17');
    const memberSocket = await connectSocket('192.168.0.18');
    await Promise.all([
      new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
      new Promise<void>((resolveJoin) => memberSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
    ]);

    const messagePromise = new Promise((resolveMessage) => {
      memberSocket.once('message:new', resolveMessage);
    });

    ownerSocket.emit('message:text', { roomId, text: '大家好' });
    const payload = await messagePromise;
    expect(payload).toMatchObject({
      roomId,
      type: 'text',
      textContent: '大家好',
    });
  });

  it('stores mention metadata on text messages', async () => {
    const ownerIp = '192.168.0.21';
    const memberIp = '192.168.0.22';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '提及房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const ownerSocket = await connectSocket(ownerIp);
    const memberSocket = await connectSocket(memberIp);
    await Promise.all([
      new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
      new Promise<void>((resolveJoin) => memberSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
    ]);

    const messagePromise = new Promise<any>((resolveMessage) => {
      memberSocket.once('message:new', resolveMessage);
    });
    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        { roomId, text: '@成员 请关注，@所有人 也请看一下', mentionAll: true, mentionedIps: [memberIp] },
        resolveAck,
      );
    });

    expect(ackPayload).toMatchObject({ ok: true });
    const payload = await messagePromise;
    expect(payload).toMatchObject({
      roomId,
      type: 'text',
      mentionAll: true,
      textContent: '@成员 请关注，@所有人 也请看一下',
    });
    expect(payload.mentionedIps).toEqual([memberIp]);

    const messagesResponse = await debugRequest(memberIp).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.items[0].mentionAll).toBe(true);
    expect(messagesResponse.body.items[0].mentionedIps).toEqual([memberIp]);
  });

  it('stores reply metadata for text replies and broadcasts the simplified preview', async () => {
    const ownerIp = '192.168.0.221';
    const memberIp = '192.168.0.222';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '回复文本房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const ownerSocket = await connectSocket(ownerIp);
    const memberSocket = await connectSocket(memberIp);
    await Promise.all([
      new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
      new Promise<void>((resolveJoin) => memberSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
    ]);

    const sourceText = '第一行回复来源内容\n第二行会被折叠展示  第三行继续补充，用来验证回复摘要会裁剪为单行文本并截断到固定长度。';
    const sourceEventPromise = new Promise<any>((resolveMessage) => {
      memberSocket.once('message:new', resolveMessage);
    });
    const sourceAck = await new Promise<any>((resolveAck) => {
      ownerSocket.emit('message:text', { roomId, text: sourceText }, resolveAck);
    });
    expect(sourceAck).toMatchObject({ ok: true });
    const sourceEvent = await sourceEventPromise;
    expect(sourceEvent).toMatchObject({
      id: sourceAck.message.id,
      textContent: sourceText,
      replyContent: null,
    });

    const replyEventPromise = new Promise<any>((resolveMessage) => {
      memberSocket.once('message:new', resolveMessage);
    });
    const replyAck = await new Promise<any>((resolveAck) => {
      ownerSocket.emit('message:text', { roomId, text: '收到，按这个处理。', replyMessageId: sourceAck.message.id }, resolveAck);
    });

    expect(replyAck).toMatchObject({ ok: true });
    expect(replyAck.message.replyContent).toMatchObject({
      messageId: sourceAck.message.id,
      senderNickname: '群主',
      messageType: 'text',
      previewText: buildExpectedReplyPreview(sourceText),
    });

    const replyEvent = await replyEventPromise;
    expect(replyEvent.replyContent).toMatchObject({
      messageId: sourceAck.message.id,
      senderNickname: '群主',
      messageType: 'text',
      previewText: buildExpectedReplyPreview(sourceText),
    });

    const messagesResponse = await debugRequest(memberIp).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    const replyMessage = messagesResponse.body.items.find((item: { id: number }) => item.id === replyAck.message.id);
    expect(replyMessage?.replyContent).toMatchObject({
      messageId: sourceAck.message.id,
      senderNickname: '群主',
      messageType: 'text',
      previewText: buildExpectedReplyPreview(sourceText),
    });
  });

  it('stores image reply metadata with image preview fallback text', async () => {
    const ownerIp = '192.168.0.223';
    const memberIp = '192.168.0.224';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '图像用户', roomName: '回复图片房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const imagePayload = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2l9n8AAAAASUVORK5CYII=',
      'base64',
    );
    const filePath = join(dataDir, 'reply-source.png');
    writeFileSync(filePath, imagePayload);

    const uploadResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/images`)
      .attach('image', filePath);

    expect(uploadResponse.status).toBe(201);

    const ownerSocket = await connectSocket(ownerIp);
    const memberSocket = await connectSocket(memberIp);
    await Promise.all([
      new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
      new Promise<void>((resolveJoin) => memberSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
    ]);

    const replyEventPromise = new Promise<any>((resolveMessage) => {
      memberSocket.once('message:new', resolveMessage);
    });
    const replyAck = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        { roomId, text: '图片我看到了。', replyMessageId: uploadResponse.body.id },
        resolveAck,
      );
    });

    expect(replyAck).toMatchObject({ ok: true });
    expect(replyAck.message.replyContent).toMatchObject({
      messageId: uploadResponse.body.id,
      senderNickname: '图像用户',
      messageType: 'image',
      previewText: 'reply-source.png',
    });

    const replyEvent = await replyEventPromise;
    expect(replyEvent.replyContent).toMatchObject({
      messageId: uploadResponse.body.id,
      senderNickname: '图像用户',
      messageType: 'image',
      previewText: 'reply-source.png',
    });
  });

  it('rejects replying to a recalled message', async () => {
    const ownerIp = '192.168.0.225';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '回复撤回房间' });
    const roomId = createResponse.body.roomId;

    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const sourceAck = await new Promise<any>((resolveAck) => {
      ownerSocket.emit('message:text', { roomId, text: '这条消息随后会撤回' }, resolveAck);
    });
    expect(sourceAck).toMatchObject({ ok: true });

    const recallResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/messages/${sourceAck.message.id}/recall`)
      .send({});
    expect(recallResponse.status).toBe(200);

    const replyAck = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        { roomId, text: '尝试回复已撤回消息', replyMessageId: sourceAck.message.id },
        resolveAck,
      );
    });

    expect(replyAck).toMatchObject({
      ok: false,
      message: '原消息已撤回，无法回复',
    });

    const messagesResponse = await debugRequest(ownerIp).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.items).toHaveLength(1);
  });

  it('converts a multi-section formatted text message into a task list', async () => {
    const ownerIp = '192.168.0.24';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '任务房间' });
    const roomId = createResponse.body.roomId;
    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        {
          roomId,
          text: [
            '8.1.0.4',
            '@裘心宇',
            '- 【元气传奇复刻】修复排行榜奖励界面的文本“传奇大神”改为“传奇中的传奇”（无需公告）',
            '- 【元气传奇复刻】修改领取奖励埋点（无需公告）',
            '8.1.0.3',
            '@刘庆林',
            '- 【元气传奇复刻】修复传奇活动羁绊lv3触发后无法交互问题',
            '- 【元气传奇复刻】灵宠羁绊lv3持续时间不对问题',
            '- 【元气传奇复刻】luban羁绊数值调整',
            '@汤睿哲',
            '- 修复骑士皮肤【你行你上】初始武器音效错误的问题',
            '@杨南舜',
            '- 修复狂战士-钧天 初始武器击中特效颜色错误,绿色改为橙色（无需公告）',
            '@刘典',
            '- 修复死灵法师珠澜贝主·铂尔初始武器显示层级到角色上层（无需公告）',
          ].join('\n'),
        },
        resolveAck,
      );
    });

    expect(ackPayload).toMatchObject({ ok: true });
    const messageId = ackPayload.message.id;

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${messageId}/task`).send({});
    expect(convertResponse.status).toBe(200);
    expect(convertResponse.body.taskContent).toMatchObject({
      sections: [
        {
          title: '8.1.0.4',
          groups: [
            {
              assignee: '裘心宇',
              items: [
                { text: '【元气传奇复刻】修复排行榜奖励界面的文本“传奇大神”改为“传奇中的传奇”（无需公告）', completed: false },
                { text: '【元气传奇复刻】修改领取奖励埋点（无需公告）', completed: false },
              ],
            },
          ],
        },
        {
          title: '8.1.0.3',
          groups: [
            {
              assignee: '刘庆林',
              items: [
                { text: '【元气传奇复刻】修复传奇活动羁绊lv3触发后无法交互问题', completed: false },
                { text: '【元气传奇复刻】灵宠羁绊lv3持续时间不对问题', completed: false },
                { text: '【元气传奇复刻】luban羁绊数值调整', completed: false },
              ],
            },
            {
              assignee: '汤睿哲',
              items: [{ text: '修复骑士皮肤【你行你上】初始武器音效错误的问题', completed: false }],
            },
            {
              assignee: '杨南舜',
              items: [{ text: '修复狂战士-钧天 初始武器击中特效颜色错误,绿色改为橙色（无需公告）', completed: false }],
            },
            {
              assignee: '刘典',
              items: [{ text: '修复死灵法师珠澜贝主·铂尔初始武器显示层级到角色上层（无需公告）', completed: false }],
            },
          ],
        },
      ],
    });

    const messagesResponse = await debugRequest(ownerIp).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.items[0].taskContent?.sections).toHaveLength(2);
    expect(messagesResponse.body.items[0].taskContent?.sections[0]?.title).toBe('8.1.0.4');
    expect(messagesResponse.body.items[0].taskContent?.sections[1]?.groups).toHaveLength(4);
  });

  it('converts a plain multiline text message into a default task list and merges wrapped lines', async () => {
    const ownerIp = '192.168.0.241';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '简易任务房间' });
    const roomId = createResponse.body.roomId;
    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        {
          roomId,
          text: [
            '状态加颜色',
            '允许修改需求',
            'bug单超框',
            '需求和缺陷视图放在一起。区分个人保存视图和默认预制视图',
          ].join('\n'),
        },
        resolveAck,
      );
    });

    expect(ackPayload).toMatchObject({ ok: true });
    const messageId = ackPayload.message.id;

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${messageId}/task`).send({});
    expect(convertResponse.status).toBe(200);
    expect(convertResponse.body.taskContent).toMatchObject({
      sections: [
        {
          title: '任务清单',
          groups: [
            {
              assignee: '未分配',
              items: [
                { text: '状态加颜色', completed: false },
                { text: '允许修改需求', completed: false },
                { text: 'bug单超框需求和缺陷视图放在一起。区分个人保存视图和默认预制视图', completed: false },
              ],
            },
          ],
        },
      ],
    });
  });

  it('converts a single-line text message into a default single task', async () => {
    const ownerIp = '192.168.0.242';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '单任务房间' });
    const roomId = createResponse.body.roomId;
    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit('message:text', { roomId, text: '任务123任务123任务123任务123任务123任务123任务123任务123任务123任务123' }, resolveAck);
    });

    expect(ackPayload).toMatchObject({ ok: true });
    const messageId = ackPayload.message.id;

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${messageId}/task`).send({});
    expect(convertResponse.status).toBe(200);
    expect(convertResponse.body.taskContent).toMatchObject({
      sections: [
        {
          title: '任务清单',
          groups: [
            {
              assignee: '未分配',
              items: [
                { text: '任务123任务123任务123任务123任务123任务123任务123任务123任务123任务123', completed: false },
              ],
            },
          ],
        },
      ],
    });
  });

  it('rejects converting malformed structured task text', async () => {
    const ownerIp = '192.168.0.25';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '任务校验房间' });
    const roomId = createResponse.body.roomId;
    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit('message:text', { roomId, text: '8.1.0.3\n@刘庆林' }, resolveAck);
    });

    expect(ackPayload).toMatchObject({ ok: true });
    const messageId = ackPayload.message.id;

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${messageId}/task`).send({});
    expect(convertResponse.status).toBe(400);
    expect(convertResponse.body.error).toBe('该格式无法转换');
  });

  it('broadcasts task conversion and checkbox updates in realtime', async () => {
    const ownerIp = '192.168.0.26';
    const memberIp = '192.168.0.27';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '任务同步房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const ownerSocket = await connectSocket(ownerIp);
    const memberSocket = await connectSocket(memberIp);
    await Promise.all([
      new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
      new Promise<void>((resolveJoin) => memberSocket.emit('room:joinLive', { roomId }, () => resolveJoin())),
    ]);

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        {
          roomId,
          text: ['8.1.0.3', '@刘庆林', '- 第一条任务', '- 第二条任务'].join('\n'),
        },
        resolveAck,
      );
    });
    expect(ackPayload).toMatchObject({ ok: true });
    const messageId = ackPayload.message.id;

    const convertedPromise = new Promise<any>((resolvePayload) => {
      memberSocket.once('message:taskUpdated', resolvePayload);
    });
    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${messageId}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const convertedPayload = await convertedPromise;
    expect(convertedPayload.taskContent?.sections[0]?.groups[0]?.items[0]).toMatchObject({
      text: '第一条任务',
      completed: false,
      completedByNickname: null,
    });

    const taskItemId = convertResponse.body.taskContent.sections[0].groups[0].items[0].id;
    const toggledPromise = new Promise<any>((resolvePayload) => {
      ownerSocket.once('message:taskUpdated', resolvePayload);
    });
    const toggleResponse = await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${messageId}/task-items/${taskItemId}`)
      .send({ completed: true });
    expect(toggleResponse.status).toBe(200);
    expect(toggleResponse.body.taskContent.sections[0].groups[0].items[0].completed).toBe(true);
    expect(toggleResponse.body.taskContent.sections[0].groups[0].items[0].completedByNickname).toBe('成员');

    const toggledPayload = await toggledPromise;
    expect(toggledPayload.taskContent?.sections[0]?.groups[0]?.items[0]).toMatchObject({
      id: taskItemId,
      completed: true,
      completedByNickname: '成员',
    });

    const untoggledPromise = new Promise<any>((resolvePayload) => {
      ownerSocket.once('message:taskUpdated', resolvePayload);
    });
    const untoggleResponse = await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${messageId}/task-items/${taskItemId}`)
      .send({ completed: false });
    expect(untoggleResponse.status).toBe(200);
    expect(untoggleResponse.body.taskContent.sections[0].groups[0].items[0]).toMatchObject({
      id: taskItemId,
      completed: false,
      completedByNickname: null,
    });

    const untoggledPayload = await untoggledPromise;
    expect(untoggledPayload.taskContent?.sections[0]?.groups[0]?.items[0]).toMatchObject({
      id: taskItemId,
      completed: false,
      completedByNickname: null,
    });
  });

  it('edits task messages and preserves completion state only for unchanged items', async () => {
    const ownerIp = '192.168.0.261';
    const memberIp = '192.168.0.262';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '任务编辑房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const message = serverBundle.repository.addTextMessage(
      roomId,
      ownerIp,
      ['8.1.0.3', '@刘庆林', '- 保留任务', '- 修改前任务'].join('\n'),
    );

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const keepTaskId = convertResponse.body.taskContent.sections[0].groups[0].items[0].id;
    const changedTaskId = convertResponse.body.taskContent.sections[0].groups[0].items[1].id;

    const keepToggleResponse = await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${keepTaskId}`)
      .send({ completed: true });
    expect(keepToggleResponse.status).toBe(200);

    const changedToggleResponse = await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${changedTaskId}`)
      .send({ completed: true });
    expect(changedToggleResponse.status).toBe(200);

    const editResponse = await debugRequest(ownerIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task`)
      .send({
        text: ['8.1.0.3', '@刘庆林', '- 保留任务', '- 修改后任务'].join('\n'),
      });

    expect(editResponse.status).toBe(200);
    expect(editResponse.body.textContent).toBe(['8.1.0.3', '@刘庆林', '- 保留任务', '- 修改后任务'].join('\n'));
    expect(editResponse.body.editedAt).toBeTruthy();
    expect(editResponse.body.taskContent).toMatchObject({
      sections: [
        {
          title: '8.1.0.3',
          groups: [
            {
              assignee: '刘庆林',
              items: [
                { text: '保留任务', completed: true, completedByNickname: '成员' },
                { text: '修改后任务', completed: false, completedByNickname: null },
              ],
            },
          ],
        },
      ],
    });

    const messagesResponse = await debugRequest(ownerIp).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.items[0].taskContent.sections[0].groups[0].items).toMatchObject([
      { text: '保留任务', completed: true, completedByNickname: '成员' },
      { text: '修改后任务', completed: false, completedByNickname: null },
    ]);
  });

  it('saves feishu bot settings and exposes only public config to room members', async () => {
    const saveResponse = await debugRequest('192.168.0.263', 'admin')
      .put('/api/server/feishu-settings')
      .send({
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
        members: [
          { memberId: 'db43fdfc', memberIdType: 'user_id', name: '金炜星', tenantKey: 'tenant-a' },
          { memberId: 'd5795a89', memberIdType: 'user_id', name: '刘涵', tenantKey: 'tenant-a' },
        ],
      });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body).toMatchObject({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
      enabled: true,
      members: [
        { memberId: 'db43fdfc', name: '金炜星' },
        { memberId: 'd5795a89', name: '刘涵' },
      ],
    });

    const settingsResponse = await debugRequest('192.168.0.263', 'admin').get('/api/server/feishu-settings');
    expect(settingsResponse.status).toBe(200);
    expect(settingsResponse.body.webhookUrl).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook');

    const createResponse = await debugRequest('192.168.0.264').post('/api/rooms').send({ nickname: '群主', roomName: '飞书通知房间' });
    const roomId = createResponse.body.roomId;
    const publicConfigResponse = await debugRequest('192.168.0.264').get(`/api/rooms/${roomId}/task-notify-config`);

    expect(publicConfigResponse.status).toBe(200);
    expect(publicConfigResponse.body).toMatchObject({
      enabled: true,
      members: [
        { memberId: 'db43fdfc', name: '金炜星' },
        { memberId: 'd5795a89', name: '刘涵' },
      ],
    });
    expect(publicConfigResponse.body.webhookUrl).toBeUndefined();
  });

  it('rejects sending feishu notifications for simple task format', async () => {
    await debugRequest('192.168.0.265', 'admin')
      .put('/api/server/feishu-settings')
      .send({
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
        members: [
          { memberId: 'db43fdfc', memberIdType: 'user_id', name: '金炜星', tenantKey: 'tenant-a' },
        ],
      });

    const createResponse = await debugRequest('192.168.0.266').post('/api/rooms').send({ nickname: '群主', roomName: '简单任务通知房间' });
    const roomId = createResponse.body.roomId;
    const message = serverBundle.repository.addTextMessage(roomId, '192.168.0.266', ['状态加颜色', '允许修改需求'].join('\n'));

    const convertResponse = await debugRequest('192.168.0.266').post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const notifyResponse = await debugRequest('192.168.0.266')
      .post(`/api/rooms/${roomId}/messages/${message.id}/task-notify`)
      .send({ recipientMemberIds: ['db43fdfc'] });

    expect(notifyResponse.status).toBe(409);
    expect(notifyResponse.body.error).toContain('当前任务格式不支持发送通知');
  });

  it('rejects sending feishu notifications before all structured tasks are completed', async () => {
    await debugRequest('192.168.0.267', 'admin')
      .put('/api/server/feishu-settings')
      .send({
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
        members: [
          { memberId: 'db43fdfc', memberIdType: 'user_id', name: '金炜星', tenantKey: 'tenant-a' },
        ],
      });

    const createResponse = await debugRequest('192.168.0.268').post('/api/rooms').send({ nickname: '群主', roomName: '未完成任务通知房间' });
    const roomId = createResponse.body.roomId;
    const message = serverBundle.repository.addTextMessage(roomId, '192.168.0.268', ['8.1.0.18', '@金炜星', '- 修复通知按钮'].join('\n'));

    const convertResponse = await debugRequest('192.168.0.268').post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const notifyResponse = await debugRequest('192.168.0.268')
      .post(`/api/rooms/${roomId}/messages/${message.id}/task-notify`)
      .send({ recipientMemberIds: ['db43fdfc'] });

    expect(notifyResponse.status).toBe(409);
    expect(notifyResponse.body.error).toContain('任务未全部完成');
  });

  it('rejects sending feishu notifications for single-line simple tasks', async () => {
    await debugRequest('192.168.0.271', 'admin')
      .put('/api/server/feishu-settings')
      .send({
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
        members: [
          { memberId: 'db43fdfc', memberIdType: 'user_id', name: '金炜星', tenantKey: 'tenant-a' },
        ],
      });

    const createResponse = await debugRequest('192.168.0.272').post('/api/rooms').send({ nickname: '群主', roomName: '单条简单任务通知房间' });
    const roomId = createResponse.body.roomId;
    const message = serverBundle.repository.addTextMessage(roomId, '192.168.0.272', '任务1 xxxxxx');

    const convertResponse = await debugRequest('192.168.0.272').post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const notifyResponse = await debugRequest('192.168.0.272')
      .post(`/api/rooms/${roomId}/messages/${message.id}/task-notify`)
      .send({ recipientMemberIds: ['db43fdfc'] });

    expect(notifyResponse.status).toBe(409);
    expect(notifyResponse.body.error).toContain('当前任务格式不支持发送通知');
  });

  it('sends feishu notification for completed structured tasks', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.startsWith('https://open.feishu.cn/open-apis/bot/v2/hook/')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'success',
          data: {},
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock);
    await serverBundle.close();
    serverBundle = createChatApp(config);
    await new Promise<void>((resolveStart) => {
      serverBundle.httpServer.listen(0, '127.0.0.1', () => {
        const address = serverBundle.httpServer.address();
        if (address && typeof address !== 'string') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolveStart();
      });
    });

    await debugRequest('192.168.0.269', 'admin')
      .put('/api/server/feishu-settings')
      .send({
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
        members: [
          { memberId: 'db43fdfc', memberIdType: 'user_id', name: '金炜星', tenantKey: 'tenant-a' },
          { memberId: 'd5795a89', memberIdType: 'user_id', name: '刘涵', tenantKey: 'tenant-a' },
        ],
      });

    const createResponse = await debugRequest('192.168.0.270').post('/api/rooms').send({ nickname: '群主', roomName: '完成任务通知房间' });
    const roomId = createResponse.body.roomId;
    const message = serverBundle.repository.addTextMessage(
      roomId,
      '192.168.0.270',
      ['8.1.0.18', '@金炜星', '- 修复80101问题', '@刘涵', '- 修复火光问题'].join('\n'),
    );

    const convertResponse = await debugRequest('192.168.0.270').post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const firstTaskId = convertResponse.body.taskContent.sections[0].groups[0].items[0].id;
    const secondTaskId = convertResponse.body.taskContent.sections[0].groups[1].items[0].id;

    await debugRequest('192.168.0.270')
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${firstTaskId}`)
      .send({ completed: true });
    await debugRequest('192.168.0.270')
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${secondTaskId}`)
      .send({ completed: true });

    const notifyResponse = await debugRequest('192.168.0.270')
      .post(`/api/rooms/${roomId}/messages/${message.id}/task-notify`)
      .send({ recipientMemberIds: ['db43fdfc', 'd5795a89'] });

    expect(notifyResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const webhookPayloads = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith('https://open.feishu.cn/open-apis/bot/v2/hook/'))
      .map(([, init]) => JSON.parse(String(init?.body)));

    expect(webhookPayloads[0]).toMatchObject({
      msg_type: 'interactive',
      card: {
        schema: '2.0',
        header: {
          title: {
            content: expect.stringContaining('8.1.0.18'),
          },
          template: 'green',
        },
      },
    });
    const cardElements = webhookPayloads[0].card.body.elements as Array<{ tag?: string; content?: string }>;
    expect(cardElements.at(-1)?.content).toContain('<at id=db43fdfc></at>');
    expect(cardElements.at(-1)?.content).toContain('<at id=d5795a89></at>');
    expect(cardElements.at(-1)?.content).toContain('测试通过');
    expect(cardElements.some((element) => element.content?.includes('@金炜星'))).toBe(true);
    expect(cardElements.some((element) => element.content?.includes('@刘涵'))).toBe(true);
    expect(cardElements.some((element) => element.content?.includes('@金炜星\n- ✅ ~~修复80101问题~~'))).toBe(true);
  });

  it('rejects invalid mentioned members', async () => {
    const ownerIp = '192.168.0.23';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '提及校验房间' });
    const roomId = createResponse.body.roomId;
    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        { roomId, text: '@陌生人 看一下', mentionedIps: ['192.168.0.250'] },
        resolveAck,
      );
    });

    expect(ackPayload.ok).toBe(false);
    expect(String(ackPayload.message)).toContain('无效');

    const messagesResponse = await debugRequest(ownerIp).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.items).toHaveLength(0);
  });

  it('tracks unread mentions in room list and advances to the next unread mention after reading', async () => {
    const ownerIp = '192.168.0.24';
    const memberIp = '192.168.0.25';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '未读提醒房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const firstMessage = serverBundle.repository.addTextMessage(roomId, ownerIp, '@成员 先看第一条', { mentionedIps: [memberIp] });
    const secondMessage = serverBundle.repository.addTextMessage(roomId, ownerIp, '@成员 再看第二条', { mentionedIps: [memberIp] });

    const roomsBeforeRead = await debugRequest(memberIp).get('/api/me/rooms');
    expect(roomsBeforeRead.status).toBe(200);
    expect(roomsBeforeRead.body.items[0].unreadMentionCount).toBe(2);
    expect(roomsBeforeRead.body.items[0].latestUnreadMentionId).toBe(firstMessage.id);

    const firstMarkReadResponse = await debugRequest(memberIp)
      .post(`/api/rooms/${roomId}/read`)
      .send({ messageId: firstMessage.id });
    expect(firstMarkReadResponse.status).toBe(200);
    expect(firstMarkReadResponse.body.unreadMentionCount).toBe(1);
    expect(firstMarkReadResponse.body.latestUnreadMentionId).toBe(secondMessage.id);

    const secondMarkReadResponse = await debugRequest(memberIp)
      .post(`/api/rooms/${roomId}/read`)
      .send({ messageId: secondMessage.id });
    expect(secondMarkReadResponse.status).toBe(200);
    expect(secondMarkReadResponse.body.unreadMentionCount).toBe(0);
    expect(secondMarkReadResponse.body.lastSeenMessageId).toBe(secondMessage.id);

    const roomsAfterRead = await debugRequest(memberIp).get('/api/me/rooms');
    expect(roomsAfterRead.status).toBe(200);
    expect(roomsAfterRead.body.items[0].unreadMentionCount).toBe(0);
    expect(roomsAfterRead.body.items[0].latestUnreadMentionId).toBeNull();
  });

  it('allows owner to recall any member attachment', async () => {
    const ownerIp = '192.168.0.30';
    const memberIp = '192.168.0.31';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '群主的房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const filePath = join(dataDir, 'recall.txt');
    writeFileSync(filePath, 'to be recalled');

    const uploadResponse = await debugRequest(memberIp)
      .post(`/api/rooms/${roomId}/attachments`)
      .attach('file', filePath);

    expect(uploadResponse.status).toBe(201);
    const recallResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/messages/${uploadResponse.body.id}/recall`)
      .send({});

    expect(recallResponse.status).toBe(200);
    expect(recallResponse.body.isRecalled).toBe(true);
    expect(recallResponse.body.fileUrl).toBeNull();

    const downloadResponse = await request(baseUrl).get(uploadResponse.body.fileUrl);
    expect(downloadResponse.status).toBe(404);
  });

  it('allows members to edit their own text message within two minutes', async () => {
    const ownerIp = '192.168.0.32';
    const memberIp = '192.168.0.33';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '群主的房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const message = serverBundle.repository.addTextMessage(roomId, memberIp, '旧内容');
    const editResponse = await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}`)
      .send({ text: '新内容 @所有人', mentionAll: true, mentionedIps: [] });

    expect(editResponse.status).toBe(200);
    expect(editResponse.body.textContent).toBe('新内容 @所有人');
    expect(editResponse.body.editedAt).toBeTruthy();
    expect(editResponse.body.mentionAll).toBe(true);

    const messagesResponse = await debugRequest(memberIp).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.body.items[0].textContent).toBe('新内容 @所有人');
    expect(messagesResponse.body.items[0].editedAt).toBeTruthy();
  });

  it('blocks member edit after two minutes', async () => {
    const ownerIp = '192.168.0.34';
    const memberIp = '192.168.0.35';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '群主的房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const message = serverBundle.repository.addTextMessage(roomId, memberIp, '超时编辑');
    const expiredAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    serverBundle.database.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(expiredAt, message.id);

    const editResponse = await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}`)
      .send({ text: '尝试编辑' });

    expect(editResponse.status).toBe(403);
    expect(editResponse.body.error).toContain('超过 2 分钟');
  });

  it('allows members to recall their own message within two minutes', async () => {
    const ownerIp = '192.168.0.32';
    const memberIp = '192.168.0.33';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '群主的房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const message = serverBundle.repository.addTextMessage(roomId, memberIp, '两分钟内撤回');
    const recallResponse = await debugRequest(memberIp)
      .post(`/api/rooms/${roomId}/messages/${message.id}/recall`)
      .send({});

    expect(recallResponse.status).toBe(200);
    expect(recallResponse.body.isRecalled).toBe(true);

    const messagesResponse = await debugRequest(memberIp).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.body.items[0].isRecalled).toBe(true);
    expect(messagesResponse.body.items[0].textContent).toBeNull();
  });

  it('blocks member recall after two minutes', async () => {
    const ownerIp = '192.168.0.34';
    const memberIp = '192.168.0.35';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '群主的房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const message = serverBundle.repository.addTextMessage(roomId, memberIp, '超时撤回');
    const expiredAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    serverBundle.database.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(expiredAt, message.id);

    const recallResponse = await debugRequest(memberIp)
      .post(`/api/rooms/${roomId}/messages/${message.id}/recall`)
      .send({});

    expect(recallResponse.status).toBe(403);
    expect(recallResponse.body.error).toContain('超过 2 分钟');
  });

  it('stores image messages and serves preview', async () => {
    const createResponse = await debugRequest('192.168.0.19').post('/api/rooms').send({ nickname: '图像用户', roomName: '图片房间' });
    const roomId = createResponse.body.roomId;
    const imagePayload = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2l9n8AAAAASUVORK5CYII=',
      'base64',
    );
    const filePath = join(dataDir, 'dot.png');
    writeFileSync(filePath, imagePayload);

    const uploadResponse = await debugRequest('192.168.0.19')
      .post(`/api/rooms/${roomId}/images`)
      .attach('image', filePath);

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.type).toBe('image');
    expect(uploadResponse.body.imageUrl).toMatch(/^\/api\/rooms\/[A-Z0-9]+\/messages\/\d+\/content$/);

    const imageResponse = await request(baseUrl).get(uploadResponse.body.imageUrl).set('x-debug-client-ip', '192.168.0.19');
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.header['content-type']).toContain('image/png');
  });


  it('uploads pending attachments first and only sends after commit', async () => {
    const createResponse = await debugRequest('192.168.0.22').post('/api/rooms').send({ nickname: '缓传用户', roomName: '缓传房间' });
    const roomId = createResponse.body.roomId;
    const filePath = join(dataDir, 'staged.txt');
    writeFileSync(filePath, 'staged payload');

    const uploadResponse = await debugRequest('192.168.0.22')
      .post(`/api/rooms/${roomId}/pending-uploads`)
      .attach('file', filePath);

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.uploadId).toBeTruthy();

    const beforeCommitMessages = await debugRequest('192.168.0.22').get(`/api/rooms/${roomId}/messages`);
    expect(beforeCommitMessages.status).toBe(200);
    expect(beforeCommitMessages.body.items).toHaveLength(0);

    const commitResponse = await debugRequest('192.168.0.22')
      .post(`/api/rooms/${roomId}/pending-uploads/commit`)
      .send({ uploadIds: [uploadResponse.body.uploadId] });

    expect(commitResponse.status).toBe(200);
    expect(commitResponse.body.items).toHaveLength(1);
    expect(commitResponse.body.items[0].fileName).toBe('staged.txt');

    const afterCommitMessages = await debugRequest('192.168.0.22').get(`/api/rooms/${roomId}/messages`);
    expect(afterCommitMessages.status).toBe(200);
    expect(afterCommitMessages.body.items).toHaveLength(1);
    expect(afterCommitMessages.body.items[0].fileUrl).toMatch(/^\/api\/rooms\/[A-Z0-9]+\/messages\/\d+\/download$/);
  });

  it('commits pending image and text as one rich message', async () => {
    const ip = '192.168.0.221';
    const createResponse = await debugRequest(ip).post('/api/rooms').send({ nickname: '富文用户', roomName: '富文房间' });
    const roomId = createResponse.body.roomId;
    const imagePayload = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2l9n8AAAAASUVORK5CYII=',
      'base64',
    );
    const filePath = join(dataDir, 'rich-dot.png');
    writeFileSync(filePath, imagePayload);

    const uploadResponse = await debugRequest(ip)
      .post(`/api/rooms/${roomId}/pending-uploads`)
      .attach('file', filePath);

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.type).toBe('image');

    const commitResponse = await debugRequest(ip)
      .post(`/api/rooms/${roomId}/pending-uploads/commit`)
      .send({
        uploadIds: [uploadResponse.body.uploadId],
        text: '图片说明文案',
      });

    expect(commitResponse.status).toBe(200);
    expect(commitResponse.body.items).toHaveLength(1);
    expect(commitResponse.body.items[0]).toMatchObject({
      type: 'rich',
      textContent: '图片说明文案',
    });
    expect(commitResponse.body.items[0].richContent).toBeTruthy();
    expect(commitResponse.body.items[0].richContent.attachments).toHaveLength(1);

    const attachment = commitResponse.body.items[0].richContent.attachments[0];
    expect(attachment.type).toBe('image');
    expect(attachment.imageUrl).toMatch(/^\/api\/rooms\/[A-Z0-9]+\/messages\/\d+\/rich\/[^/]+\/content$/);
    expect(attachment.fileUrl).toMatch(/^\/api\/rooms\/[A-Z0-9]+\/messages\/\d+\/rich\/[^/]+\/download$/);

    const imageResponse = await request(baseUrl).get(attachment.imageUrl).set('x-debug-client-ip', ip);
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.header['content-type']).toContain('image/png');

    const messagesResponse = await debugRequest(ip).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.items).toHaveLength(1);
    expect(messagesResponse.body.items[0].type).toBe('rich');
    expect(messagesResponse.body.items[0].textContent).toBe('图片说明文案');
  });

  it('stores generic file attachments and allows download', async () => {
    const createResponse = await debugRequest('192.168.0.21').post('/api/rooms').send({ nickname: '文件用户', roomName: '文件房间' });
    const roomId = createResponse.body.roomId;
    const filePath = join(dataDir, 'notes.txt');
    writeFileSync(filePath, 'hello file');

    const uploadResponse = await debugRequest('192.168.0.21')
      .post(`/api/rooms/${roomId}/attachments`)
      .attach('file', filePath);

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.type).toBe('file');
    expect(uploadResponse.body.fileUrl).toMatch(/^\/api\/rooms\/[A-Z0-9]+\/messages\/\d+\/download$/);
    expect(uploadResponse.body.fileName).toBe('notes.txt');

    const downloadResponse = await request(baseUrl).get(uploadResponse.body.fileUrl).set('x-debug-client-ip', '192.168.0.21');
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.header['content-disposition']).toContain('attachment');
    expect(downloadResponse.text).toBe('hello file');
  });

  it('normalizes garbled Chinese filenames on attachment upload', async () => {
    const createResponse = await debugRequest('192.168.0.210').post('/api/rooms').send({ nickname: '中文文件用户', roomName: '中文文件房间' });
    const roomId = createResponse.body.roomId;
    const filePath = join(dataDir, 'archive.rar');
    writeFileSync(filePath, 'archive payload');
    const expectedFileName = '林镇龙的压缩包.rar';
    const mojibakeFileName = Buffer.from(expectedFileName, 'utf8').toString('latin1');

    const uploadResponse = await debugRequest('192.168.0.210')
      .post(`/api/rooms/${roomId}/attachments`)
      .attach('file', filePath, mojibakeFileName);

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.fileName).toBe(expectedFileName);

    const messagesResponse = await debugRequest('192.168.0.210').get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.items[0].fileName).toBe(expectedFileName);
  });


  it('opens the containing folder for a stored server file', async () => {
    let openedPath = '';
    config.openPathInFileManager = async (targetPath: string) => {
      openedPath = targetPath;
    };

    const createResponse = await debugRequest('192.168.0.51').post('/api/rooms').send({ nickname: '目录用户', roomName: '目录房间' });
    const roomId = createResponse.body.roomId;
    const filePath = join(dataDir, 'folder-open.txt');
    writeFileSync(filePath, 'folder target');

    const uploadResponse = await debugRequest('192.168.0.51')
      .post(`/api/rooms/${roomId}/attachments`)
      .attach('file', filePath);

    expect(uploadResponse.status).toBe(201);

    const listResponse = await debugRequest('192.168.0.51', 'admin').get('/api/server/files');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.storageRootPath).toBe(join(dataDir, 'uploads'));

    const openResponse = await debugRequest('192.168.0.51', 'admin')
      .post(`/api/server/files/${uploadResponse.body.id}/open-folder`)
      .send({});

    expect(openResponse.status).toBe(200);
    expect(openResponse.body.folderPath).toBe(join(dataDir, 'uploads', roomId));
    expect(openedPath).toBe(join(dataDir, 'uploads', roomId));
  });

  it('requires admin password for server cleanup routes', async () => {
    const listResponse = await debugRequest('192.168.0.52').get('/api/server/files');

    expect(listResponse.status).toBe(401);
    expect(listResponse.body.error).toContain('管理员密码错误');
  });

  it('lists stored files and deletes selected server attachments', async () => {
    const createResponse = await debugRequest('192.168.0.50').post('/api/rooms').send({ nickname: '清理用户', roomName: '清理房间' });
    const roomId = createResponse.body.roomId;
    const filePath = join(dataDir, 'cleanup.txt');
    writeFileSync(filePath, 'cleanup target');

    const uploadResponse = await debugRequest('192.168.0.50')
      .post(`/api/rooms/${roomId}/attachments`)
      .attach('file', filePath);

    expect(uploadResponse.status).toBe(201);

    const listResponse = await debugRequest('192.168.0.50', 'admin').get('/api/server/files');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.totalCount).toBe(1);
    expect(listResponse.body.items[0]).toMatchObject({
      messageId: uploadResponse.body.id,
      roomId,
      roomName: '清理房间',
      fileName: 'cleanup.txt',
      type: 'file',
    });

    const deleteResponse = await debugRequest('192.168.0.50', 'admin')
      .post('/api/server/files/delete')
      .send({ messageIds: [uploadResponse.body.id] });

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.cleanedCount).toBe(1);

    const listAfterDeleteResponse = await debugRequest('192.168.0.50', 'admin').get('/api/server/files');
    expect(listAfterDeleteResponse.status).toBe(200);
    expect(listAfterDeleteResponse.body.totalCount).toBe(0);

    const messagesResponse = await debugRequest('192.168.0.50').get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.items[0].isRecalled).toBe(true);
    expect(messagesResponse.body.items[0].recalledByIp).toContain('server:cleanup');

    const downloadResponse = await request(baseUrl).get(uploadResponse.body.fileUrl).set('x-debug-client-ip', '192.168.0.50');
    expect(downloadResponse.status).toBe(404);
  });

  it('blocks file download for users outside the room', async () => {
    const createResponse = await debugRequest('192.168.0.40').post('/api/rooms').send({ nickname: '文件群主', roomName: '受控下载房间' });
    const roomId = createResponse.body.roomId;
    const filePath = join(dataDir, 'private.txt');
    writeFileSync(filePath, 'private content');

    const uploadResponse = await debugRequest('192.168.0.40')
      .post(`/api/rooms/${roomId}/attachments`)
      .attach('file', filePath);

    const outsiderResponse = await request(baseUrl).get(uploadResponse.body.fileUrl).set('x-debug-client-ip', '192.168.0.41');
    expect(outsiderResponse.status).toBe(404);
  });
  it('lists all managed rooms and supports admin dissolve and restore', async () => {
    const ownerIp = '192.168.0.81';
    const memberIp = '192.168.0.82';
    const firstCreateResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主一', roomName: '管理房间一' });
    const secondCreateResponse = await debugRequest('192.168.0.83').post('/api/rooms').send({ nickname: '群主二', roomName: '管理房间二' });
    const roomId = firstCreateResponse.body.roomId;
    const secondRoomId = secondCreateResponse.body.roomId;

    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员一' });
    await debugRequest('192.168.0.83').post(`/api/rooms/${secondRoomId}/dissolve`).send({});

    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => {
      ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin());
    });

    const dissolvedPromise = new Promise<any>((resolvePayload) => {
      ownerSocket.once('room:dissolved', resolvePayload);
    });

    const listResponse = await debugRequest('192.168.0.90', 'admin').get('/api/server/rooms');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.totalCount).toBe(2);
    expect(listResponse.body.items[0]).toMatchObject({
      roomId: secondRoomId,
      status: 'dissolved',
      canRestore: true,
    });
    expect(listResponse.body.items[1]).toMatchObject({
      roomId,
      status: 'active',
      memberCount: 2,
    });

    const dissolveResponse = await debugRequest('192.168.0.90', 'admin').post('/api/server/rooms/dissolve').send({ roomIds: [roomId] });
    expect(dissolveResponse.status).toBe(200);
    expect(dissolveResponse.body.dissolvedCount).toBe(1);
    expect(dissolveResponse.body.skippedCount).toBe(0);

    const dissolvedPayload = await dissolvedPromise;
    expect(dissolvedPayload).toMatchObject({ roomId });

    const restoreResponse = await debugRequest('192.168.0.90', 'admin').post(`/api/server/rooms/${roomId}/restore`).send({});
    expect(restoreResponse.status).toBe(200);
    expect(restoreResponse.body.room).toMatchObject({
      roomId,
      status: 'active',
      dissolvedAt: null,
    });

    const roomResponse = await debugRequest(ownerIp).get(`/api/rooms/${roomId}`);
    expect(roomResponse.status).toBe(200);
    expect(roomResponse.body.roomId).toBe(roomId);
  });

  it('blocks restore after the 24 hour grace period', async () => {
    const createResponse = await debugRequest('192.168.0.84').post('/api/rooms').send({ nickname: '群主', roomName: '过期恢复房间' });
    const roomId = createResponse.body.roomId;

    const dissolveResponse = await debugRequest('192.168.0.90', 'admin').post('/api/server/rooms/dissolve').send({ roomIds: [roomId] });
    expect(dissolveResponse.status).toBe(200);

    const database = openDatabase(config.databasePath);
    try {
      const expiredAt = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();
      database.prepare("UPDATE rooms SET dissolved_at = ? WHERE room_id = ?").run(expiredAt, roomId);
    } finally {
      database.close();
    }

    const restoreResponse = await debugRequest('192.168.0.90', 'admin').post(`/api/server/rooms/${roomId}/restore`).send({});
    expect(restoreResponse.status).toBe(410);
    expect(restoreResponse.body.error).toContain('超过 24 小时恢复期');
  });

});
