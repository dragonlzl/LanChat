import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { Request } from 'express';
import type { Socket } from 'socket.io';

export function normalizeIp(value: string | null | undefined): string {
  if (!value) {
    return 'unknown';
  }

  const trimmed = value.trim().replace(/^\[/, '').replace(/\]$/, '');

  if (trimmed === '::1') {
    return '127.0.0.1';
  }

  if (trimmed.startsWith('::ffff:')) {
    return normalizeIp(trimmed.slice(7));
  }

  if (trimmed.startsWith('ffff:')) {
    return normalizeIp(trimmed.slice(5));
  }

  if (isIP(trimmed)) {
    return trimmed.toLowerCase();
  }

  const portMatch = trimmed.match(/^(.+):(\d+)$/);
  if (portMatch && isIP(portMatch[1])) {
    return normalizeIp(portMatch[1]);
  }

  return trimmed.toLowerCase();
}

function resolveIncomingAddress(message: IncomingMessage): string | undefined {
  return message.socket.remoteAddress ?? undefined;
}

export function getRequestIp(request: Request, allowDebugIp: boolean): string {
  const debugIp = request.header('x-debug-client-ip');
  if (allowDebugIp && debugIp) {
    return normalizeIp(debugIp);
  }

  return normalizeIp(resolveIncomingAddress(request));
}

export function getSocketIp(socket: Socket, allowDebugIp: boolean): string {
  const debugIp =
    (typeof socket.handshake.auth.debugIp === 'string' && socket.handshake.auth.debugIp) ||
    (typeof socket.handshake.query.debugIp === 'string' && socket.handshake.query.debugIp) ||
    undefined;

  if (allowDebugIp && debugIp) {
    return normalizeIp(debugIp);
  }

  return normalizeIp(resolveIncomingAddress(socket.request));
}
