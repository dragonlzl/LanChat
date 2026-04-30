const DEFAULT_PORTAL_NOTIFICATION_SEND_URL = 'http://192.168.50.10:8756/api/notifications/send';

export type PortalNotificationPayload = Record<string, unknown>;

export type PortalNotificationInput = {
  recipientUserId: string;
  templateId: string;
  templateVersionName: string;
  payload: PortalNotificationPayload;
  templateVariable?: PortalNotificationPayload;
};

export type PortalNotificationResponse = {
  success?: boolean;
  code?: string;
  message?: string;
  data?: unknown;
};

export type PortalNotificationClientOptions = {
  sendUrl?: string;
  serviceId?: string;
  serviceToken?: string;
  fetchImpl?: typeof fetch;
};

type PortalNotificationRequestBody = {
  recipient_user_id: string;
  template_id: string;
  template_version_name: string;
  payload: PortalNotificationPayload;
  template_variable: PortalNotificationPayload;
};

export class PortalNotificationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function normalizeRequiredString(value: string | undefined, fieldName: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    throw new PortalNotificationError(400, 'NOTIFICATION_REQUEST_INVALID', `${fieldName} is required.`);
  }

  return normalized;
}

function isPlainObject(value: unknown): value is PortalNotificationPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeObject(value: unknown, fieldName: string): PortalNotificationPayload {
  if (!isPlainObject(value)) {
    throw new PortalNotificationError(400, 'NOTIFICATION_REQUEST_INVALID', `${fieldName} must be a JSON object.`);
  }

  return value;
}

export function sanitizePortalNotificationMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^"'`\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(Authorization|Cookie)\s*[:=]\s*[^"'`\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(token|jwt)\s*[:=]\s*[^"'`\s,;]+/gi, '$1=[REDACTED]');
}

function normalizePortalErrorMessage(status: number, code: string, message: string): string {
  const upstreamMessage = sanitizePortalNotificationMessage(message.trim());

  if (code === 'NOTIFICATION_AUTH_REQUIRED') {
    return upstreamMessage || 'Portal notification authentication is required.';
  }
  if (code === 'NOTIFICATION_SERVICE_TOKEN_INVALID') {
    const advice = 'Check service env and portal notification-service-tokens config.';
    return upstreamMessage ? `${upstreamMessage} ${advice}` : `Portal notification service credentials are invalid. ${advice}`;
  }
  if (code === 'NOTIFICATION_JWT_INVALID') {
    const advice = 'User-triggered notifications need a fresh login session.';
    return upstreamMessage ? `${upstreamMessage} ${advice}` : `Portal JWT is invalid or expired. ${advice}`;
  }
  if (code === 'NOTIFICATION_REQUEST_INVALID') {
    return upstreamMessage || 'Portal notification request is invalid.';
  }
  if (status === 502) {
    return upstreamMessage || 'Portal notification upstream is unavailable.';
  }

  return upstreamMessage || 'Portal notification send failed.';
}

function readResponsePayload(rawText: string): PortalNotificationResponse {
  if (!rawText) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    return isPlainObject(parsed) ? parsed as PortalNotificationResponse : {};
  } catch {
    return {};
  }
}

export function buildPortalNotificationRequestBody(input: PortalNotificationInput): PortalNotificationRequestBody {
  return {
    recipient_user_id: normalizeRequiredString(input.recipientUserId, 'recipient_user_id'),
    template_id: normalizeRequiredString(input.templateId, 'template_id'),
    template_version_name: normalizeRequiredString(input.templateVersionName, 'template_version_name'),
    payload: normalizeObject(input.payload, 'payload'),
    template_variable: input.templateVariable === undefined
      ? {}
      : normalizeObject(input.templateVariable, 'template_variable'),
  };
}

export class PortalNotificationClient {
  private readonly sendUrl: string;

  private readonly serviceId: string;

  private readonly serviceToken: string;

  private readonly fetchImpl: typeof fetch;

  constructor(options: PortalNotificationClientOptions = {}) {
    this.sendUrl = options.sendUrl?.trim() || DEFAULT_PORTAL_NOTIFICATION_SEND_URL;
    this.serviceId = options.serviceId?.trim() ?? '';
    this.serviceToken = options.serviceToken?.trim() ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  hasServiceCredentials(): boolean {
    return Boolean(this.serviceId && this.serviceToken);
  }

  async sendFromService(input: PortalNotificationInput): Promise<unknown> {
    if (!this.serviceId || !this.serviceToken) {
      throw new PortalNotificationError(401, 'NOTIFICATION_AUTH_REQUIRED', 'Portal notification service credentials are missing.');
    }

    return this.send(input, {
      'Content-Type': 'application/json',
      'X-Portal-Service-Id': this.serviceId,
      Authorization: `Bearer ${this.serviceToken}`,
    });
  }

  async sendWithPortalJwt(input: PortalNotificationInput, portalJwt: string): Promise<unknown> {
    const normalizedJwt = portalJwt.trim();
    if (!normalizedJwt) {
      throw new PortalNotificationError(401, 'NOTIFICATION_AUTH_REQUIRED', 'Portal JWT is required.');
    }

    return this.send(input, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${normalizedJwt}`,
    });
  }

  async sendWithCookie(input: PortalNotificationInput, cookie: string): Promise<unknown> {
    const normalizedCookie = cookie.trim();
    if (!normalizedCookie) {
      throw new PortalNotificationError(401, 'NOTIFICATION_AUTH_REQUIRED', 'Portal Cookie is required.');
    }

    return this.send(input, {
      'Content-Type': 'application/json',
      Cookie: normalizedCookie,
    });
  }

  private async send(input: PortalNotificationInput, headers: Record<string, string>): Promise<unknown> {
    const body = buildPortalNotificationRequestBody(input);
    const response = await this.fetchImpl(this.sendUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const rawText = await response.text();
    const result = readResponsePayload(rawText);

    if (!response.ok || result.success === false) {
      const code = typeof result.code === 'string' && result.code.trim()
        ? result.code.trim()
        : `HTTP_${response.status}`;
      const message = normalizePortalErrorMessage(
        response.status,
        code,
        typeof result.message === 'string' ? result.message : '',
      );
      throw new PortalNotificationError(response.status, code, `${code}: ${message}`);
    }

    return result.data;
  }
}
