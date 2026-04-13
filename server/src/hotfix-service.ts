import type { HotfixVersionBlock } from './hotfix-content.js';
import { buildRecentHotfixResult, parseHotfixVersionBlocks } from './hotfix-content.js';
import { shouldRefreshHotfixToken, type HotfixDocumentClient } from './hotfix-document.js';
import type { ServiceAuthClient, ServiceAuthToken } from './service-auth.js';
import { SettingsStore } from './settings-store.js';
import type { HotfixAuthRecord, HotfixDocumentResult, HotfixSettings } from './types.js';

export type HotfixDocumentSnapshot = {
  documentId: string;
  rawContent: string;
  versionBlocks: HotfixVersionBlock[];
  fetchedAt: string;
  refreshedToken: boolean;
};

export class HotfixService {
  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly serviceAuthClient: ServiceAuthClient,
    private readonly hotfixDocumentClient: HotfixDocumentClient,
  ) {}

  getSettings(): HotfixSettings {
    return this.settingsStore.getHotfixSettings();
  }

  saveSettings(input: { documentId: string; clientId: string; clientSecret: string }): HotfixSettings {
    return this.settingsStore.saveHotfixSettings(input, new Date().toISOString());
  }

  async refreshAuth(): Promise<HotfixSettings> {
    const settings = this.settingsStore.getHotfixSettings();
    const clientId = settings.clientId.trim();
    const clientSecret = settings.clientSecret.trim();
    if (!clientId || !clientSecret) {
      throw new Error('请先在管理员热更设置页配置鉴权 client_id 和 client_secret');
    }

    const issuedAt = new Date().toISOString();
    const token = await this.serviceAuthClient.issueToken({ clientId, clientSecret });
    const record = buildHotfixAuthRecord(token, issuedAt);
    return this.settingsStore.saveHotfixAuthRecord(record, issuedAt);
  }

  async fetchDocumentContent(): Promise<HotfixDocumentResult> {
    const snapshot = await this.fetchDocumentSnapshot();
    const recent = buildRecentHotfixResult(snapshot.rawContent, 5);
    return {
      documentId: snapshot.documentId,
      content: recent.content,
      versionBlocks: recent.versionBlocks,
      fetchedAt: snapshot.fetchedAt,
      refreshedToken: snapshot.refreshedToken,
    };
  }

  async fetchDocumentSnapshot(): Promise<HotfixDocumentSnapshot> {
    const settings = this.settingsStore.getHotfixSettings();
    const documentId = settings.documentId.trim();

    if (!documentId) {
      throw new Error('请先在管理员热更设置页配置飞书文档 ID');
    }

    if (settings.auth) {
      try {
        return await this.fetchWithAuth(documentId, settings.auth, false);
      } catch (error) {
        if (!shouldRefreshHotfixToken(error)) {
          throw error;
        }
      }
    }

    const refreshedSettings = await this.refreshAuth();
    if (!refreshedSettings.auth) {
      throw new Error('服务鉴权成功，但服务器未保存到可用 token');
    }

    return this.fetchWithAuth(documentId, refreshedSettings.auth, Boolean(settings.auth));
  }

  private async fetchWithAuth(documentId: string, auth: HotfixAuthRecord, refreshedToken: boolean): Promise<HotfixDocumentSnapshot> {
    const document = await this.hotfixDocumentClient.readRawContent(documentId, auth.accessToken, auth.tokenType);
    return {
      documentId: document.documentId,
      rawContent: document.content,
      versionBlocks: parseHotfixVersionBlocks(document.content),
      fetchedAt: new Date().toISOString(),
      refreshedToken,
    };
  }
}

function buildHotfixAuthRecord(token: ServiceAuthToken, issuedAt: string): HotfixAuthRecord {
  return {
    clientId: token.clientId,
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    expiresIn: token.expiresIn,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + (token.expiresIn * 1000)).toISOString(),
    updatedAt: issuedAt,
    code: token.code,
    message: token.message,
    traceId: token.traceId,
  };
}
