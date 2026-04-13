export type ServiceAuthToken = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  clientId: string;
  code: string;
  message: string;
  traceId: string | null;
};

type RawServiceAuthPayload = {
  success?: unknown;
  code?: unknown;
  message?: unknown;
  data?: {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    client_id?: unknown;
  } | null;
  trace_id?: unknown;
};

export type ServiceAuthClientOptions = {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_SERVICE_AUTH_BASE_URL = 'http://192.168.50.5:8005';
const DEFAULT_SERVICE_AUTH_CLIENT_ID = 'report-service';
const DEFAULT_SERVICE_AUTH_CLIENT_SECRET = 'replace-with-strong-secret';

function getConfiguredValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function parseResponsePayload(rawText: string): RawServiceAuthPayload | null {
  if (!rawText) {
    return null;
  }

  try {
    const payload = JSON.parse(rawText) as unknown;
    return typeof payload === 'object' && payload !== null ? payload as RawServiceAuthPayload : null;
  } catch {
    return null;
  }
}

function extractUpstreamErrorMessage(status: number, payload: RawServiceAuthPayload | null, rawText: string): string {
  if (payload && typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  const normalizedText = rawText.trim();
  if (normalizedText) {
    return normalizedText;
  }

  return `请求失败 (${status})`;
}

export class ServiceAuthClient {
  private readonly baseUrl: string;

  private readonly clientId: string;

  private readonly clientSecret: string;

  private readonly fetchImpl: typeof fetch;

  constructor(options: ServiceAuthClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.clientId = options.clientId?.trim() ?? '';
    this.clientSecret = options.clientSecret?.trim() ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async issueToken(input?: { baseUrl?: string; clientId: string; clientSecret: string }): Promise<ServiceAuthToken> {
    const baseUrl = trimTrailingSlash(input?.baseUrl?.trim() || this.baseUrl);
    const clientId = input?.clientId.trim() || this.clientId;
    const clientSecret = input?.clientSecret.trim() || this.clientSecret;
    if (!clientId || !clientSecret) {
      throw new Error('服务鉴权缺少 client_id 或 client_secret');
    }

    const response = await this.fetchImpl(`${baseUrl}/api/v1/auth/service/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const rawText = await response.text();
    const payload = parseResponsePayload(rawText);

    if (!response.ok) {
      throw new Error(extractUpstreamErrorMessage(response.status, payload, rawText));
    }

    const data = payload?.data;
    if (
      !data
      || typeof data.access_token !== 'string'
      || typeof data.token_type !== 'string'
      || typeof data.client_id !== 'string'
      || typeof data.expires_in !== 'number'
      || !Number.isFinite(data.expires_in)
    ) {
      throw new Error('服务鉴权响应格式无效');
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      clientId: data.client_id,
      code: typeof payload?.code === 'string' ? payload.code : '',
      message: typeof payload?.message === 'string' && payload.message.trim() ? payload.message.trim() : 'Service token issued.',
      traceId: typeof payload?.trace_id === 'string' ? payload.trace_id : null,
    };
  }
}

export function createServiceAuthClient(fetchImpl: typeof fetch = fetch): ServiceAuthClient {
  return new ServiceAuthClient({
    baseUrl: getConfiguredValue(process.env.WEBCHAT_HOTFIX_AUTH_BASE_URL, DEFAULT_SERVICE_AUTH_BASE_URL),
    clientId: getConfiguredValue(process.env.WEBCHAT_HOTFIX_AUTH_CLIENT_ID, DEFAULT_SERVICE_AUTH_CLIENT_ID),
    clientSecret: getConfiguredValue(process.env.WEBCHAT_HOTFIX_AUTH_CLIENT_SECRET, DEFAULT_SERVICE_AUTH_CLIENT_SECRET),
    fetchImpl,
  });
}
