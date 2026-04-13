type RawFeishuLegacyDocumentPayload = {
  code?: unknown;
  message?: unknown;
  data?: {
    document_id?: unknown;
    content?: unknown;
  } | null;
  trace_id?: unknown;
};

export type FeishuLegacyDocumentResult = {
  documentId: string;
  content: string;
};

export type FeishuDocumentClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_HOTFIX_DOCUMENT_BASE_URL = 'http://192.168.50.5:8005';
const RETRYABLE_TOKEN_ERROR_CODES = new Set([
  'SERVICE_TOKEN_EXPIRED',
  'SERVICE_TOKEN_INVALID',
]);

function getConfiguredValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function parseLegacyDocumentPayload(rawText: string): RawFeishuLegacyDocumentPayload | null {
  if (!rawText) {
    return null;
  }

  try {
    const payload = JSON.parse(rawText) as unknown;
    return typeof payload === 'object' && payload !== null ? payload as RawFeishuLegacyDocumentPayload : null;
  } catch {
    return null;
  }
}

function extractErrorMessage(status: number, payload: RawFeishuLegacyDocumentPayload | null, rawText: string): string {
  if (payload && typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  const normalizedText = rawText.trim();
  if (normalizedText) {
    return normalizedText;
  }

  return `请求失败 (${status})`;
}

export class FeishuDocumentError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly traceId: string | null,
  ) {
    super(message);
  }
}

export class HotfixDocumentClient {
  private readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;

  constructor(options: FeishuDocumentClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async readRawContent(documentId: string, accessToken: string, tokenType: string, overrideBaseUrl?: string): Promise<FeishuLegacyDocumentResult> {
    const baseUrl = trimTrailingSlash(overrideBaseUrl?.trim() || this.baseUrl);
    const response = await this.fetchImpl(
      `${baseUrl}/api/v1/feishu/legacy-documents/${encodeURIComponent(documentId)}/raw-content?lang=0`,
      {
        method: 'GET',
        headers: {
          Authorization: `${tokenType} ${accessToken}`,
        },
      },
    );

    const rawText = await response.text();
    const payload = parseLegacyDocumentPayload(rawText);

    if (!response.ok) {
      throw new FeishuDocumentError(
        extractErrorMessage(response.status, payload, rawText),
        response.status,
        typeof payload?.code === 'string' ? payload.code : null,
        typeof payload?.trace_id === 'string' ? payload.trace_id : null,
      );
    }

    const data = payload?.data;
    if (!data || typeof data.document_id !== 'string' || typeof data.content !== 'string') {
      throw new Error('飞书文档纯文本响应格式无效');
    }

    return {
      documentId: data.document_id,
      content: data.content,
    };
  }
}

export function shouldRefreshHotfixToken(error: unknown): boolean {
  if (!(error instanceof FeishuDocumentError)) {
    return false;
  }

  if (error.code && RETRYABLE_TOKEN_ERROR_CODES.has(error.code)) {
    return true;
  }

  return error.status === 401;
}

export function createHotfixDocumentClient(fetchImpl: typeof fetch = fetch): HotfixDocumentClient {
  return new HotfixDocumentClient({
    baseUrl: getConfiguredValue(process.env.WEBCHAT_HOTFIX_FEISHU_BASE_URL, process.env.WEBCHAT_HOTFIX_AUTH_BASE_URL || DEFAULT_HOTFIX_DOCUMENT_BASE_URL),
    fetchImpl,
  });
}
