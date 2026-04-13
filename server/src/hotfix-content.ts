const VERSION_HEADER_REGEX = /^\d+\.\d+\.\d+\.\d+(?:\s*[（(][^)）]+[)）])?\s*$/;
const ASSIGNEE_LINE_REGEX = /^@.+$/;

export type HotfixEntry = {
  assigneeLine: string;
  contentLines: string[];
};

export type HotfixVersionBlock = {
  versionLine: string;
  entries: HotfixEntry[];
  content: string;
  taskContent: string;
};

function normalizeLine(line: string): string {
  return line.trim();
}

export function isHotfixVersionLine(line: string): boolean {
  return VERSION_HEADER_REGEX.test(line.trim());
}

function buildVersionBlockContent(versionLine: string, entries: HotfixEntry[]): string {
  return [
    versionLine,
    ...entries.flatMap((entry) => [entry.assigneeLine, ...entry.contentLines]),
  ].join('\n');
}

function buildVersionBlockTaskContent(versionLine: string, entries: HotfixEntry[]): string {
  return [
    versionLine,
    ...entries.flatMap((entry) => [entry.assigneeLine, ...entry.contentLines.map((line) => `- ${line}`)]),
  ].join('\n');
}

function finalizeVersionBlock(blocks: HotfixVersionBlock[], currentBlock: Omit<HotfixVersionBlock, 'content' | 'taskContent'> | null): null {
  if (!currentBlock) {
    return null;
  }

  const entries = currentBlock.entries.filter((entry) => entry.contentLines.length > 0);
  if (entries.length > 0) {
    blocks.push({
      versionLine: currentBlock.versionLine,
      entries,
      content: buildVersionBlockContent(currentBlock.versionLine, entries),
      taskContent: buildVersionBlockTaskContent(currentBlock.versionLine, entries),
    });
  }

  return null;
}

function normalizeRawContent(rawContent: string): string {
  return rawContent.replace(/\r\n?/g, '\n').trim();
}

export function parseHotfixVersionBlocks(rawContent: string, limit?: number): HotfixVersionBlock[] {
  const normalized = normalizeRawContent(rawContent);
  if (!normalized) {
    return [];
  }

  const blocks: HotfixVersionBlock[] = [];
  const lines = normalized.split('\n');
  let currentBlock: Omit<HotfixVersionBlock, 'content' | 'taskContent'> | null = null;
  let currentEntry: HotfixEntry | null = null;

  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);

    if (VERSION_HEADER_REGEX.test(line)) {
      currentBlock = finalizeVersionBlock(blocks, currentBlock);
      currentBlock = {
        versionLine: line,
        entries: [],
      };
      currentEntry = null;
      continue;
    }

    if (!currentBlock) {
      continue;
    }

    if (!line) {
      currentEntry = null;
      continue;
    }

    if (ASSIGNEE_LINE_REGEX.test(line)) {
      currentEntry = {
        assigneeLine: line,
        contentLines: [],
      };
      currentBlock.entries.push(currentEntry);
      continue;
    }

    if (currentEntry) {
      currentEntry.contentLines.push(line);
    }
  }

  finalizeVersionBlock(blocks, currentBlock);
  if (typeof limit === 'number') {
    return blocks.slice(0, Math.max(0, limit));
  }

  return blocks;
}

export function parseRecentHotfixVersionBlocks(rawContent: string, limit = 5): HotfixVersionBlock[] {
  return parseHotfixVersionBlocks(rawContent, limit);
}

export function buildHotfixContentFromBlocks(blocks: HotfixVersionBlock[]): string {
  return blocks.map((block) => block.content).join('\n\n').trim();
}

export function buildHotfixTaskContentFromBlocks(blocks: HotfixVersionBlock[]): string {
  return blocks.map((block) => block.taskContent).join('\n\n').trim();
}

export function formatRecentHotfixContent(rawContent: string, limit = 5): string {
  const normalized = normalizeRawContent(rawContent);
  if (!normalized) {
    return '';
  }

  const blocks = parseRecentHotfixVersionBlocks(rawContent, limit);
  if (blocks.length === 0) {
    return normalized;
  }

  return blocks.map((block) => block.content).join('\n\n');
}

export function buildRecentHotfixResult(rawContent: string, limit = 5): { content: string; versionBlocks: HotfixVersionBlock[] } {
  const normalized = rawContent.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return {
      content: '',
      versionBlocks: [],
    };
  }

  const versionBlocks = parseRecentHotfixVersionBlocks(rawContent, limit);
  return {
    content: versionBlocks.length > 0 ? buildHotfixContentFromBlocks(versionBlocks) : normalized,
    versionBlocks,
  };
}
