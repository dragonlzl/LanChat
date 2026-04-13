import type Database from 'better-sqlite3';
import type {
  FeishuBotMember,
  FeishuBotPublicConfig,
  FeishuBotSettings,
  HotfixAuthRecord,
  HotfixSettings,
} from './types.js';

const FEISHU_BOT_SETTINGS_KEY = 'feishu_bot_settings_v1';
const HOTFIX_SETTINGS_KEY = 'hotfix_settings_v1';

type AppSettingRow = {
  key: string;
  value: string;
  updated_at: string;
};

type StoredFeishuBotSettings = {
  webhookUrl: string;
  members: FeishuBotMember[];
};

type StoredHotfixSettings = {
  baseUrl: string;
  documentId: string;
  clientId: string;
  clientSecret: string;
  auth: HotfixAuthRecord | null;
};

function normalizeFeishuBotMembers(members: FeishuBotMember[]): FeishuBotMember[] {
  const result: FeishuBotMember[] = [];
  const seenMemberIds = new Set<string>();

  for (const member of members) {
    const memberId = member.memberId.trim();
    const memberIdType = member.memberIdType.trim() || 'user_id';
    const name = member.name.trim();
    const tenantKey = member.tenantKey.trim();

    if (!memberId || !name || seenMemberIds.has(memberId)) {
      continue;
    }

    seenMemberIds.add(memberId);
    result.push({
      memberId,
      memberIdType,
      name,
      tenantKey,
    });
  }

  return result;
}

function normalizeHotfixBaseUrl(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return '';
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.endsWith('/') ? withProtocol.slice(0, -1) : withProtocol;
}

export class SettingsStore {
  constructor(private readonly database: Database.Database) {}

  private getSettingRow(key: string): AppSettingRow | undefined {
    return this.database
      .prepare<[string], AppSettingRow>('SELECT key, value, updated_at FROM app_settings WHERE key = ?')
      .get(key);
  }

  private upsertSetting(key: string, value: string, updatedAt: string) {
    this.database
      .prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(key, value, updatedAt);
  }

  getFeishuBotSettings(): FeishuBotSettings {
    const row = this.getSettingRow(FEISHU_BOT_SETTINGS_KEY);

    if (!row) {
      return {
        webhookUrl: '',
        members: [],
        updatedAt: null,
        enabled: false,
      };
    }

    try {
      const payload = JSON.parse(row.value) as Partial<StoredFeishuBotSettings>;
      const webhookUrl = typeof payload.webhookUrl === 'string' ? payload.webhookUrl.trim() : '';
      const members = Array.isArray(payload.members)
        ? normalizeFeishuBotMembers(
            payload.members.filter((member): member is FeishuBotMember => typeof member === 'object' && member !== null)
              .map((member) => ({
                memberId: typeof member.memberId === 'string' ? member.memberId : '',
                memberIdType: typeof member.memberIdType === 'string' ? member.memberIdType : 'user_id',
                name: typeof member.name === 'string' ? member.name : '',
                tenantKey: typeof member.tenantKey === 'string' ? member.tenantKey : '',
              })),
          )
        : [];

      return {
        webhookUrl,
        members,
        updatedAt: row.updated_at,
        enabled: webhookUrl.length > 0 && members.length > 0,
      };
    } catch {
      return {
        webhookUrl: '',
        members: [],
        updatedAt: row.updated_at,
        enabled: false,
      };
    }
  }

  getFeishuBotPublicConfig(): FeishuBotPublicConfig {
    const settings = this.getFeishuBotSettings();
    return {
      enabled: settings.enabled,
      members: settings.members,
    };
  }

  saveFeishuBotSettings(
    input: { webhookUrl: string; members: FeishuBotMember[] },
    updatedAt: string,
  ): FeishuBotSettings {
    const webhookUrl = input.webhookUrl.trim();
    const members = normalizeFeishuBotMembers(input.members);
    const payload: StoredFeishuBotSettings = {
      webhookUrl,
      members,
    };

    this.upsertSetting(FEISHU_BOT_SETTINGS_KEY, JSON.stringify(payload), updatedAt);

    return {
      webhookUrl,
      members,
      updatedAt,
      enabled: webhookUrl.length > 0 && members.length > 0,
    };
  }

  getHotfixSettings(): HotfixSettings {
    const row = this.getSettingRow(HOTFIX_SETTINGS_KEY);

    if (!row) {
      return {
        baseUrl: '',
        documentId: '',
        clientId: '',
        clientSecret: '',
        updatedAt: null,
        auth: null,
      };
    }

    try {
      const payload = JSON.parse(row.value) as Partial<StoredHotfixSettings>;
      const baseUrl = normalizeHotfixBaseUrl(typeof payload.baseUrl === 'string' ? payload.baseUrl : '');
      const documentId = typeof payload.documentId === 'string'
        ? payload.documentId.trim()
        : typeof (payload as { docToken?: unknown }).docToken === 'string'
          ? String((payload as { docToken?: unknown }).docToken).trim()
          : '';
      const clientId = typeof payload.clientId === 'string'
        ? payload.clientId.trim()
        : '';
      const clientSecret = typeof payload.clientSecret === 'string'
        ? payload.clientSecret.trim()
        : '';
      const auth = normalizeHotfixAuthRecord(payload.auth);

      return {
        baseUrl,
        documentId,
        clientId,
        clientSecret,
        updatedAt: row.updated_at,
        auth,
      };
    } catch {
      return {
        baseUrl: '',
        documentId: '',
        clientId: '',
        clientSecret: '',
        updatedAt: row.updated_at,
        auth: null,
      };
    }
  }

  saveHotfixSettings(input: { baseUrl: string; documentId: string; clientId: string; clientSecret: string }, updatedAt: string): HotfixSettings {
    const current = this.getHotfixSettings();
    const nextBaseUrl = normalizeHotfixBaseUrl(input.baseUrl);
    const nextClientId = input.clientId.trim();
    const nextClientSecret = input.clientSecret.trim();
    const credentialsChanged =
      current.baseUrl !== nextBaseUrl
      || current.clientId !== nextClientId
      || current.clientSecret !== nextClientSecret;
    const payload: StoredHotfixSettings = {
      baseUrl: nextBaseUrl,
      documentId: input.documentId.trim(),
      clientId: nextClientId,
      clientSecret: nextClientSecret,
      auth: credentialsChanged ? null : current.auth,
    };

    this.upsertSetting(HOTFIX_SETTINGS_KEY, JSON.stringify(payload), updatedAt);

    return {
      baseUrl: payload.baseUrl,
      documentId: payload.documentId,
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      updatedAt,
      auth: payload.auth,
    };
  }

  saveHotfixAuthRecord(input: HotfixAuthRecord, updatedAt: string): HotfixSettings {
    const current = this.getHotfixSettings();
    const payload: StoredHotfixSettings = {
      baseUrl: current.baseUrl,
      documentId: current.documentId,
      clientId: current.clientId,
      clientSecret: current.clientSecret,
      auth: normalizeHotfixAuthRecord(input),
    };

    this.upsertSetting(HOTFIX_SETTINGS_KEY, JSON.stringify(payload), updatedAt);

    return {
      baseUrl: payload.baseUrl,
      documentId: payload.documentId,
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      updatedAt,
      auth: payload.auth,
    };
  }
}

function normalizeHotfixAuthRecord(input: unknown): HotfixAuthRecord | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const record = input as Partial<HotfixAuthRecord>;
  const clientId = typeof record.clientId === 'string' ? record.clientId.trim() : '';
  const accessToken = typeof record.accessToken === 'string' ? record.accessToken.trim() : '';
  const tokenType = typeof record.tokenType === 'string' ? record.tokenType.trim() : '';
  const expiresIn = typeof record.expiresIn === 'number' && Number.isFinite(record.expiresIn) ? record.expiresIn : 0;
  const issuedAt = typeof record.issuedAt === 'string' ? record.issuedAt : '';
  const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : '';
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  const traceId = typeof record.traceId === 'string' ? record.traceId : null;

  if (!clientId || !accessToken || !tokenType || expiresIn <= 0 || !issuedAt || !expiresAt || !updatedAt) {
    return null;
  }

  return {
    clientId,
    accessToken,
    tokenType,
    expiresIn,
    issuedAt,
    expiresAt,
    updatedAt,
    code,
    message,
    traceId,
  };
}
