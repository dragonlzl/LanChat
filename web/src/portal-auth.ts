export interface PortalUser {
  user_id?: string;
  open_id?: string;
  union_id?: string;
  name?: string;
  avatar_url?: string;
  tenant_key?: string;
  issued_at?: string | number;
  expires_at?: string | number;
  job_title?: string;
  job_functions?: string[];
  department_ids?: string[];
  status?: string;
  profile_status?: string;
  job_title_status?: string;
}

export interface PortalJwtSession {
  user: PortalUser;
  token: string;
  claims: Record<string, unknown>;
  expiresAt: string | number | null;
  audience?: string;
  audiences?: string[];
  isTestUser?: boolean;
  isSoulknightProject?: boolean;
}

type PortalAuthClient = {
  requireJwtUser: (options?: { returnTo?: string; clientId?: string }) => Promise<PortalUser>;
  requireJwtSession: (options?: { returnTo?: string; clientId?: string }) => Promise<PortalJwtSession>;
  getJwtSession: () => Promise<PortalJwtSession | PortalJwtSessionError | null>;
  clearJwtSession: () => Promise<void> | void;
};

declare global {
  interface Window {
    portalAuth?: PortalAuthClient;
  }
}

const LOGIN_GUARD_STORAGE_KEY = 'webchat_portal_jwt_login_guard_v1';
const LOGIN_GUARD_WINDOW_MS = 2 * 60 * 1000;
const LOGIN_GUARD_MAX_ATTEMPTS = 3;

let portalSessionPromise: Promise<PortalJwtSession> | null = null;
let currentPortalSession: PortalJwtSession | null = null;
let currentPortalUser: PortalUser | null = null;

type PortalJwtSessionError = {
  authenticated?: false;
  error?: string;
  message?: string;
  expiresAt?: string | number | null;
};

type LoginGuardState = {
  scope: string;
  startedAt: number;
  attempts: number;
};

function getLoginScope(): string {
  return `${window.location.origin}${window.location.pathname}${window.location.search}`;
}

function readLoginGuard(): LoginGuardState | null {
  try {
    const raw = window.sessionStorage.getItem(LOGIN_GUARD_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<LoginGuardState>;
    if (
      typeof parsed.scope !== 'string'
      || typeof parsed.startedAt !== 'number'
      || typeof parsed.attempts !== 'number'
    ) {
      return null;
    }

    return {
      scope: parsed.scope,
      startedAt: parsed.startedAt,
      attempts: parsed.attempts,
    };
  } catch {
    return null;
  }
}

function hasJwtCallbackFragment(): boolean {
  return window.location.hash.includes('portal_jwt=');
}

function markLoginAttempt() {
  const now = Date.now();
  const scope = getLoginScope();
  const current = readLoginGuard();
  const nextAttempts =
    current && current.scope === scope && now - current.startedAt <= LOGIN_GUARD_WINDOW_MS
      ? current.attempts + 1
      : 1;

  if (nextAttempts > LOGIN_GUARD_MAX_ATTEMPTS && !hasJwtCallbackFragment()) {
    throw new Error('JWT 登录多次未完成，已停止自动跳转。请清理登录态后重试。');
  }

  window.sessionStorage.setItem(
    LOGIN_GUARD_STORAGE_KEY,
    JSON.stringify({
      scope,
      startedAt: current?.scope === scope ? current.startedAt : now,
      attempts: nextAttempts,
    } satisfies LoginGuardState),
  );
}

export function resetPortalLoginGuard() {
  window.sessionStorage.removeItem(LOGIN_GUARD_STORAGE_KEY);
  portalSessionPromise = null;
}

export async function clearPortalJwtSession(): Promise<void> {
  currentPortalSession = null;
  currentPortalUser = null;
  await window.portalAuth?.clearJwtSession();
}

export function getCurrentPortalJwtUser(): PortalUser | null {
  return currentPortalUser ?? currentPortalSession?.user ?? null;
}

function createPortalAuthOptions() {
  return {
    returnTo: window.location.href,
    clientId: window.location.origin,
  };
}

function getPortalAuthInvalidMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const session = value as PortalJwtSessionError;
  if (session.authenticated === false && session.error === 'SSO_JWT_INVALID') {
    return session.message || '登录凭证已失效，正在重新登录';
  }

  return null;
}

function isPortalJwtSession(value: unknown): value is PortalJwtSession {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as Partial<PortalJwtSession>).token === 'string'
    && typeof (value as Partial<PortalJwtSession>).user === 'object'
    && (value as Partial<PortalJwtSession>).user !== null
  );
}

export function requirePortalJwtSession(): Promise<PortalJwtSession> {
  if (portalSessionPromise) {
    return portalSessionPromise;
  }

  portalSessionPromise = (async () => {
    if (!window.portalAuth?.requireJwtUser || !window.portalAuth?.requireJwtSession) {
      throw new Error('测试服务门户脚本未加载，无法进行 JWT 登录检测。');
    }

    markLoginAttempt();
    const options = createPortalAuthOptions();
    const verifiedUser = await window.portalAuth.requireJwtUser(options);
    const session = await window.portalAuth.requireJwtSession(options);

    const invalidMessage = getPortalAuthInvalidMessage(session);
    if (invalidMessage) {
      throw new Error(invalidMessage);
    }

    if (!isPortalJwtSession(session)) {
      throw new Error('测试服务门户未返回有效 JWT 会话。');
    }

    resetPortalLoginGuard();
    currentPortalUser = verifiedUser;
    currentPortalSession = { ...session, user: verifiedUser };
    return currentPortalSession;
  })();

  return portalSessionPromise;
}
