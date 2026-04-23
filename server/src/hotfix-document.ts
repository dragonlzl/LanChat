import { isHotfixVersionLine, parseHotfixVersionBlocks } from './hotfix-content.js';

type RawFeishuDocumentChildrenPayload = {
  code?: unknown;
  message?: unknown;
  data?: {
    document_id?: unknown;
    block_id?: unknown;
    items?: unknown;
    blocks?: unknown;
    has_more?: unknown;
    page_token?: unknown;
    with_descendants?: unknown;
  } | null;
  trace_id?: unknown;
};

type RawFeishuLegacyDocumentRawContentPayload = {
  success?: unknown;
  code?: unknown;
  message?: unknown;
  data?: {
    document_id?: unknown;
    content?: unknown;
  } | null;
  trace_id?: unknown;
};

type RawFeishuUsersPayload = {
  success?: unknown;
  code?: unknown;
  message?: unknown;
  data?: unknown;
  trace_id?: unknown;
};

export type FeishuDocumentContentResult = {
  documentId: string;
  content: string;
};

type FeishuDocumentBlock = {
  blockId: string;
  parentId: string | null;
  blockType: number;
  children: string[];
  raw: Record<string, unknown>;
};

type FeishuDocumentChildrenPage = {
  documentId: string | null;
  items: FeishuDocumentBlock[];
  hasMore: boolean;
  pageToken: string | null;
};

type FeishuDocumentAssigneeHints = Map<string, string[]>;
type FeishuUserDirectory = Map<string, string>;

type FeishuDocumentAssigneeResolution = {
  userDirectory?: FeishuUserDirectory;
  assigneeHints?: FeishuDocumentAssigneeHints;
};

type FeishuDocumentBlockListResult = {
  documentId: string;
  items: FeishuDocumentBlock[];
};

export type FeishuDocumentClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_HOTFIX_DOCUMENT_BASE_URL = 'http://192.168.50.5:8005';
const FEISHU_DOCUMENT_PAGE_SIZE = 500;
const RETRYABLE_TOKEN_ERROR_CODES = new Set([
  'SERVICE_TOKEN_EXPIRED',
  'SERVICE_TOKEN_INVALID',
]);
const BLOCK_TYPE_TEXT_KEYS = new Map<number, string[]>([
  [1, ['page']],
  [2, ['text']],
  [3, ['heading1']],
  [4, ['heading2']],
  [5, ['heading3']],
  [6, ['heading4']],
  [7, ['heading5']],
  [8, ['heading6']],
  [9, ['heading7']],
  [10, ['heading8']],
  [11, ['heading9']],
  [12, ['bullet']],
  [13, ['ordered']],
  [14, ['code']],
  [15, ['quote']],
  [17, ['todo']],
  [19, ['callout']],
]);

function getConfiguredValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function parseChildrenPayload(rawText: string): RawFeishuDocumentChildrenPayload | null {
  if (!rawText) {
    return null;
  }

  try {
    const payload = JSON.parse(rawText) as unknown;
    return typeof payload === 'object' && payload !== null ? payload as RawFeishuDocumentChildrenPayload : null;
  } catch {
    return null;
  }
}

function parseLegacyRawContentPayload(rawText: string): RawFeishuLegacyDocumentRawContentPayload | null {
  if (!rawText) {
    return null;
  }

  try {
    const payload = JSON.parse(rawText) as unknown;
    return typeof payload === 'object' && payload !== null ? payload as RawFeishuLegacyDocumentRawContentPayload : null;
  } catch {
    return null;
  }
}

function parseUsersPayload(rawText: string): RawFeishuUsersPayload | null {
  if (!rawText) {
    return null;
  }

  try {
    const payload = JSON.parse(rawText) as unknown;
    return typeof payload === 'object' && payload !== null ? payload as RawFeishuUsersPayload : null;
  } catch {
    return null;
  }
}

function extractErrorMessage(status: number, payload: RawFeishuDocumentChildrenPayload | null, rawText: string): string {
  if (payload && typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  const normalizedText = rawText.trim();
  if (normalizedText) {
    return normalizedText;
  }

  return `请求失败 (${status})`;
}

function normalizeBlockItems(rawItems: unknown): FeishuDocumentBlock[] | null {
  const values = Array.isArray(rawItems)
    ? rawItems
    : (typeof rawItems === 'object' && rawItems !== null ? Object.values(rawItems as Record<string, unknown>) : null);
  if (!values) {
    return null;
  }

  const items: FeishuDocumentBlock[] = [];
  for (const value of values) {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const raw = value as Record<string, unknown>;
    const blockId = typeof raw.block_id === 'string'
      ? raw.block_id.trim()
      : (typeof raw.blockId === 'string' ? raw.blockId.trim() : '');
    const parentId = typeof raw.parent_id === 'string'
      ? raw.parent_id.trim()
      : (typeof raw.parentId === 'string' ? raw.parentId.trim() : '');
    const rawBlockType = raw.block_type ?? raw.blockType;
    const blockType = typeof rawBlockType === 'number'
      ? rawBlockType
      : (typeof rawBlockType === 'string' && rawBlockType.trim() ? Number.parseInt(rawBlockType, 10) : Number.NaN);
    const rawChildren = Array.isArray(raw.children)
      ? raw.children
      : (Array.isArray(raw.child_ids) ? raw.child_ids : []);

    if (!blockId || !Number.isFinite(blockType)) {
      return null;
    }

    items.push({
      blockId,
      parentId: parentId || null,
      blockType,
      children: rawChildren
        .filter((child): child is string => typeof child === 'string')
        .map((child) => child.trim())
        .filter((child) => child.length > 0),
      raw,
    });
  }

  return items;
}

function hasMentionUserWithoutName(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => hasMentionUserWithoutName(item));
  }

  if (typeof node !== 'object' || node === null) {
    return false;
  }

  const record = node as Record<string, unknown>;
  const mentionUser = record.mention_user;
  if (typeof mentionUser === 'object' && mentionUser !== null) {
    const name = (mentionUser as Record<string, unknown>).user_name ?? (mentionUser as Record<string, unknown>).name;
    if (typeof name !== 'string' || !name.trim()) {
      return true;
    }
  }

  return Object.values(record).some((value) => hasMentionUserWithoutName(value));
}

function extractMentionUserIds(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item) => extractMentionUserIds(item));
  }

  if (typeof node !== 'object' || node === null) {
    return [];
  }

  const record = node as Record<string, unknown>;
  const ids: string[] = [];
  const mentionUser = record.mention_user;
  if (typeof mentionUser === 'object' && mentionUser !== null) {
    const userId = (mentionUser as Record<string, unknown>).user_id;
    if (typeof userId === 'string' && userId.trim()) {
      ids.push(userId.trim());
    }
  }

  return ids.concat(Object.values(record).flatMap((value) => extractMentionUserIds(value)));
}

function collectMentionUserIds(items: FeishuDocumentBlock[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    for (const userId of extractMentionUserIds(item.raw)) {
      if (seen.has(userId)) {
        continue;
      }

      seen.add(userId);
      result.push(userId);
    }
  }

  return result;
}

function extractElementText(element: unknown): string {
  if (typeof element !== 'object' || element === null) {
    return '';
  }

  const record = element as Record<string, unknown>;
  const textRun = record.text_run;
  if (typeof textRun === 'object' && textRun !== null && typeof (textRun as Record<string, unknown>).content === 'string') {
    return ((textRun as Record<string, unknown>).content as string).trimEnd();
  }

  const mentionUser = record.mention_user;
  if (typeof mentionUser === 'object' && mentionUser !== null) {
    const name = (mentionUser as Record<string, unknown>).user_name ?? (mentionUser as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) {
      return `@${name.trim()}`;
    }
  }

  const mentionDoc = record.mention_doc;
  if (typeof mentionDoc === 'object' && mentionDoc !== null) {
    const title = (mentionDoc as Record<string, unknown>).title;
    if (typeof title === 'string' && title.trim()) {
      return title.trim();
    }
  }

  const reminder = record.reminder;
  if (typeof reminder === 'object' && reminder !== null) {
    const title = (reminder as Record<string, unknown>).title ?? (reminder as Record<string, unknown>).text;
    if (typeof title === 'string' && title.trim()) {
      return title.trim();
    }
  }

  const equation = record.equation;
  if (typeof equation === 'object' && equation !== null) {
    const content = (equation as Record<string, unknown>).content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }
  }

  const inlineFile = record.inline_file;
  if (typeof inlineFile === 'object' && inlineFile !== null) {
    const fileName = (inlineFile as Record<string, unknown>).file_name;
    if (typeof fileName === 'string' && fileName.trim()) {
      return fileName.trim();
    }
  }

  return '';
}

function extractTextFromNode(node: unknown): string {
  if (typeof node === 'string') {
    return node.trimEnd();
  }

  if (Array.isArray(node)) {
    return node.map((item) => extractTextFromNode(item)).join('');
  }

  if (typeof node !== 'object' || node === null) {
    return '';
  }

  const record = node as Record<string, unknown>;
  const elements = record.elements;
  if (Array.isArray(elements)) {
    return elements.map((element) => extractElementText(element)).join('');
  }

  const textElements = record.text_elements;
  if (Array.isArray(textElements)) {
    return textElements.map((element) => extractElementText(element)).join('');
  }

  const content = record.content;
  if (typeof content === 'string') {
    return content.trimEnd();
  }

  const text = record.text;
  if (typeof text === 'string') {
    return text.trimEnd();
  }

  const title = record.title;
  if (typeof title === 'string') {
    return title.trimEnd();
  }

  return '';
}

function extractBlockText(block: FeishuDocumentBlock): string {
  const preferredKeys = BLOCK_TYPE_TEXT_KEYS.get(block.blockType) ?? [];
  for (const key of preferredKeys) {
    const text = extractTextFromNode(block.raw[key]);
    if (text.trim()) {
      return text;
    }
  }

  for (const [key, value] of Object.entries(block.raw)) {
    if (
      key === 'block_id'
      || key === 'blockId'
      || key === 'parent_id'
      || key === 'parentId'
      || key === 'block_type'
      || key === 'blockType'
      || key === 'children'
      || key === 'child_ids'
    ) {
      continue;
    }

    const text = extractTextFromNode(value);
    if (text.trim()) {
      return text;
    }
  }

  return '';
}

function formatPlainBlockLines(text: string, depth: number): string[] {
  const indent = '  '.repeat(depth);
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => `${indent}${line}`);
}

function formatListBlockLines(text: string, depth: number, marker: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }

  const indent = '  '.repeat(depth);
  const continuationIndent = '  '.repeat(depth + 1);
  return [
    `${indent}${marker}${lines[0]}`,
    ...lines.slice(1).map((line) => `${continuationIndent}${line}`),
  ];
}

function buildBlockLines(block: FeishuDocumentBlock, depth: number, orderedIndex: number | null): string[] {
  return buildBlockLinesWithText(block, extractBlockText(block), depth, orderedIndex);
}

function buildBlockLinesWithText(
  block: FeishuDocumentBlock,
  textOverride: string,
  depth: number,
  orderedIndex: number | null,
): string[] {
  const text = textOverride.trim();
  if (block.blockType === 1 || !text) {
    return [];
  }

  if (block.blockType === 12) {
    return formatListBlockLines(text, depth, '- ');
  }
  if (block.blockType === 13) {
    return formatListBlockLines(text, depth, `${orderedIndex ?? 1}. `);
  }

  return formatPlainBlockLines(text, depth);
}

function collectBlockLines(
  blockIds: string[],
  blockMap: Map<string, FeishuDocumentBlock>,
  depth: number,
  visited: Set<string>,
): string[] {
  const lines: string[] = [];
  let orderedIndex = 0;

  for (const blockId of blockIds) {
    const block = blockMap.get(blockId);
    if (!block || visited.has(blockId)) {
      continue;
    }

    visited.add(blockId);
    const isOrdered = block.blockType === 13;
    orderedIndex = isOrdered ? orderedIndex + 1 : 0;
    lines.push(...buildBlockLines(block, depth, isOrdered ? orderedIndex : null));
    lines.push(...collectBlockLines(
      block.children,
      blockMap,
      isOrdered || block.blockType === 12 ? depth + 1 : depth,
      visited,
    ));
  }

  return lines;
}

function buildDescendantChildLines(blockId: string, items: FeishuDocumentBlock[], depth: number): string[] {
  if (items.length === 0) {
    return [];
  }

  const blockMap = new Map(items.map((item) => [item.blockId, item] satisfies [string, FeishuDocumentBlock]));
  const rootBlock = blockMap.get(blockId) ?? null;
  const childBlockIds = rootBlock
    ? rootBlock.children
    : items.filter((item) => item.parentId === blockId).map((item) => item.blockId);

  return collectBlockLines(childBlockIds, blockMap, depth, new Set([blockId]));
}

function buildAssigneeHints(rawContent: string): FeishuDocumentAssigneeHints {
  return new Map(
    parseHotfixVersionBlocks(rawContent).map((block) => [
      block.versionLine,
      block.entries.map((entry) => entry.assigneeLine),
    ] satisfies [string, string[]]),
  );
}

function needsAssigneeHintLookup(items: FeishuDocumentBlock[]): boolean {
  return items.some((block) => hasMentionUserWithoutName(block.raw));
}

function normalizeUserDirectory(rawUsers: unknown): FeishuUserDirectory | null {
  if (!Array.isArray(rawUsers)) {
    return null;
  }

  const users: FeishuUserDirectory = new Map();
  for (const rawUser of rawUsers) {
    if (typeof rawUser !== 'object' || rawUser === null) {
      continue;
    }

    const user = rawUser as Record<string, unknown>;
    const userId = typeof user.user_id === 'string' ? user.user_id.trim() : '';
    const name = typeof user.name === 'string' && user.name.trim()
      ? user.name.trim()
      : (typeof user.nickname === 'string' ? user.nickname.trim() : '');
    if (userId && name && !users.has(userId)) {
      users.set(userId, name);
    }
  }

  return users;
}

function formatResolvedAssigneeLine(displayName: string, rawSuffix: string): string {
  const normalizedName = displayName.trim();
  if (!normalizedName) {
    return '';
  }

  const suffix = rawSuffix.trimEnd();
  if (!suffix.trim()) {
    return `@${normalizedName}`;
  }

  return /^\s/.test(suffix)
    ? `@${normalizedName}${suffix}`
    : `@${normalizedName} ${suffix.trimStart()}`;
}

type HotfixRenderContext = {
  currentVersionLine: string | null;
  versionCount: number;
  userDirectory: FeishuUserDirectory;
  assigneeHints: FeishuDocumentAssigneeHints;
  assigneeIndexes: Map<string, number>;
};

function createHotfixRenderContext(resolution?: FeishuDocumentAssigneeResolution): HotfixRenderContext {
  return {
    currentVersionLine: null,
    versionCount: 0,
    userDirectory: resolution?.userDirectory ?? new Map(),
    assigneeHints: resolution?.assigneeHints ?? new Map(),
    assigneeIndexes: new Map(),
  };
}

function tryResolveAssigneeHint(block: FeishuDocumentBlock, context: HotfixRenderContext): string | null {
  const versionLine = context.currentVersionLine;
  const mentionUserIds = extractMentionUserIds(block.raw);
  const rawSuffix = extractBlockText(block).trimEnd();
  const currentIndex = versionLine ? (context.assigneeIndexes.get(versionLine) ?? 0) : 0;
  if (versionLine) {
    context.assigneeIndexes.set(versionLine, currentIndex + 1);
  }

  for (const userId of mentionUserIds) {
    const displayName = context.userDirectory.get(userId);
    if (displayName) {
      return formatResolvedAssigneeLine(displayName, rawSuffix);
    }
  }

  const hint = versionLine ? context.assigneeHints.get(versionLine)?.[currentIndex]?.trim() : '';
  if (hint) {
    return hint;
  }

  if (mentionUserIds.length > 0) {
    return formatResolvedAssigneeLine(mentionUserIds[0]!, rawSuffix);
  }

  return rawSuffix.trim() || null;
}

function resolveTopLevelBlockText(block: FeishuDocumentBlock, context: HotfixRenderContext): string {
  const extractedText = extractBlockText(block).trim();
  if (isHotfixVersionLine(extractedText)) {
    context.currentVersionLine = extractedText;
    context.versionCount += 1;
    return extractedText;
  }

  if (hasMentionUserWithoutName(block.raw)) {
    return tryResolveAssigneeHint(block, context) ?? extractedText;
  }

  return extractedText;
}

function buildChildrenUrl(
  baseUrl: string,
  documentId: string,
  blockId: string,
  withDescendants: boolean,
  pageToken?: string,
): string {
  const params = new URLSearchParams();
  params.set('page_size', String(FEISHU_DOCUMENT_PAGE_SIZE));
  params.set('with_descendants', withDescendants ? 'true' : 'false');
  if (pageToken) {
    params.set('page_token', pageToken);
  }

  return `${baseUrl}/api/v1/feishu/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`;
}

function buildLegacyRawContentUrl(baseUrl: string, documentId: string): string {
  return `${baseUrl}/api/v1/feishu/legacy-documents/${encodeURIComponent(documentId)}/raw-content`;
}

function buildUsersUrl(baseUrl: string): string {
  return `${baseUrl}/api/v1/users`;
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

  async readContent(documentId: string, accessToken: string, tokenType: string, overrideBaseUrl?: string): Promise<FeishuDocumentContentResult> {
    return this.readDocumentContent(documentId, accessToken, tokenType, overrideBaseUrl, null);
  }

  async readRecentContent(
    documentId: string,
    accessToken: string,
    tokenType: string,
    limit = 5,
    overrideBaseUrl?: string,
  ): Promise<FeishuDocumentContentResult> {
    if (limit <= 0) {
      return {
        documentId,
        content: '',
      };
    }

    return this.readDocumentContent(documentId, accessToken, tokenType, overrideBaseUrl, limit);
  }

  private async readDocumentContent(
    documentId: string,
    accessToken: string,
    tokenType: string,
    overrideBaseUrl: string | undefined,
    recentVersionLimit: number | null,
  ): Promise<FeishuDocumentContentResult> {
    const baseUrl = trimTrailingSlash(overrideBaseUrl?.trim() || this.baseUrl);
    const rootBlocks = await this.listRootBlocks(
      documentId,
      accessToken,
      tokenType,
      baseUrl,
      recentVersionLimit,
    );
    const assigneeResolution = await this.loadAssigneeResolutionIfNeeded(
      rootBlocks.documentId,
      rootBlocks.items,
      accessToken,
      tokenType,
      baseUrl,
    );
    const lines: string[] = [];
    let orderedIndex = 0;
    const renderContext = createHotfixRenderContext(assigneeResolution);

    for (const block of rootBlocks.items) {
      const resolvedText = resolveTopLevelBlockText(block, renderContext);
      if (
        typeof recentVersionLimit === 'number'
        && isHotfixVersionLine(resolvedText)
        && renderContext.versionCount > recentVersionLimit
      ) {
        break;
      }

      const isOrdered = block.blockType === 13;
      orderedIndex = isOrdered ? orderedIndex + 1 : 0;
      const blockLines = await this.buildTopLevelBlockLines(
        rootBlocks.documentId,
        block,
        accessToken,
        tokenType,
        baseUrl,
        isOrdered ? orderedIndex : null,
        resolvedText,
      );

      lines.push(...blockLines);
    }

    return {
      documentId: rootBlocks.documentId,
      content: lines.join('\n').trim(),
    };
  }

  private async buildTopLevelBlockLines(
    documentId: string,
    block: FeishuDocumentBlock,
    accessToken: string,
    tokenType: string,
    baseUrl: string,
    orderedIndex: number | null,
    resolvedText: string,
  ): Promise<string[]> {
    const lines = buildBlockLinesWithText(block, resolvedText, 0, orderedIndex);
    if (block.children.length === 0) {
      return lines;
    }

    const descendants = await this.listChildBlocks(
      documentId,
      block.blockId,
      accessToken,
      tokenType,
      baseUrl,
      true,
    );

    return [
      ...lines,
      ...buildDescendantChildLines(
        block.blockId,
        descendants.items,
        block.blockType === 12 || block.blockType === 13 ? 1 : 0,
      ),
    ];
  }

  private async listChildBlocks(
    documentId: string,
    blockId: string,
    accessToken: string,
    tokenType: string,
    baseUrl: string,
    withDescendants: boolean,
  ): Promise<FeishuDocumentBlockListResult> {
    const items: FeishuDocumentBlock[] = [];
    let resolvedDocumentId = documentId;
    let nextPageToken: string | undefined;

    do {
      const page = await this.fetchChildrenPage(
        documentId,
        blockId,
        accessToken,
        tokenType,
        baseUrl,
        withDescendants,
        nextPageToken,
      );
      if (page.documentId) {
        resolvedDocumentId = page.documentId;
      }
      items.push(...page.items);

      if (!page.hasMore) {
        nextPageToken = undefined;
        continue;
      }
      if (!page.pageToken) {
        throw new Error('飞书文档 children 分页响应缺少 page_token');
      }

      nextPageToken = page.pageToken;
    } while (nextPageToken);

    return {
      documentId: resolvedDocumentId,
      items,
    };
  }

  private async listRootBlocks(
    documentId: string,
    accessToken: string,
    tokenType: string,
    baseUrl: string,
    recentVersionLimit: number | null,
  ): Promise<FeishuDocumentBlockListResult> {
    const items: FeishuDocumentBlock[] = [];
    let resolvedDocumentId = documentId;
    let nextPageToken: string | undefined;
    let versionCount = 0;
    let shouldStop = false;

    do {
      const page = await this.fetchChildrenPage(
        documentId,
        documentId,
        accessToken,
        tokenType,
        baseUrl,
        false,
        nextPageToken,
      );
      if (page.documentId) {
        resolvedDocumentId = page.documentId;
      }

      for (const item of page.items) {
        const blockText = extractBlockText(item).trim();
        if (
          typeof recentVersionLimit === 'number'
          && isHotfixVersionLine(blockText)
        ) {
          versionCount += 1;
          if (versionCount > recentVersionLimit) {
            shouldStop = true;
            break;
          }
        }

        items.push(item);
      }

      if (shouldStop || !page.hasMore) {
        nextPageToken = undefined;
        continue;
      }
      if (!page.pageToken) {
        throw new Error('飞书文档 children 分页响应缺少 page_token');
      }

      nextPageToken = page.pageToken;
    } while (nextPageToken);

    return {
      documentId: resolvedDocumentId,
      items,
    };
  }

  private async loadAssigneeResolutionIfNeeded(
    documentId: string,
    items: FeishuDocumentBlock[],
    accessToken: string,
    tokenType: string,
    baseUrl: string,
  ): Promise<FeishuDocumentAssigneeResolution | undefined> {
    if (!needsAssigneeHintLookup(items)) {
      return undefined;
    }

    const mentionUserIds = collectMentionUserIds(items);
    let userDirectory: FeishuUserDirectory | undefined;

    try {
      userDirectory = await this.fetchUserDirectory(accessToken, tokenType, baseUrl);
    } catch (error) {
      if (shouldRefreshHotfixToken(error)) {
        throw error;
      }
    }

    const hasUnresolvedUserIds = mentionUserIds.some((userId) => !userDirectory?.has(userId));
    const shouldLoadAssigneeHints =
      !userDirectory
      || hasUnresolvedUserIds
      || mentionUserIds.length === 0;
    let assigneeHints: FeishuDocumentAssigneeHints | undefined;

    if (shouldLoadAssigneeHints) {
      try {
        const rawContent = await this.fetchLegacyRawContent(documentId, accessToken, tokenType, baseUrl);
        assigneeHints = buildAssigneeHints(rawContent.content);
      } catch (error) {
        if (shouldRefreshHotfixToken(error)) {
          throw error;
        }
      }
    }

    return userDirectory || assigneeHints
      ? { userDirectory, assigneeHints }
      : undefined;
  }

  private async fetchChildrenPage(
    documentId: string,
    blockId: string,
    accessToken: string,
    tokenType: string,
    baseUrl: string,
    withDescendants: boolean,
    pageToken?: string,
  ): Promise<FeishuDocumentChildrenPage> {
    const response = await this.fetchImpl(
      buildChildrenUrl(baseUrl, documentId, blockId, withDescendants, pageToken),
      {
        method: 'GET',
        headers: {
          Authorization: `${tokenType} ${accessToken}`,
        },
      },
    );

    const rawText = await response.text();
    const payload = parseChildrenPayload(rawText);

    if (!response.ok) {
      throw new FeishuDocumentError(
        extractErrorMessage(response.status, payload, rawText),
        response.status,
        typeof payload?.code === 'string' ? payload.code : null,
        typeof payload?.trace_id === 'string' ? payload.trace_id : null,
      );
    }

    const data = payload?.data;
    const items = normalizeBlockItems(data?.items ?? data?.blocks);
    if (!data || !items) {
      throw new Error('飞书文档 children 响应格式无效');
    }

    return {
      documentId: typeof data.document_id === 'string' && data.document_id.trim() ? data.document_id.trim() : null,
      items,
      hasMore: data.has_more === true,
      pageToken: typeof data.page_token === 'string' && data.page_token.trim() ? data.page_token.trim() : null,
    };
  }

  private async fetchLegacyRawContent(
    documentId: string,
    accessToken: string,
    tokenType: string,
    baseUrl: string,
  ): Promise<FeishuDocumentContentResult> {
    const response = await this.fetchImpl(
      buildLegacyRawContentUrl(baseUrl, documentId),
      {
        method: 'GET',
        headers: {
          Authorization: `${tokenType} ${accessToken}`,
        },
      },
    );

    const rawText = await response.text();
    const payload = parseLegacyRawContentPayload(rawText);

    if (!response.ok) {
      throw new FeishuDocumentError(
        extractErrorMessage(response.status, payload as RawFeishuDocumentChildrenPayload | null, rawText),
        response.status,
        typeof payload?.code === 'string' ? payload.code : null,
        typeof payload?.trace_id === 'string' ? payload.trace_id : null,
      );
    }

    const data = payload?.data;
    const content = typeof data?.content === 'string' ? data.content.replace(/\r\n?/g, '\n').trim() : '';
    if (!data) {
      throw new Error('飞书文档 raw-content 响应格式无效');
    }

    return {
      documentId: typeof data.document_id === 'string' && data.document_id.trim() ? data.document_id.trim() : documentId,
      content,
    };
  }

  private async fetchUserDirectory(
    accessToken: string,
    tokenType: string,
    baseUrl: string,
  ): Promise<FeishuUserDirectory> {
    const response = await this.fetchImpl(
      buildUsersUrl(baseUrl),
      {
        method: 'GET',
        headers: {
          Authorization: `${tokenType} ${accessToken}`,
        },
      },
    );

    const rawText = await response.text();
    const payload = parseUsersPayload(rawText);

    if (!response.ok) {
      throw new FeishuDocumentError(
        extractErrorMessage(response.status, payload as RawFeishuDocumentChildrenPayload | null, rawText),
        response.status,
        typeof payload?.code === 'string' ? payload.code : null,
        typeof payload?.trace_id === 'string' ? payload.trace_id : null,
      );
    }

    const users = normalizeUserDirectory(payload?.data);
    if (!users) {
      throw new Error('飞书用户目录响应格式无效');
    }

    return users;
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
