import type Database from 'better-sqlite3';
import type { FeishuBotMember, FeishuBotPublicConfig, FeishuBotSettings } from './types.js';

const FEISHU_BOT_SETTINGS_KEY = 'feishu_bot_settings_v1';

type AppSettingRow = {
  key: string;
  value: string;
  updated_at: string;
};

type StoredFeishuBotSettings = {
  webhookUrl: string;
  members: FeishuBotMember[];
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

export class SettingsStore {
  constructor(private readonly database: Database.Database) {}

  getFeishuBotSettings(): FeishuBotSettings {
    const row = this.database
      .prepare<[string], AppSettingRow>('SELECT key, value, updated_at FROM app_settings WHERE key = ?')
      .get(FEISHU_BOT_SETTINGS_KEY);

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

    this.database
      .prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(FEISHU_BOT_SETTINGS_KEY, JSON.stringify(payload), updatedAt);

    return {
      webhookUrl,
      members,
      updatedAt,
      enabled: webhookUrl.length > 0 && members.length > 0,
    };
  }
}
