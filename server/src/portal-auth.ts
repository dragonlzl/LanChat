import type { PortalUser } from './types.js';

const DEFAULT_PORTAL_JWT_VERIFY_URL = 'http://192.168.50.10:8756/api/sso/jwt/verify';

export class PortalAuthError extends Error {
  constructor(message: string, public readonly status = 401) {
    super(message);
  }
}

export interface PortalJwtVerifyResult {
  user: PortalUser;
  claims: Record<string, unknown>;
  expiresAt: number | null;
  audience: string | null;
  isTestUser: boolean;
  isSoulknightProject: boolean;
}

type VerifyResponsePayload = {
  success?: boolean;
  code?: string;
  message?: string;
  data?: {
    user?: unknown;
    claims?: unknown;
    expires_at?: unknown;
    audience?: unknown;
  };
};

type FetchImpl = typeof fetch;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getPortalUserKey(user: PortalUser): string {
  return readString(user.user_id) || readString(user.open_id) || readString(user.union_id);
}

export function getPortalDisplayName(user: PortalUser): string {
  return readString(user.name) || getPortalUserKey(user) || '已登录用户';
}

export function isSoulknightProjectUser(user: PortalUser): boolean {
  return Array.isArray(user.job_functions) && user.job_functions.includes('soulknight');
}

export function isPortalTestUser(user: PortalUser): boolean {
  const jobFunctions = Array.isArray(user.job_functions) ? user.job_functions : [];
  const title = String(user.job_title || '').toLowerCase();
  return (
    jobFunctions.includes('qa')
    || title.includes('测试')
    || title.includes('qa')
    || title.includes('quality')
    || title.includes('test')
  );
}

function normalizePortalUser(value: unknown): PortalUser {
  if (typeof value !== 'object' || value === null) {
    throw new PortalAuthError('JWT 校验响应缺少用户信息', 502);
  }

  return value as PortalUser;
}

function normalizeClaims(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function normalizeExpiresAt(value: unknown, claims: Record<string, unknown>): number | null {
  const raw = typeof value === 'number' ? value : typeof claims.exp === 'number' ? claims.exp : null;
  return raw && Number.isFinite(raw) ? raw : null;
}

export class PortalJwtVerifier {
  constructor(
    private readonly verifyUrl = process.env.PORTAL_JWT_VERIFY_URL?.trim() || DEFAULT_PORTAL_JWT_VERIFY_URL,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  async verify(token: string, audience: string): Promise<PortalJwtVerifyResult> {
    const normalizedToken = token.trim();
    const normalizedAudience = audience.trim();
    if (!normalizedToken) {
      throw new PortalAuthError('缺少 JWT');
    }
    if (!normalizedAudience) {
      throw new PortalAuthError('缺少 JWT audience', 400);
    }

    const response = await this.fetchImpl(this.verifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: normalizedToken,
        audience: normalizedAudience,
      }),
    });

    let payload: VerifyResponsePayload | null = null;
    try {
      payload = await response.json() as VerifyResponsePayload;
    } catch {
      payload = null;
    }

    if (!response.ok || !payload?.success || !payload.data) {
      throw new PortalAuthError(payload?.message || `JWT 校验失败 (${response.status})`, response.status || 401);
    }

    const user = normalizePortalUser(payload.data.user);
    const claims = normalizeClaims(payload.data.claims);
    const expiresAt = normalizeExpiresAt(payload.data.expires_at, claims);
    return {
      user,
      claims,
      expiresAt,
      audience: typeof payload.data.audience === 'string' ? payload.data.audience : normalizedAudience,
      isTestUser: isPortalTestUser(user),
      isSoulknightProject: isSoulknightProjectUser(user),
    };
  }
}
