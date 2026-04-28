import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import Database from 'better-sqlite3';
import { createChatApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { SettingsStore } from '../src/settings-store.js';
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

  function buildHotfixBlockFixtures(
    documentId: string,
    rawContent: string,
    traceId: string,
    options?: {
      assigneeMentions?: Record<string, { userId: string; userName?: string; suffix?: string }>;
    },
  ) {
    const bulletRegex = /^-\s+(.+)$/;
    const orderedRegex = /^(?:(\d+)[.)、]\s*|[（(](\d+)[)）]\s*|([一二三四五六七八九十]+)[、.．]\s*)(.+)$/;
    const versionRegex = /^(?:\d+\.\d+\.\d+(?:\.\d+)?(?:\s*\S.*)?|资源热更\s+\S(?:.*\S)?)\s*$/;
    const assigneeRegex = /^@.+$/;
    const chineseNumbers: Record<string, number> = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    let blockIndex = 0;
    const items: Array<Record<string, unknown>> = [];
    const rootId = documentId;
    const rootChildren: string[] = [];
    const stack: Array<{ indent: number; blockId: string; lineType: 'bullet' | 'ordered' }> = [];

    const createBlock = (
      blockType: number,
      text: string,
      parentId: string | null,
      elements?: Array<Record<string, unknown>>,
    ) => {
      const blockId = `${documentId}-block-${++blockIndex}`;
      const children: string[] = [];
      const textField = blockType === 12 ? 'bullet' : blockType === 13 ? 'ordered' : 'text';
      items.push({
        block_id: blockId,
        parent_id: parentId,
        block_type: blockType,
        children,
        [textField]: {
          elements: elements ?? [
            {
              text_run: {
                content: text,
              },
            },
          ],
        },
      });
      return { blockId, children };
    };

    const appendChild = (parentId: string | null, childId: string) => {
      if (!parentId) {
        rootChildren.push(childId);
        return;
      }

      const parent = items.find((item) => item.block_id === parentId);
      if (!parent) {
        rootChildren.push(childId);
        return;
      }

      const children = Array.isArray(parent.children) ? parent.children as string[] : [];
      children.push(childId);
      parent.children = children;
    };

    const parseOrderedIndex = (line: string): number | null => {
      const match = orderedRegex.exec(line);
      if (!match) {
        return null;
      }

      const arabic = match[1] ?? match[2];
      if (arabic) {
        return Number.parseInt(arabic, 10);
      }

      const chinese = match[3];
      return chinese ? (chineseNumbers[chinese] ?? null) : null;
    };

    const endsWithNestedHint = (text: string): boolean => /[:：]\s*$/.test(text.trim());

    const resolveOrderedIndent = (rawIndent: number, orderedIndex: number | null): number => {
      if (rawIndent > 0 || stack.length === 0) {
        return rawIndent;
      }

      const current = stack[stack.length - 1]!;
      if (current.lineType !== 'ordered') {
        return current.indent + 2;
      }

      const currentBlock = items.find((item) => item.block_id === current.blockId);
      const currentText = currentBlock
        ? String((((currentBlock.ordered ?? currentBlock.bullet ?? currentBlock.text) as Record<string, unknown>).elements as Array<Record<string, unknown>>)[0]?.text_run?.content ?? '')
        : '';
      if (orderedIndex === 1 && endsWithNestedHint(currentText)) {
        return current.indent + 2;
      }

      return current.indent;
    };

    items.push({
      block_id: rootId,
      parent_id: null,
      block_type: 1,
      children: rootChildren,
      page: { elements: [] },
    });

    for (const rawLine of rawContent.replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (versionRegex.test(trimmed) || assigneeRegex.test(trimmed)) {
        stack.length = 0;
        const assigneeMention = assigneeRegex.test(trimmed) ? options?.assigneeMentions?.[trimmed] : undefined;
        const assigneeElements: Array<Record<string, unknown>> | undefined = assigneeMention
          ? [
            {
              mention_user: {
                user_id: assigneeMention.userId,
                ...(assigneeMention.userName ? { user_name: assigneeMention.userName } : {}),
              },
            },
            ...(assigneeMention.suffix
              ? [{ text_run: { content: assigneeMention.suffix } }]
              : []),
          ]
          : undefined;
        const block = createBlock(2, trimmed, rootId, assigneeElements);
        appendChild(rootId, block.blockId);
        continue;
      }

      const bulletMatch = bulletRegex.exec(trimmed);
      if (bulletMatch) {
        while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
          stack.pop();
        }
        const parentId = stack[stack.length - 1]?.blockId ?? rootId;
        const block = createBlock(12, bulletMatch[1].trimEnd(), parentId);
        appendChild(parentId, block.blockId);
        stack.push({ indent, blockId: block.blockId, lineType: 'bullet' });
        continue;
      }

      const orderedMatch = orderedRegex.exec(trimmed);
      if (orderedMatch) {
        const orderedIndent = resolveOrderedIndent(indent, parseOrderedIndex(trimmed));
        while (stack.length > 0 && stack[stack.length - 1]!.indent >= orderedIndent) {
          stack.pop();
        }
        const parentId = stack[stack.length - 1]?.blockId ?? rootId;
        const block = createBlock(13, orderedMatch[4].trimEnd(), parentId);
        appendChild(parentId, block.blockId);
        stack.push({ indent: orderedIndent, blockId: block.blockId, lineType: 'ordered' });
        continue;
      }

      if (indent === 0) {
        stack.length = 0;
      }
      const parentId = indent > 0 && stack.length > 0 ? stack[stack.length - 1]!.blockId : rootId;
      const block = createBlock(2, trimmed, parentId);
      appendChild(parentId, block.blockId);
    }

    const childItemsByParent = new Map<string, Array<Record<string, unknown>>>();
    const itemById = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      if (typeof item.block_id === 'string') {
        itemById.set(item.block_id, item);
      }

      const parentId = typeof item.parent_id === 'string' ? item.parent_id : null;
      if (!parentId) {
        continue;
      }

      const siblings = childItemsByParent.get(parentId);
      if (siblings) {
        siblings.push(item);
      } else {
        childItemsByParent.set(parentId, [item]);
      }
    }

    const collectDescendants = (blockId: string): Array<Record<string, unknown>> => {
      const collected: Array<Record<string, unknown>> = [];
      const visited = new Set<string>();

      const visit = (currentBlockId: string) => {
        if (visited.has(currentBlockId)) {
          return;
        }

        visited.add(currentBlockId);
        const item = itemById.get(currentBlockId);
        if (!item) {
          return;
        }

        collected.push(item);
        const children = Array.isArray(item.children)
          ? item.children.filter((child): child is string => typeof child === 'string')
          : [];
        for (const childId of children) {
          visit(childId);
        }
      };

      visit(blockId);
      return collected;
    };

    return {
      readChildren: (blockId: string, withDescendants: boolean) => ({
        code: 'FEISHU_DOCUMENT_BLOCK_CHILDREN_READ',
        message: 'Feishu document block children read.',
        data: {
          document_id: documentId,
          block_id: blockId,
          items: withDescendants ? collectDescendants(blockId) : (childItemsByParent.get(blockId) ?? []),
          has_more: false,
          with_descendants: withDescendants,
        },
        trace_id: traceId,
      }),
    };
  }

  function extractHotfixChildrenRequest(url: string, documentId: string): { blockId: string; withDescendants: boolean } | null {
    const requestUrl = new URL(url);
    const prefix = `/api/v1/feishu/documents/${documentId}/blocks/`;
    if (!requestUrl.pathname.startsWith(prefix) || !requestUrl.pathname.endsWith('/children')) {
      return null;
    }

    return {
      blockId: decodeURIComponent(requestUrl.pathname.slice(prefix.length, requestUrl.pathname.length - '/children'.length)),
      withDescendants: requestUrl.searchParams.get('with_descendants') === 'true',
    };
  }

  function isHotfixUsersRequest(url: string): boolean {
    const requestUrl = new URL(url);
    return requestUrl.pathname === '/api/v1/users';
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

  it('converts nested assignee task bullets into parent-child task items that can be toggled independently', async () => {
    const ownerIp = '192.168.0.290';
    const memberIp = '192.168.0.291';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '结构化层级任务房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const text = [
      '8.2.0.3',
      '@汤睿哲',
      '- 修复博士皮肤我行我上的初始武器子弹配置错误',
      '- 更正超时空忍者皮肤我行我上初始武器数值配置',
      '- 修复雪狐土豪金的召唤物朝向问题',
      '- 更正雪狐土豪金的皮肤贴图',
      '@刘典',
      '- 修复恶魔术士皮肤 小乔、混沌魔王·暗月 一技能部分情况下粒子特效丢失的问题',
      '@彭禹',
      '- 修复德鲁伊武器位置有时不正确的问题',
      '@陈德贤 (luban热更，无需公告)',
      '- 调整下列活动结束时间为6.3   23：59：59',
      '  - 商城礼包、banner',
      '  - 扭蛋活动',
      '  - 鱼干/赛季商店最后一期',
      '  - 武器进化活动',
      '  - 枪械高手活动',
      '@庄鸣真',
      '- 商城礼包视频更新（无需公告）',
    ].join('\n');

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit('message:text', { roomId, text }, resolveAck);
    });

    expect(ackPayload).toMatchObject({ ok: true });
    const messageId = ackPayload.message.id;

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${messageId}/task`).send({});
    expect(convertResponse.status).toBe(200);
    expect(convertResponse.body.taskContent).toMatchObject({
      sections: [
        {
          title: '8.2.0.3',
          groups: [
            {
              assignee: '汤睿哲',
              items: [
                { text: '修复博士皮肤我行我上的初始武器子弹配置错误', completed: false },
                { text: '更正超时空忍者皮肤我行我上初始武器数值配置', completed: false },
                { text: '修复雪狐土豪金的召唤物朝向问题', completed: false },
                { text: '更正雪狐土豪金的皮肤贴图', completed: false },
              ],
            },
            {
              assignee: '刘典',
              items: [
                { text: '修复恶魔术士皮肤 小乔、混沌魔王·暗月 一技能部分情况下粒子特效丢失的问题', completed: false },
              ],
            },
            {
              assignee: '彭禹',
              items: [
                { text: '修复德鲁伊武器位置有时不正确的问题', completed: false },
              ],
            },
            {
              assignee: '陈德贤 (luban热更，无需公告)',
              items: [
                {
                  text: '调整下列活动结束时间为6.3   23：59：59',
                  completed: false,
                  children: [
                    { text: '商城礼包、banner', completed: false },
                    { text: '扭蛋活动', completed: false },
                    { text: '鱼干/赛季商店最后一期', completed: false },
                    { text: '武器进化活动', completed: false },
                    { text: '枪械高手活动', completed: false },
                  ],
                },
              ],
            },
            {
              assignee: '庄鸣真',
              items: [
                { text: '商城礼包视频更新（无需公告）', completed: false },
              ],
            },
          ],
        },
      ],
    });

    const nestedChildId = convertResponse.body.taskContent.sections[0].groups[3].items[0].children[0].id;
    const childToggleResponse = await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${messageId}/task-items/${nestedChildId}`)
      .send({ completed: true });
    expect(childToggleResponse.status).toBe(200);
    expect(childToggleResponse.body.taskContent.sections[0].groups[3].items[0]).toMatchObject({
      completed: false,
      completedByNickname: null,
      children: [
        { id: nestedChildId, completed: true, completedByNickname: '成员' },
        { completed: false, completedByNickname: null },
        { completed: false, completedByNickname: null },
        { completed: false, completedByNickname: null },
        { completed: false, completedByNickname: null },
      ],
    });
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

  it('keeps ordered multiline text as separate default tasks', async () => {
    const ownerIp = '192.168.0.281';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '编号任务房间' });
    const roomId = createResponse.body.roomId;
    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const orderedLines = [
      '1.列表查找功能加上防抖',
      '2.缺陷/需求列表人员大于2个时，点击单元格展示下拉列表，并允许删除人员',
      '3.需求详情移除子需求字段',
      '4.允许修改子需求相关字段',
      '5.新建缺陷单，新增字段关注人，发现阶段',
      '6.缺陷列表显示发现阶段，加入条件查询',
      '7.本地视图有修改时，标题显示tag：本地变更;字段设置区域上方显示快捷保存按钮',
      '8.重置时需要二次确认',
    ];

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        {
          roomId,
          text: orderedLines.join('\n'),
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
              items: orderedLines.map((text) => ({ text, completed: false })),
            },
          ],
        },
      ],
    });
  });

  it('converts explicit default task lists with nested children into hierarchical tasks', async () => {
    const ownerIp = '192.168.0.289';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '默认层级任务房间' });
    const roomId = createResponse.body.roomId;
    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const text = [
      '1. 缺陷状态变更，提单根据状态不同，自动判断给谁发送飞书通知',
      '2. 鉴权服务器开放POST等其他类型的请求',
      '3. 接入飞书文档块更新api',
      '4. 新增需求功能开发',
      '  - 新增获取多维表作为缓存：子需求模版',
      '  - 新增获取多维表作为缓存：需求类型',
      '  - 新增需求时，根据需求类型，自动去创建所有符合条件的子需求',
      '5. 服务器条件筛选接口升级，每个筛选条件因支持多个值',
    ].join('\n');

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        {
          roomId,
          text,
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
                { text: '1. 缺陷状态变更，提单根据状态不同，自动判断给谁发送飞书通知', completed: false },
                { text: '2. 鉴权服务器开放POST等其他类型的请求', completed: false },
                { text: '3. 接入飞书文档块更新api', completed: false },
                {
                  text: '4. 新增需求功能开发',
                  completed: false,
                  children: [
                    { text: '新增获取多维表作为缓存：子需求模版', completed: false },
                    { text: '新增获取多维表作为缓存：需求类型', completed: false },
                    { text: '新增需求时，根据需求类型，自动去创建所有符合条件的子需求', completed: false },
                  ],
                },
                { text: '5. 服务器条件筛选接口升级，每个筛选条件因支持多个值', completed: false },
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

  it('converts hotfix raw text without dash prefixes into structured tasks', async () => {
    const ownerIp = '192.168.0.243';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '热更原文任务房间' });
    const roomId = createResponse.body.roomId;
    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        {
          roomId,
          text: [
            '8.1.0.21',
            '@金炜星',
            '修复双登录渠道的玩家下载远古云存档可能会无法上传存档的问题',
            '@陈德贤 （luban）',
            '修复周免角色未显示的问题',
            '',
            '8.1.0.20',
            '@杨南舜',
            '修复狂战士-钧天初始武器切换到背后再切回前面时,层级没有显示在前',
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
          title: '8.1.0.21',
          groups: [
            {
              assignee: '金炜星',
              items: [
                { text: '修复双登录渠道的玩家下载远古云存档可能会无法上传存档的问题', completed: false },
              ],
            },
            {
              assignee: '陈德贤 （luban）',
              items: [
                { text: '修复周免角色未显示的问题', completed: false },
              ],
            },
          ],
        },
        {
          title: '8.1.0.20',
          groups: [
            {
              assignee: '杨南舜',
              items: [
                { text: '修复狂战士-钧天初始武器切换到背后再切回前面时,层级没有显示在前', completed: false },
              ],
            },
          ],
        },
      ],
    });
  });

  it('converts mixed hotfix titles with resource hotfix sections into structured tasks', async () => {
    const ownerIp = '192.168.0.244';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '资源热更任务房间' });
    const roomId = createResponse.body.roomId;
    const ownerSocket = await connectSocket(ownerIp);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));

    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit(
        'message:text',
        {
          roomId,
          text: [
            '8.2.0.2 (未发)',
            '@杨南舜',
            '- 修复精灵-械舞阵列·铳岚 初始武器的武器图标可能错误',
            '@刘涵',
            '- 修复船长的二技能大雨天气和海神印记一起导致海神印记无法打出伤害的问题',
            '@刘庆林',
            '- 【枪械高手】3-5海盗船boss房，冰火毒大招无法对敌人生效',
            '- 【枪械高手】击败3-5海盗船boss后报错并卡死',
            '- 【枪械高手】调大局内货币拾取范围',
            '@庄鸣真',
            '- 商城修复皮肤盲盒为首抽半价 (无需公告)',
            '@陈德贤 (luban热更，无需公告)',
            '- 枪械活动：',
            '  1. 删去武器【进击的号角】相关任务和掉落',
            '  2. 火焰炼狱/冰天雪地期间造成伤害1500→3000点',
            '  3. 难度2~6：第3、4大关敌人血量调整（将难度节点后移到3-5，4-1开始割草）',
            '  4. 难度6：第2、3大关冲锋怪、激光怪密度上调',
            '  5. 元素伤害/暴击伤害加成：5%/10%/15%——>10%/15%/20%',
            '  6. 提升(三四大关)不同品质（从低到高）的器灵价格：',
            '    1. 第三大关：18/23/27/33/43/54',
            '    2. 第四大关：24/30/36/44/58/72',
            '- PVP：PVP4月更新 - 数值',
            '  1. 平衡性调整（加强吸血鬼、工程师，削弱骑士、剑宗）',
            '  2. 天赋刷新概率调整',
            '  3. 新增武器的数值配置',
            '资源热更 8.2.0.2',
            '@彭禹',
            '- 修复吟游诗人 - 诸神之战死亡后尸体不消失的问题（无需公告）',
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
          title: '8.2.0.2 (未发)',
          groups: [
            {
              assignee: '杨南舜',
              items: [{ text: '修复精灵-械舞阵列·铳岚 初始武器的武器图标可能错误', completed: false }],
            },
            {
              assignee: '刘涵',
              items: [{ text: '修复船长的二技能大雨天气和海神印记一起导致海神印记无法打出伤害的问题', completed: false }],
            },
            {
              assignee: '刘庆林',
              items: [
                { text: '【枪械高手】3-5海盗船boss房，冰火毒大招无法对敌人生效', completed: false },
                { text: '【枪械高手】击败3-5海盗船boss后报错并卡死', completed: false },
                { text: '【枪械高手】调大局内货币拾取范围', completed: false },
              ],
            },
            {
              assignee: '庄鸣真',
              items: [{ text: '商城修复皮肤盲盒为首抽半价 (无需公告)', completed: false }],
            },
            {
              assignee: '陈德贤 (luban热更，无需公告)',
              items: [
                {
                  text: '枪械活动：',
                  completed: false,
                  children: [
                    { text: '1. 删去武器【进击的号角】相关任务和掉落', completed: false },
                    { text: '2. 火焰炼狱/冰天雪地期间造成伤害1500→3000点', completed: false },
                    { text: '3. 难度2~6：第3、4大关敌人血量调整（将难度节点后移到3-5，4-1开始割草）', completed: false },
                    { text: '4. 难度6：第2、3大关冲锋怪、激光怪密度上调', completed: false },
                    { text: '5. 元素伤害/暴击伤害加成：5%/10%/15%——>10%/15%/20%', completed: false },
                    {
                      text: '6. 提升(三四大关)不同品质（从低到高）的器灵价格：',
                      completed: false,
                      children: [
                        { text: '1. 第三大关：18/23/27/33/43/54', completed: false },
                        { text: '2. 第四大关：24/30/36/44/58/72', completed: false },
                      ],
                    },
                  ],
                },
                {
                  text: 'PVP：PVP4月更新 - 数值',
                  completed: false,
                  children: [
                    { text: '1. 平衡性调整（加强吸血鬼、工程师，削弱骑士、剑宗）', completed: false },
                    { text: '2. 天赋刷新概率调整', completed: false },
                    { text: '3. 新增武器的数值配置', completed: false },
                  ],
                },
              ],
            },
          ],
        },
        {
          title: '资源热更 8.2.0.2',
          groups: [
            {
              assignee: '彭禹',
              items: [{ text: '修复吟游诗人 - 诸神之战死亡后尸体不消失的问题（无需公告）', completed: false }],
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

  it('cascades nested task completion from a parent while preserving existing child completers', async () => {
    const ownerIp = '192.168.0.285';
    const memberIp = '192.168.0.286';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '层级任务房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const message = serverBundle.repository.addTextMessage(
      roomId,
      ownerIp,
      [
        '8.2.0.2 (未发)',
        '@陈德贤',
        '- 枪械活动：',
        '  1. 删去武器【进击的号角】相关任务和掉落',
        '  2. 火焰炼狱/冰天雪地期间造成伤害3000点',
        '  3. 提升不同品质的器灵价格：',
        '    1. 第三大关：18/23/27/33/43/54',
        '    2. 第四大关：24/30/36/44/58/72',
      ].join('\n'),
    );

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const parentItem = convertResponse.body.taskContent.sections[0].groups[0].items[0];
    const firstChild = parentItem.children[0];
    const nestedParent = parentItem.children[2];
    const firstGrandchild = nestedParent.children[0];

    const childToggleResponse = await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${firstChild.id}`)
      .send({ completed: true });
    expect(childToggleResponse.status).toBe(200);
    expect(childToggleResponse.body.taskContent.sections[0].groups[0].items[0]).toMatchObject({
      completed: false,
      completedByNickname: null,
      children: [
        { completed: true, completedByNickname: '成员' },
        { completed: false, completedByNickname: null },
        { completed: false, completedByNickname: null },
      ],
    });

    const parentToggleResponse = await debugRequest(ownerIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${parentItem.id}`)
      .send({ completed: true });
    expect(parentToggleResponse.status).toBe(200);
    expect(parentToggleResponse.body.taskContent.sections[0].groups[0].items[0]).toMatchObject({
      completed: true,
      completedByNickname: '群主',
      children: [
        { completed: true, completedByNickname: '成员' },
        { completed: true, completedByNickname: '群主' },
        {
          completed: true,
          completedByNickname: '群主',
          children: [
            { id: firstGrandchild.id, completed: true, completedByNickname: '群主' },
            { completed: true, completedByNickname: '群主' },
          ],
        },
      ],
    });

    const parentUntoggleResponse = await debugRequest(ownerIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${parentItem.id}`)
      .send({ completed: false });
    expect(parentUntoggleResponse.status).toBe(200);
    expect(parentUntoggleResponse.body.taskContent.sections[0].groups[0].items[0]).toMatchObject({
      completed: false,
      completedByNickname: null,
      children: [
        { completed: false, completedByNickname: null },
        { completed: false, completedByNickname: null },
        {
          id: nestedParent.id,
          completed: false,
          completedByNickname: null,
          children: [
            { completed: false, completedByNickname: null },
            { completed: false, completedByNickname: null },
          ],
        },
      ],
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

  it('preserves nested completion state by full path when parent items reorder during edit', async () => {
    const ownerIp = '192.168.0.287';
    const memberIp = '192.168.0.288';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '层级编辑房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const initialText = [
      '8.2.0.2 (未发)',
      '@陈德贤',
      '- 枪械活动：',
      '  1. 公共子项',
      '- PVP：PVP4月更新 - 数值',
      '  1. 公共子项',
    ].join('\n');
    const message = serverBundle.repository.addTextMessage(roomId, ownerIp, initialText);

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const activityChildId = convertResponse.body.taskContent.sections[0].groups[0].items[0].children[0].id;
    const toggleResponse = await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${activityChildId}`)
      .send({ completed: true });
    expect(toggleResponse.status).toBe(200);

    const reorderedText = [
      '8.2.0.2 (未发)',
      '@陈德贤',
      '- PVP：PVP4月更新 - 数值',
      '  1. 公共子项',
      '- 枪械活动：',
      '  1. 公共子项',
    ].join('\n');
    const editResponse = await debugRequest(ownerIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task`)
      .send({ text: reorderedText });

    expect(editResponse.status).toBe(200);
    expect(editResponse.body.taskContent.sections[0].groups[0].items).toMatchObject([
      {
        text: 'PVP：PVP4月更新 - 数值',
        completed: false,
        completedByNickname: null,
        children: [{ text: '1. 公共子项', completed: false, completedByNickname: null }],
      },
      {
        text: '枪械活动：',
        completed: true,
        completedByNickname: null,
        children: [{ text: '1. 公共子项', completed: true, completedByNickname: '成员' }],
      },
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

  it('stores hotfix settings and successful auth token for the admin page', async () => {
    const configuredBaseUrl = 'http://10.10.10.10:9000';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === `${configuredBaseUrl}/api/v1/auth/service/token`) {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/json',
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: 'configured-report-service',
          client_secret: 'configured-strong-secret',
        });

        return new Response(JSON.stringify({
          success: true,
          code: 'SERVICE_TOKEN_ISSUED',
          message: 'Service token issued.',
          data: {
            access_token: 'dmst_admin_saved_token_123456',
            token_type: 'Bearer',
            expires_in: 900,
            client_id: 'configured-report-service',
          },
          trace_id: 'trace-hotfix-admin',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const saveResponse = await debugRequest('192.168.0.273', 'admin')
      .put('/api/server/hotfix-settings')
      .send({
        baseUrl: configuredBaseUrl,
        documentId: 'doxcnHotfixDocument001',
        clientId: 'configured-report-service',
        clientSecret: 'configured-strong-secret',
      });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body.baseUrl).toBe(configuredBaseUrl);
    expect(saveResponse.body.documentId).toBe('doxcnHotfixDocument001');
    expect(saveResponse.body.clientId).toBe('configured-report-service');
    expect(saveResponse.body.clientSecret).toBe('configured-strong-secret');
    expect(saveResponse.body.auth).toBeNull();

    const authResponse = await debugRequest('192.168.0.273', 'admin')
      .post('/api/server/hotfix-settings/auth')
      .send({});

    expect(authResponse.status).toBe(200);
    expect(authResponse.body.baseUrl).toBe(configuredBaseUrl);
    expect(authResponse.body.documentId).toBe('doxcnHotfixDocument001');
    expect(authResponse.body.auth).toMatchObject({
      clientId: 'configured-report-service',
      accessToken: 'dmst_admin_saved_token_123456',
      tokenType: 'Bearer',
      expiresIn: 900,
      traceId: 'trace-hotfix-admin',
    });

    const getResponse = await debugRequest('192.168.0.273', 'admin')
      .get('/api/server/hotfix-settings');

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.baseUrl).toBe(configuredBaseUrl);
    expect(getResponse.body.documentId).toBe('doxcnHotfixDocument001');
    expect(getResponse.body.clientId).toBe('configured-report-service');
    expect(getResponse.body.clientSecret).toBe('configured-strong-secret');
    expect(getResponse.body.auth.accessToken).toBe('dmst_admin_saved_token_123456');
    expect(fetchMock).toHaveBeenCalledWith(
      `${configuredBaseUrl}/api/v1/auth/service/token`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('verifies portal jwt users and uses the portal profile as current identity', async () => {
    const portalVerifyUrl = 'http://portal.test/api/sso/jwt/verify';
    const audience = 'http://subservice.test';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === portalVerifyUrl) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          token: 'portal.jwt.sample',
          audience,
        });

        return new Response(JSON.stringify({
          success: true,
          code: 'OK',
          message: 'OK',
          data: {
            user: {
              user_id: 'ou_portal_001',
              open_id: 'open_portal_001',
              union_id: 'union_portal_001',
              name: '门户用户',
              job_title: 'QA Engineer',
              job_functions: ['qa', 'soulknight'],
            },
            claims: {
              aud: audience,
              exp: Math.floor(Date.now() / 1000) + 3600,
            },
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            audience,
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock);
    await serverBundle.close();
    config = {
      ...config,
      portalAuthRequired: true,
      portalJwtVerifyUrl: portalVerifyUrl,
      portalJwtAudience: audience,
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

    const missingTokenResponse = await request(baseUrl)
      .get('/api/me')
      .set('x-debug-client-ip', '192.168.0.300');
    expect(missingTokenResponse.status).toBe(401);

    const createResponse = await request(baseUrl)
      .post('/api/rooms')
      .set('x-debug-client-ip', '192.168.0.300')
      .set('Authorization', 'Bearer portal.jwt.sample')
      .send({ roomName: '门户房间' });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.members[0].nickname).toBe('门户用户');

    const meResponse = await request(baseUrl)
      .get('/api/me')
      .set('x-debug-client-ip', '192.168.0.300')
      .set('Authorization', 'Bearer portal.jwt.sample');
    expect(meResponse.status).toBe(200);
    expect(meResponse.body).toMatchObject({
      ip: '192.168.0.300',
      nickname: '门户用户',
      isTestUser: true,
      isSoulknightProject: true,
      portalUser: {
        user_id: 'ou_portal_001',
        name: '门户用户',
      },
    });

    const updateResponse = await request(baseUrl)
      .put('/api/me')
      .set('x-debug-client-ip', '192.168.0.300')
      .set('Authorization', 'Bearer portal.jwt.sample')
      .send({ nickname: '本地昵称' });
    expect(updateResponse.status).toBe(409);
  });

  it('revalidates portal jwt on each request so rotated signing keys invalidate old tokens', async () => {
    const portalVerifyUrl = 'http://portal.test/api/sso/jwt/verify';
    const audience = 'http://subservice.test';
    let verifyCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === portalVerifyUrl) {
        verifyCallCount += 1;
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          token: 'portal.jwt.rotated',
          audience,
        });

        if (verifyCallCount === 1) {
          return new Response(JSON.stringify({
            success: true,
            code: 'OK',
            message: 'OK',
            data: {
              user: {
                user_id: 'ou_rotated_001',
                name: '轮换前用户',
              },
              claims: {
                aud: audience,
                exp: Math.floor(Date.now() / 1000) + 3600,
              },
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              audience,
            },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({
          success: false,
          code: 'SSO_JWT_INVALID',
          message: 'SSO_JWT_INVALID',
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock);
    await serverBundle.close();
    config = {
      ...config,
      portalAuthRequired: true,
      portalJwtVerifyUrl: portalVerifyUrl,
      portalJwtAudience: audience,
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

    const firstResponse = await request(baseUrl)
      .get('/api/me')
      .set('x-debug-client-ip', '192.168.0.305')
      .set('Authorization', 'Bearer portal.jwt.rotated');
    expect(firstResponse.status).toBe(200);

    const secondResponse = await request(baseUrl)
      .get('/api/me')
      .set('x-debug-client-ip', '192.168.0.305')
      .set('Authorization', 'Bearer portal.jwt.rotated');
    expect(secondResponse.status).toBe(401);
    expect(secondResponse.body.error).toContain('登录凭证已失效');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allows the same portal user on different ips to join and mark tasks as the same identity', async () => {
    const portalVerifyUrl = 'http://portal.test/api/sso/jwt/verify';
    const audience = 'http://subservice.test';
    const ownerToken = 'portal.jwt.owner';
    const memberToken = 'portal.jwt.member';
    const acceptedTokens = new Set([ownerToken, memberToken]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === portalVerifyUrl) {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body)) as { token?: string; audience?: string };
        expect(acceptedTokens.has(body.token ?? '')).toBe(true);
        expect(body.audience).toBe(audience);

        return new Response(JSON.stringify({
          success: true,
          code: 'OK',
          message: 'OK',
          data: {
            user: {
              user_id: 'ou_same_portal_user',
              open_id: 'open_same_portal_user',
              union_id: 'union_same_portal_user',
              name: '同一门户用户',
              job_title: 'QA',
              job_functions: ['qa'],
            },
            claims: {
              aud: audience,
              exp: Math.floor(Date.now() / 1000) + 3600,
            },
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            audience,
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock);
    await serverBundle.close();
    config = {
      ...config,
      portalAuthRequired: true,
      portalJwtVerifyUrl: portalVerifyUrl,
      portalJwtAudience: audience,
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

    const authedRequest = (ip: string, token: string) => ({
      get: (path: string) => request(baseUrl).get(path).set('x-debug-client-ip', ip).set('Authorization', `Bearer ${token}`),
      post: (path: string) => request(baseUrl).post(path).set('x-debug-client-ip', ip).set('Authorization', `Bearer ${token}`),
      put: (path: string) => request(baseUrl).put(path).set('x-debug-client-ip', ip).set('Authorization', `Bearer ${token}`),
    });
    const connectPortalSocket = (ip: string, token: string): Promise<Socket> =>
      new Promise((resolveSocket, rejectSocket) => {
        const socket = ioClient(baseUrl, {
          transports: ['websocket'],
          auth: { debugIp: ip, portalJwt: token },
        });
        sockets.push(socket);
        socket.once('connect', () => resolveSocket(socket));
        socket.once('connect_error', rejectSocket);
      });

    const ownerIp = '192.168.0.310';
    const memberIp = '192.168.0.311';
    const createResponse = await authedRequest(ownerIp, ownerToken).post('/api/rooms').send({ roomName: '门户多端房间' });
    expect(createResponse.status).toBe(201);
    const roomId = createResponse.body.roomId;

    const joinResponse = await authedRequest(memberIp, memberToken).post(`/api/rooms/${roomId}/join`).send({});
    expect(joinResponse.status).toBe(200);
    expect(joinResponse.body.room.members.filter((member: { nickname: string }) => member.nickname === '同一门户用户')).toHaveLength(2);

    const ownerSocket = await connectPortalSocket(ownerIp, ownerToken);
    await new Promise<void>((resolveJoin) => ownerSocket.emit('room:joinLive', { roomId }, () => resolveJoin()));
    const ackPayload = await new Promise<any>((resolveAck) => {
      ownerSocket.emit('message:text', { roomId, text: '多端任务勾选验证' }, resolveAck);
    });
    expect(ackPayload).toMatchObject({ ok: true });

    const messageId = ackPayload.message.id;
    const convertResponse = await authedRequest(ownerIp, ownerToken).post(`/api/rooms/${roomId}/messages/${messageId}/task`).send({});
    expect(convertResponse.status).toBe(200);
    const taskItemId = convertResponse.body.taskContent.sections[0].groups[0].items[0].id;

    const updateResponse = await authedRequest(memberIp, memberToken)
      .put(`/api/rooms/${roomId}/messages/${messageId}/task-items/${taskItemId}`)
      .send({ completed: true });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.taskContent.sections[0].groups[0].items[0]).toMatchObject({
      completed: true,
      completedByNickname: '同一门户用户',
    });
  });

  it('migrates legacy profiles before creating the portal user index', async () => {
    const legacyDatabasePath = join(dataDir, 'legacy-chat.sqlite');
    const legacyDatabase = new Database(legacyDatabasePath);
    try {
      legacyDatabase.exec(`
        CREATE TABLE profiles (
          ip TEXT PRIMARY KEY,
          nickname TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO profiles (ip, nickname, created_at, updated_at)
        VALUES ('192.168.0.320', '旧库用户', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
    } finally {
      legacyDatabase.close();
    }

    const database = openDatabase(legacyDatabasePath);
    try {
      const columns = database.prepare<[], { name: string }>('PRAGMA table_info(profiles)').all().map((column) => column.name);
      expect(columns).toContain('portal_user_id');
      expect(columns).toContain('portal_open_id');
      expect(columns).toContain('portal_union_id');
      expect(columns).toContain('portal_user_payload');

      const indexes = database.prepare<[], { name: string }>('PRAGMA index_list(profiles)').all().map((index) => index.name);
      expect(indexes).toContain('idx_profiles_portal_user_id');
    } finally {
      database.close();
    }
  });

  it('fetches hotfix document content by reusing the saved token', async () => {
    const configuredBaseUrl = 'http://10.10.10.11:9001';
    const rawHotfixContent = [
      '更新日志记录',
      '',
      '8.1.0.21',
      '@金炜星',
      '修复双登录渠道的玩家下载远古云存档可能会无法上传存档的问题',
      '@陈德贤 （luban）',
      '修复周免角色未显示的问题',
      '8.1.0.20',
      '@杨南舜',
      '修复狂战士-钧天初始武器切换到背后再切回前面时,层级没有显示在前',
      '',
      '8.1.0.19',
      '@刘涵',
      '刀刀烈火在火焰状态下打不出火光的问题',
      '8.1.0.18',
      '@金炜星',
      '修复80101的鸿蒙包体好友邀请联机消息提示不支持的问题（无需公告）',
      '@刘涵',
      '刀刀烈火在火焰状态下打不出火光的问题',
      '8.1.0.17',
      '@庄鸣真',
      '修改战令在多语言下使用了错误的本地化（无需公告）',
      'LianYun001存档迁移修改存档标识（无需公告）',
      '8.1.0.16',
      '@杨南舜',
      '修复枪械回响无法触发屠龙刀攻击的问题',
      '',
      '资源热更 3/29',
      '狼人-霜银狼王·凛风三技能特效添加',
    ].join('\n');

    const expectedFilteredContent = [
      '8.1.0.21',
      '@金炜星',
      '修复双登录渠道的玩家下载远古云存档可能会无法上传存档的问题',
      '@陈德贤 （luban）',
      '修复周免角色未显示的问题',
      '',
      '8.1.0.20',
      '@杨南舜',
      '修复狂战士-钧天初始武器切换到背后再切回前面时,层级没有显示在前',
      '',
      '8.1.0.19',
      '@刘涵',
      '刀刀烈火在火焰状态下打不出火光的问题',
      '',
      '8.1.0.18',
      '@金炜星',
      '修复80101的鸿蒙包体好友邀请联机消息提示不支持的问题（无需公告）',
      '@刘涵',
      '刀刀烈火在火焰状态下打不出火光的问题',
      '',
      '8.1.0.17',
      '@庄鸣真',
      '修改战令在多语言下使用了错误的本地化（无需公告）',
      'LianYun001存档迁移修改存档标识（无需公告）',
    ].join('\n');

    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocument002',
      rawHotfixContent,
      'trace-hotfix-document',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocument002');
      if (request) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_saved_hotfix_token',
        });

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocument002',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:35:00.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_saved_hotfix_token',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:35:00.000Z',
      expiresAt: '2026-04-10T15:50:00.000Z',
      updatedAt: '2026-04-10T15:35:00.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-saved-token',
    }, '2026-04-10T15:35:00.000Z');

    const createResponse = await debugRequest('192.168.0.275').post('/api/rooms').send({ nickname: '热更用户', roomName: '热更房间' });
    const roomId = createResponse.body.roomId;

    const hotfixResponse = await debugRequest('192.168.0.275')
      .post(`/api/rooms/${roomId}/hotfix-content`)
      .send({});

    expect(hotfixResponse.status).toBe(200);
    expect(hotfixResponse.body).toMatchObject({
      documentId: 'doxcnHotfixDocument002',
      content: expectedFilteredContent,
      refreshedToken: false,
    });
    expect(hotfixResponse.body.versionBlocks).toHaveLength(5);
    expect(hotfixResponse.body.versionBlocks[0]).toMatchObject({
      versionLine: '8.1.0.21',
      content: [
        '8.1.0.21',
        '@金炜星',
        '修复双登录渠道的玩家下载远古云存档可能会无法上传存档的问题',
        '@陈德贤 （luban）',
        '修复周免角色未显示的问题',
      ].join('\n'),
      taskContent: [
        '8.1.0.21',
        '@金炜星',
        '- 修复双登录渠道的玩家下载远古云存档可能会无法上传存档的问题',
        '@陈德贤 （luban）',
        '- 修复周免角色未显示的问题',
      ].join('\n'),
    });
    expect(fetchMock.mock.calls.some(([input]) => Boolean(extractHotfixChildrenRequest(String(input), 'doxcnHotfixDocument002')))).toBe(true);
  });

  it('fetches hotfix document content with resource hotfix titles as selectable blocks', async () => {
    const configuredBaseUrl = 'http://10.10.10.15:9005';
    const rawHotfixContent = [
      '8.2.0.2 (未发)',
      '@杨南舜',
      '修复精灵-械舞阵列·铳岚 初始武器的武器图标可能错误',
      '@陈德贤 (luban热更，无需公告)',
      '- 枪械活动：',
      '1. 删去武器【进击的号角】相关任务和掉落',
      '2. 火焰炼狱/冰天雪地期间造成伤害1500→3000点',
      '3. 难度2~6：第3、4大关敌人血量调整（将难度节点后移到3-5，4-1开始割草）',
      '4. 难度6：第2、3大关冲锋怪、激光怪密度上调',
      '5. 元素伤害/暴击伤害加成：5%/10%/15%——>10%/15%/20%',
      '6. 提升(三四大关)不同品质（从低到高）的器灵价格：',
      '1. 第三大关：18/23/27/33/43/54',
      '2. 第四大关：24/30/36/44/58/72',
      '- PVP：PVP4月更新 - 数值',
      '1. 平衡性调整（加强吸血鬼、工程师，削弱骑士、剑宗）',
      '2. 天赋刷新概率调整',
      '3. 新增武器的数值配置',
      '资源热更 8.2.0.2',
      '@彭禹',
      '修复吟游诗人 - 诸神之战死亡后尸体不消失的问题（无需公告）',
      '8.2.0.1',
      '@刘涵',
      '修复船长的二技能大雨天气和海神印记一起导致海神印记无法打出伤害的问题',
    ].join('\n');

    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocument003',
      rawHotfixContent,
      'trace-hotfix-document-3',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocument003');
      if (request) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_saved_hotfix_token_3',
        });

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocument003',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:37:30.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_saved_hotfix_token_3',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:37:30.000Z',
      expiresAt: '2026-04-10T15:52:30.000Z',
      updatedAt: '2026-04-10T15:37:30.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-hotfix-token-3',
    }, '2026-04-10T15:37:30.000Z');

    const createResponse = await debugRequest('192.168.0.282').post('/api/rooms').send({ nickname: '热更用户', roomName: '资源热更房间' });
    const roomId = createResponse.body.roomId;

    const hotfixResponse = await debugRequest('192.168.0.282')
      .post(`/api/rooms/${roomId}/hotfix-content`)
      .send({});

    expect(hotfixResponse.status).toBe(200);
    expect(hotfixResponse.body.versionBlocks).toHaveLength(3);
    expect(hotfixResponse.body.versionBlocks[0]).toMatchObject({
      versionLine: '8.2.0.2 (未发)',
      taskContent: [
        '8.2.0.2 (未发)',
        '@杨南舜',
        '- 修复精灵-械舞阵列·铳岚 初始武器的武器图标可能错误',
        '@陈德贤 (luban热更，无需公告)',
        '- 枪械活动：',
        '  1. 删去武器【进击的号角】相关任务和掉落',
        '  2. 火焰炼狱/冰天雪地期间造成伤害1500→3000点',
        '  3. 难度2~6：第3、4大关敌人血量调整（将难度节点后移到3-5，4-1开始割草）',
        '  4. 难度6：第2、3大关冲锋怪、激光怪密度上调',
        '  5. 元素伤害/暴击伤害加成：5%/10%/15%——>10%/15%/20%',
        '  6. 提升(三四大关)不同品质（从低到高）的器灵价格：',
        '    1. 第三大关：18/23/27/33/43/54',
        '    2. 第四大关：24/30/36/44/58/72',
        '- PVP：PVP4月更新 - 数值',
        '  1. 平衡性调整（加强吸血鬼、工程师，削弱骑士、剑宗）',
        '  2. 天赋刷新概率调整',
        '  3. 新增武器的数值配置',
      ].join('\n'),
    });
    expect(hotfixResponse.body.versionBlocks[1]).toMatchObject({
      versionLine: '资源热更 8.2.0.2',
      content: [
        '资源热更 8.2.0.2',
        '@彭禹',
        '修复吟游诗人 - 诸神之战死亡后尸体不消失的问题（无需公告）',
      ].join('\n'),
      taskContent: [
        '资源热更 8.2.0.2',
        '@彭禹',
        '- 修复吟游诗人 - 诸神之战死亡后尸体不消失的问题（无需公告）',
      ].join('\n'),
    });
    expect(hotfixResponse.body.content).toContain('资源热更 8.2.0.2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves nested bullet children when hotfix task text is converted back into tasks', async () => {
    const configuredBaseUrl = 'http://10.10.10.22:9012';
    const rawHotfixContent = [
      '8.2.0.3',
      '@汤睿哲',
      '修复博士皮肤我行我上的初始武器子弹配置错误',
      '@陈德贤 (luban热更，无需公告)',
      '- 调整下列活动结束时间为6.3   23：59：59',
      '  - 商城礼包、banner',
      '  - 扭蛋活动',
      '  - 鱼干/赛季商店最后一期',
      '  - 武器进化活动',
      '  - 枪械高手活动',
      '@庄鸣真',
      '商城礼包视频更新（无需公告）',
    ].join('\n');

    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocumentNestedBullet001',
      rawHotfixContent,
      'trace-hotfix-document-nested-bullet',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocumentNestedBullet001');
      if (request) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_saved_hotfix_token_nested_bullet',
        });

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocumentNestedBullet001',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:38:30.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_saved_hotfix_token_nested_bullet',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:38:30.000Z',
      expiresAt: '2026-04-10T15:53:30.000Z',
      updatedAt: '2026-04-10T15:38:30.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-hotfix-token-nested-bullet',
    }, '2026-04-10T15:38:30.000Z');

    const ownerIp = '192.168.0.292';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '热更用户', roomName: '热更层级子项房间' });
    const roomId = createResponse.body.roomId;

    const hotfixResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/hotfix-content`)
      .send({});

    expect(hotfixResponse.status).toBe(200);
    expect(hotfixResponse.body.versionBlocks[0]).toMatchObject({
      versionLine: '8.2.0.3',
      taskContent: [
        '8.2.0.3',
        '@汤睿哲',
        '- 修复博士皮肤我行我上的初始武器子弹配置错误',
        '@陈德贤 (luban热更，无需公告)',
        '- 调整下列活动结束时间为6.3   23：59：59',
        '  - 商城礼包、banner',
        '  - 扭蛋活动',
        '  - 鱼干/赛季商店最后一期',
        '  - 武器进化活动',
        '  - 枪械高手活动',
        '@庄鸣真',
        '- 商城礼包视频更新（无需公告）',
      ].join('\n'),
    });

    const hotfixTaskMessage = serverBundle.repository.addTextMessage(
      roomId,
      ownerIp,
      hotfixResponse.body.versionBlocks[0].taskContent,
    );
    const convertResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/messages/${hotfixTaskMessage.id}/task`)
      .send({});

    expect(convertResponse.status).toBe(200);
    expect(convertResponse.body.taskContent).toMatchObject({
      sections: [
        {
          title: '8.2.0.3',
          groups: [
            {
              assignee: '汤睿哲',
              items: [{ text: '修复博士皮肤我行我上的初始武器子弹配置错误', completed: false }],
            },
            {
              assignee: '陈德贤 (luban热更，无需公告)',
              items: [
                {
                  text: '调整下列活动结束时间为6.3   23：59：59',
                  completed: false,
                  children: [
                    { text: '商城礼包、banner', completed: false },
                    { text: '扭蛋活动', completed: false },
                    { text: '鱼干/赛季商店最后一期', completed: false },
                    { text: '武器进化活动', completed: false },
                    { text: '枪械高手活动', completed: false },
                  ],
                },
              ],
            },
            {
              assignee: '庄鸣真',
              items: [{ text: '商城礼包视频更新（无需公告）', completed: false }],
            },
          ],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves missing mention assignee names from the user directory when fetching hotfix document content', async () => {
    const configuredBaseUrl = 'http://10.10.10.18:9008';
    const rawHotfixContent = [
      '8.2.0.2',
      '@杨南舜',
      '修复精灵-械舞阵列·铳岚 初始武器的武器图标可能错误',
      '@陈德贤 (luban热更，无需公告)',
      '修复活动配置',
    ].join('\n');
    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocument005',
      rawHotfixContent,
      'trace-hotfix-document-5',
      {
        assigneeMentions: {
          '@杨南舜': { userId: 'ou_yang' },
          '@陈德贤 (luban热更，无需公告)': { userId: 'ou_chen', suffix: ' (luban热更，无需公告)' },
        },
      },
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocument005');
      if (request) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_saved_hotfix_token_5',
        });

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (isHotfixUsersRequest(url)) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_saved_hotfix_token_5',
        });

        return new Response(JSON.stringify({
          success: true,
          code: 'OK',
          message: 'OK',
          data: [
            { user_id: 'ou_yang', name: '杨南舜' },
            { user_id: 'ou_chen', name: '陈德贤' },
          ],
          trace_id: 'trace-hotfix-users-5',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocument005',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:41:00.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_saved_hotfix_token_5',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:41:00.000Z',
      expiresAt: '2026-04-10T15:56:00.000Z',
      updatedAt: '2026-04-10T15:41:00.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-hotfix-token-5',
    }, '2026-04-10T15:41:00.000Z');

    const createResponse = await debugRequest('192.168.0.289').post('/api/rooms').send({ nickname: '热更用户', roomName: '热更用户目录房间' });
    const roomId = createResponse.body.roomId;

    const hotfixResponse = await debugRequest('192.168.0.289')
      .post(`/api/rooms/${roomId}/hotfix-content`)
      .send({});

    expect(hotfixResponse.status).toBe(200);
    expect(hotfixResponse.body.content).toBe(rawHotfixContent);
    expect(hotfixResponse.body.versionBlocks[0]).toMatchObject({
      taskContent: [
        '8.2.0.2',
        '@杨南舜',
        '- 修复精灵-械舞阵列·铳岚 初始武器的武器图标可能错误',
        '@陈德贤 (luban热更，无需公告)',
        '- 修复活动配置',
      ].join('\n'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes the saved token when user directory lookup reports token expired', async () => {
    const configuredBaseUrl = 'http://10.10.10.19:9009';
    const rawHotfixContent = [
      '8.2.0.2',
      '@杨南舜',
      '新版本任务',
    ].join('\n');
    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocument006',
      rawHotfixContent,
      'trace-hotfix-document-6',
      {
        assigneeMentions: {
          '@杨南舜': { userId: 'ou_yang' },
        },
      },
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocument006');
      if (request) {
        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (isHotfixUsersRequest(url)) {
        if (init?.headers && (init.headers as Record<string, string>).Authorization === 'Bearer dmst_expired_hotfix_token_6') {
          return new Response(JSON.stringify({
            code: 'SERVICE_TOKEN_EXPIRED',
            message: 'token expired',
          }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_refreshed_hotfix_token_6',
        });

        return new Response(JSON.stringify({
          success: true,
          code: 'OK',
          message: 'OK',
          data: [
            { user_id: 'ou_yang', name: '杨南舜' },
          ],
          trace_id: 'trace-hotfix-users-6',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === `${configuredBaseUrl}/api/v1/auth/service/token`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: 'report-service',
          client_secret: 'replace-with-strong-secret',
        });

        return new Response(JSON.stringify({
          success: true,
          code: 'SERVICE_TOKEN_ISSUED',
          message: 'Service token issued.',
          data: {
            access_token: 'dmst_refreshed_hotfix_token_6',
            token_type: 'Bearer',
            expires_in: 900,
            client_id: 'report-service',
          },
          trace_id: 'trace-hotfix-refreshed-6',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocument006',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:42:00.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_expired_hotfix_token_6',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:27:00.000Z',
      expiresAt: '2026-04-10T15:42:00.000Z',
      updatedAt: '2026-04-10T15:27:00.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-expired-token-6',
    }, '2026-04-10T15:27:00.000Z');

    const createResponse = await debugRequest('192.168.0.290').post('/api/rooms').send({ nickname: '热更刷新用户', roomName: '热更用户目录刷新房间' });
    const roomId = createResponse.body.roomId;

    const authResponse = await debugRequest('192.168.0.290')
      .post(`/api/rooms/${roomId}/hotfix-content`)
      .send({});

    expect(authResponse.status).toBe(200);
    expect(authResponse.body).toMatchObject({
      documentId: 'doxcnHotfixDocument006',
      content: rawHotfixContent,
      refreshedToken: true,
    });

    const updatedSettings = settingsStore.getHotfixSettings();
    expect(updatedSettings.auth?.accessToken).toBe('dmst_refreshed_hotfix_token_6');
    expect(updatedSettings.auth?.traceId).toBe('trace-hotfix-refreshed-6');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('splits version blocks when the version title contains suffix text', async () => {
    const configuredBaseUrl = 'http://10.10.10.17:9007';
    const rawHotfixContent = [
      '5.4.7.2',
      '@杨南舜',
      '新版本任务',
      '4.3.1秋季修复包热更新修复（热更新版本4.3.1.1）',
      '@刘涵',
      '秋季修复任务',
      '资源热更 4.3.1.1',
      '@彭禹',
      '资源版本任务',
    ].join('\n');
    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocument004',
      rawHotfixContent,
      'trace-hotfix-document-4',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocument004');
      if (request) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_saved_hotfix_token_4',
        });

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocument004',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:40:00.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_saved_hotfix_token_4',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:40:00.000Z',
      expiresAt: '2026-04-10T15:55:00.000Z',
      updatedAt: '2026-04-10T15:40:00.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-hotfix-token-4',
    }, '2026-04-10T15:40:00.000Z');

    const createResponse = await debugRequest('192.168.0.285').post('/api/rooms').send({ nickname: '热更用户', roomName: '热更标题房间' });
    const roomId = createResponse.body.roomId;

    const hotfixResponse = await debugRequest('192.168.0.285')
      .post(`/api/rooms/${roomId}/hotfix-content`)
      .send({});

    expect(hotfixResponse.status).toBe(200);
    expect(hotfixResponse.body.versionBlocks.map((block: { versionLine: string }) => block.versionLine)).toEqual([
      '5.4.7.2',
      '4.3.1秋季修复包热更新修复（热更新版本4.3.1.1）',
      '资源热更 4.3.1.1',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes the saved token when hotfix document reading reports token expired', async () => {
    const configuredBaseUrl = 'http://10.10.10.12:9002';
    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocument003',
      '刷新后的热更内容',
      'trace-hotfix-after-refresh',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocument003');
      if (request) {
        const callIndex = fetchMock.mock.calls.length;

        if (request.blockId === 'doxcnHotfixDocument003' && !request.withDescendants && callIndex === 1) {
          return new Response(JSON.stringify({
            code: 'SERVICE_TOKEN_EXPIRED',
            message: 'token expired',
          }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === `${configuredBaseUrl}/api/v1/auth/service/token`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: 'report-service',
          client_secret: 'replace-with-strong-secret',
        });

        return new Response(JSON.stringify({
          success: true,
          code: 'SERVICE_TOKEN_ISSUED',
          message: 'Service token issued.',
          data: {
            access_token: 'dmst_refreshed_hotfix_token',
            token_type: 'Bearer',
            expires_in: 900,
            client_id: 'report-service',
          },
          trace_id: 'trace-hotfix-refreshed',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocument003',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:36:00.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_expired_hotfix_token',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:20:00.000Z',
      expiresAt: '2026-04-10T15:35:00.000Z',
      updatedAt: '2026-04-10T15:20:00.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-expired-token',
    }, '2026-04-10T15:20:00.000Z');

    const createResponse = await debugRequest('192.168.0.274').post('/api/rooms').send({ nickname: '热更刷新用户', roomName: '热更刷新房间' });
    const roomId = createResponse.body.roomId;

    const authResponse = await debugRequest('192.168.0.274')
      .post(`/api/rooms/${roomId}/hotfix-content`)
      .send({});

    expect(authResponse.status).toBe(200);
    expect(authResponse.body).toMatchObject({
      documentId: 'doxcnHotfixDocument003',
      content: '刷新后的热更内容',
      refreshedToken: true,
    });
    expect(authResponse.body.versionBlocks).toEqual([]);

    const updatedSettings = settingsStore.getHotfixSettings();
    expect(updatedSettings.auth?.accessToken).toBe('dmst_refreshed_hotfix_token');
    expect(updatedSettings.auth?.traceId).toBe('trace-hotfix-refreshed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refreshes hotfix tasks with latest document content and marks changed items', async () => {
    const configuredBaseUrl = 'http://10.10.10.13:9003';
    const rawHotfixContent = [
      '8.1.0.21',
      '@金炜星',
      '保留任务',
      '改后任务',
      '@陈德贤',
      '保持另一条',
      '新增任务',
      '',
      '8.1.0.20',
      '@杨南舜',
      '旧版本任务',
    ].join('\n');

    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocumentRefresh001',
      rawHotfixContent,
      'trace-hotfix-refresh-task',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocumentRefresh001');
      if (request) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_refresh_hotfix_token',
        });

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocumentRefresh001',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:37:00.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_refresh_hotfix_token',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:37:00.000Z',
      expiresAt: '2026-04-10T15:52:00.000Z',
      updatedAt: '2026-04-10T15:37:00.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-refresh-token',
    }, '2026-04-10T15:37:00.000Z');

    const ownerIp = '192.168.0.276';
    const memberIp = '192.168.0.277';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '热更刷新任务房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const message = serverBundle.repository.addTextMessage(
      roomId,
      ownerIp,
      [
        '8.1.0.21',
        '@金炜星',
        '- 保留任务',
        '- 改前任务',
        '@刘涵',
        '- 保持另一条',
      ].join('\n'),
    );

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const keepTaskId = convertResponse.body.taskContent.sections[0].groups[0].items[0].id;
    const oldTaskId = convertResponse.body.taskContent.sections[0].groups[0].items[1].id;
    const movedTaskId = convertResponse.body.taskContent.sections[0].groups[1].items[0].id;

    await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${keepTaskId}`)
      .send({ completed: true });
    await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${oldTaskId}`)
      .send({ completed: true });
    await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${movedTaskId}`)
      .send({ completed: true });

    const refreshResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/messages/${message.id}/hotfix-refresh`)
      .send({});

    expect(refreshResponse.status).toBe(200);
    expect(refreshResponse.body.refreshedToken).toBe(false);
    expect(refreshResponse.body.message.textContent).toBe([
      '8.1.0.21',
      '@金炜星',
      '- 保留任务',
      '- 改后任务',
      '@陈德贤',
      '- 保持另一条',
      '- 新增任务',
    ].join('\n'));
    expect(refreshResponse.body.message.taskContent).toMatchObject({
      sections: [
        {
          title: '8.1.0.21',
          groups: [
            {
              assignee: '金炜星',
              items: [
                { text: '保留任务', completed: true, completedByNickname: '成员', changed: false },
                { text: '改后任务', completed: false, completedByNickname: null, changed: true },
              ],
            },
            {
              assignee: '陈德贤',
              items: [
                { text: '保持另一条', completed: false, completedByNickname: null, changed: true },
                { text: '新增任务', completed: false, completedByNickname: null, changed: true },
              ],
            },
          ],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('removes missing hotfix versions when refreshing from the latest document', async () => {
    const configuredBaseUrl = 'http://10.10.10.14:9004';
    const rawHotfixContent = [
      '8.1.0.21',
      '@金炜星',
      '保留版本任务',
    ].join('\n');

    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocumentRefresh002',
      rawHotfixContent,
      'trace-hotfix-refresh-task-2',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocumentRefresh002');
      if (request) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_refresh_hotfix_token_2',
        });

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocumentRefresh002',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:38:00.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_refresh_hotfix_token_2',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:38:00.000Z',
      expiresAt: '2026-04-10T15:53:00.000Z',
      updatedAt: '2026-04-10T15:38:00.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-refresh-token-2',
    }, '2026-04-10T15:38:00.000Z');

    const ownerIp = '192.168.0.278';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '热更版本收敛房间' });
    const roomId = createResponse.body.roomId;

    const message = serverBundle.repository.addTextMessage(
      roomId,
      ownerIp,
      [
        '8.1.0.21',
        '@金炜星',
        '- 保留版本任务',
        '',
        '8.1.0.20',
        '@杨南舜',
        '- 旧版本任务',
      ].join('\n'),
    );

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const refreshResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/messages/${message.id}/hotfix-refresh`)
      .send({});

    expect(refreshResponse.status).toBe(200);
    expect(refreshResponse.body.message.textContent).toBe([
      '8.1.0.21',
      '@金炜星',
      '- 保留版本任务',
    ].join('\n'));
    expect(refreshResponse.body.message.taskContent.sections).toHaveLength(1);
    expect(refreshResponse.body.message.taskContent.sections[0]).toMatchObject({
      title: '8.1.0.21',
      groups: [
        {
          assignee: '金炜星',
          items: [
            { text: '保留版本任务', changed: false },
          ],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('limits hotfix task refresh matching to the latest five document versions', async () => {
    const configuredBaseUrl = 'http://10.10.10.20:9010';
    const rawHotfixContent = [
      '8.1.0.25',
      '@金炜星',
      '最新版本任务',
      '8.1.0.24',
      '@金炜星',
      '第二个版本任务',
      '8.1.0.23',
      '@金炜星',
      '第三个版本任务',
      '8.1.0.22',
      '@金炜星',
      '第四个版本任务',
      '8.1.0.21',
      '@金炜星',
      '第五个版本任务',
      '8.1.0.20',
      '@金炜星',
      '第六个版本任务',
    ].join('\n');

    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocumentRefresh004',
      rawHotfixContent,
      'trace-hotfix-refresh-task-4',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocumentRefresh004');
      if (request) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_refresh_hotfix_token_4',
        });

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocumentRefresh004',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:39:00.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_refresh_hotfix_token_4',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:39:00.000Z',
      expiresAt: '2026-04-10T15:54:00.000Z',
      updatedAt: '2026-04-10T15:39:00.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-refresh-token-4',
    }, '2026-04-10T15:39:00.000Z');

    const ownerIp = '192.168.0.291';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '热更最近五版房间' });
    const roomId = createResponse.body.roomId;

    const message = serverBundle.repository.addTextMessage(
      roomId,
      ownerIp,
      [
        '8.1.0.20',
        '@金炜星',
        '- 第六个版本任务',
      ].join('\n'),
    );

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const refreshResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/messages/${message.id}/hotfix-refresh`)
      .send({});

    expect(refreshResponse.status).toBe(409);
    expect(refreshResponse.body.error).toContain('当前热更文档中未找到该任务对应的版本');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes resource hotfix tasks with the latest document content', async () => {
    const configuredBaseUrl = 'http://10.10.10.16:9006';
    const rawHotfixContent = [
      '资源热更 8.2.0.2',
      '@彭禹',
      '保留资源任务',
      '新增资源任务',
    ].join('\n');

    const hotfixBlocks = buildHotfixBlockFixtures(
      'doxcnHotfixDocumentRefresh003',
      rawHotfixContent,
      'trace-hotfix-refresh-task-3',
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const request = extractHotfixChildrenRequest(url, 'doxcnHotfixDocumentRefresh003');
      if (request) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer dmst_refresh_hotfix_token_3',
        });

        return new Response(JSON.stringify(
          hotfixBlocks.readChildren(request.blockId, request.withDescendants),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
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

    const settingsStore = new SettingsStore(serverBundle.database);
    settingsStore.saveHotfixSettings({
      baseUrl: configuredBaseUrl,
      documentId: 'doxcnHotfixDocumentRefresh003',
      clientId: 'report-service',
      clientSecret: 'replace-with-strong-secret',
    }, '2026-04-10T15:39:00.000Z');
    settingsStore.saveHotfixAuthRecord({
      clientId: 'report-service',
      accessToken: 'dmst_refresh_hotfix_token_3',
      tokenType: 'Bearer',
      expiresIn: 900,
      issuedAt: '2026-04-10T15:39:00.000Z',
      expiresAt: '2026-04-10T15:54:00.000Z',
      updatedAt: '2026-04-10T15:39:00.000Z',
      code: 'SERVICE_TOKEN_ISSUED',
      message: 'Service token issued.',
      traceId: 'trace-refresh-token-3',
    }, '2026-04-10T15:39:00.000Z');

    const ownerIp = '192.168.0.283';
    const memberIp = '192.168.0.284';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '群主', roomName: '资源热更刷新房间' });
    const roomId = createResponse.body.roomId;
    await debugRequest(memberIp).post(`/api/rooms/${roomId}/join`).send({ nickname: '成员' });

    const message = serverBundle.repository.addTextMessage(
      roomId,
      ownerIp,
      [
        '资源热更 8.2.0.2',
        '@彭禹',
        '- 保留资源任务',
        '- 旧资源任务',
      ].join('\n'),
    );

    const convertResponse = await debugRequest(ownerIp).post(`/api/rooms/${roomId}/messages/${message.id}/task`).send({});
    expect(convertResponse.status).toBe(200);

    const keepTaskId = convertResponse.body.taskContent.sections[0].groups[0].items[0].id;
    await debugRequest(memberIp)
      .put(`/api/rooms/${roomId}/messages/${message.id}/task-items/${keepTaskId}`)
      .send({ completed: true });

    const refreshResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/messages/${message.id}/hotfix-refresh`)
      .send({});

    expect(refreshResponse.status).toBe(200);
    expect(refreshResponse.body.refreshedToken).toBe(false);
    expect(refreshResponse.body.message.textContent).toBe([
      '资源热更 8.2.0.2',
      '@彭禹',
      '- 保留资源任务',
      '- 新增资源任务',
    ].join('\n'));
    expect(refreshResponse.body.message.taskContent).toMatchObject({
      sections: [
        {
          title: '资源热更 8.2.0.2',
          groups: [
            {
              assignee: '彭禹',
              items: [
                { text: '保留资源任务', completed: true, completedByNickname: '成员', changed: false },
                { text: '新增资源任务', completed: false, completedByNickname: null, changed: true },
              ],
            },
          ],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(notifyResponse.body.ok).toBe(true);
    expect(typeof notifyResponse.body.message?.taskNotifiedAt).toBe('string');
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

  it('stores package tester settings for the admin page', async () => {
    const saveResponse = await debugRequest('192.168.0.91', 'admin')
      .put('/api/server/package-testers')
      .send({
        testers: ['测试甲', '测试乙', '测试甲', '  ', '测试丙'],
      });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body).toMatchObject({
      testers: ['测试甲', '测试乙', '测试丙'],
    });
    expect(saveResponse.body.updatedAt).toBeTruthy();

    const getResponse = await debugRequest('192.168.0.91', 'admin').get('/api/server/package-testers');
    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toMatchObject({
      testers: ['测试甲', '测试乙', '测试丙'],
    });
  });

  it('previews package directory links and sends a package distribution task', async () => {
    const ownerIp = '192.168.0.92';
    const createResponse = await debugRequest(ownerIp).post('/api/rooms').send({ nickname: '包体群主', roomName: '包体任务房间' });
    const roomId = createResponse.body.roomId;

    const previewUrlA = 'http://192.168.60.45:8000/UnityOutput/Branch-A/100-202604071505-8.1.0/';
    const previewUrlB = 'http://192.168.60.45:8000/UnityOutput/Branch-B/200-202604071506-8.1.1/';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === previewUrlA) {
        return new Response([
          "<meta name='viewport' content='width=device-width' />",
          '<body>',
          "<a href='..'>..</a>",
          '<ul>',
          "<li><a href='logs/'>logs/</a>",
          "<li><a href='game-a.aab'>game-a.aab</a>",
          "<li><a href='bundle-a.apks'>bundle-a.apks</a>",
          "<li><a href='build.log'>build.log</a>",
          '</ul>',
        ].join(''), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (url === previewUrlB) {
        return new Response([
          "<meta name='viewport' content='width=device-width' />",
          '<body>',
          "<a href='..'>..</a>",
          '<ul>',
          "<li><a href='symbols/'>symbols/</a>",
          "<li><a href='game-b.apk'>game-b.apk</a>",
          "<li><a href='notes.txt'>notes.txt</a>",
          '</ul>',
        ].join(''), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      return new Response('not found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const saveTesterResponse = await debugRequest('192.168.0.91', 'admin')
      .put('/api/server/package-testers')
      .send({
        testers: ['测试甲', '测试乙'],
      });
    expect(saveTesterResponse.status).toBe(200);

    const previewResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/package-distribution/preview`)
      .send({
        links: [previewUrlA, previewUrlB],
      });

    expect(previewResponse.status).toBe(200);
    expect(previewResponse.body.testers).toEqual(['测试甲', '测试乙']);
    expect(previewResponse.body.blocks).toHaveLength(2);
    expect(previewResponse.body.blocks[0]).toMatchObject({
      sourceUrl: previewUrlA,
      fileCount: 2,
      directoryCount: 1,
      entries: [
        { name: 'logs', entryType: 'directory' },
        { name: 'game-a.aab', entryType: 'file' },
        { name: 'bundle-a.apks', entryType: 'file' },
      ],
    });
    expect(previewResponse.body.blocks[1]).toMatchObject({
      sourceUrl: previewUrlB,
      fileCount: 1,
      directoryCount: 1,
      entries: [
        { name: 'symbols', entryType: 'directory' },
        { name: 'game-b.apk', entryType: 'file' },
      ],
    });

    const packageTaskResponse = await debugRequest(ownerIp)
      .post(`/api/rooms/${roomId}/package-distribution/task`)
      .send({
        blocks: previewResponse.body.blocks.map((block: any, blockIndex: number) => ({
          title: block.title,
          sourceUrl: block.sourceUrl,
          entries: block.entries.map((entry: any, entryIndex: number) => ({
            ...entry,
            assignees: entry.entryType === 'file'
              ? (
                  blockIndex === 0
                    ? (entry.name === 'game-a.aab' ? ['测试甲', '测试乙'] : ['测试乙'])
                    : ['测试甲', '测试乙']
                )
              : undefined,
          })),
        })),
      });

    expect(packageTaskResponse.status).toBe(201);
    expect(packageTaskResponse.body.taskContent).toMatchObject({
      kind: 'package-distribution',
      sections: [
        {
          title: 'Branch-A / 100-202604071505-8.1.0',
          groups: [
            {
              assignee: '测试甲',
              items: [
                { text: 'game-a.aab' },
              ],
            },
            {
              assignee: '测试乙',
              items: [
                { text: 'game-a.aab' },
                { text: 'bundle-a.apks' },
              ],
            },
          ],
          packageSource: {
            sourceUrl: previewUrlA,
            entries: [
              { name: 'logs', entryType: 'directory' },
              { name: 'game-a.aab', entryType: 'file' },
              { name: 'bundle-a.apks', entryType: 'file' },
            ],
          },
        },
        {
          title: 'Branch-B / 200-202604071506-8.1.1',
          groups: [
            {
              assignee: '测试甲',
              items: [
                { text: 'game-b.apk' },
              ],
            },
            {
              assignee: '测试乙',
              items: [
                { text: 'game-b.apk' },
              ],
            },
          ],
          packageSource: {
            sourceUrl: previewUrlB,
            entries: [
              { name: 'symbols', entryType: 'directory' },
              { name: 'game-b.apk', entryType: 'file' },
            ],
          },
        },
      ],
    });
    expect(packageTaskResponse.body.taskContent.sections[0].groups[0].items[0].resource).toMatchObject({
      kind: 'remote-package-file',
      sourceUrl: previewUrlA,
      fileUrl: `${previewUrlA}game-a.aab`,
      fileName: 'game-a.aab',
      filePath: 'game-a.aab',
    });
    expect(packageTaskResponse.body.textContent).toContain(`链接：${previewUrlA}`);

    const messagesResponse = await debugRequest(ownerIp).get(`/api/rooms/${roomId}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(messagesResponse.body.items).toHaveLength(1);
    expect(messagesResponse.body.items[0].taskContent.kind).toBe('package-distribution');
    expect(messagesResponse.body.items[0].taskContent.sections).toHaveLength(2);
  });

});
