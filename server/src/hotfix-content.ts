const VERSION_HEADER_REGEX = /^\d+\.\d+\.\d+(?:\.\d+)?(?:\s*\S.*)?$/;
const RESOURCE_HOTFIX_HEADER_REGEX = /^资源热更\s+\S(?:.*\S)?$/;
const ASSIGNEE_LINE_REGEX = /^@.+$/;
const HOTFIX_TASK_ITEM_REGEX = /^-\s+(.+)$/;
const HOTFIX_TASK_CONTINUATION_REGEX = /^(?:\d+[.)、]\s*|[（(]\d+[)）]\s*|[一二三四五六七八九十]+[、.．]\s*)/;
const HOTFIX_ORDERED_TASK_ITEM_REGEX = /^(?:(\d+)[.)、]\s*|[（(](\d+)[)）]\s*|([一二三四五六七八九十]+)[、.．]\s*)(.+)$/;

export type HotfixEntry = {
  assigneeLine: string;
  contentLines: string[];
};

export type HotfixTaskItem = {
  text: string;
  children?: HotfixTaskItem[];
};

type HotfixTaskStackEntry = {
  indent: number;
  item: HotfixTaskItem;
  lineType: 'bullet' | 'ordered' | 'plain';
};

export type HotfixVersionBlock = {
  versionLine: string;
  entries: HotfixEntry[];
  content: string;
  taskContent: string;
};

function normalizeHeaderLine(line: string): string {
  return line.trim();
}

function normalizeContentLine(line: string): string {
  return line.trimEnd();
}

export function isHotfixVersionLine(line: string): boolean {
  const normalized = normalizeHeaderLine(line);
  return VERSION_HEADER_REGEX.test(normalized) || RESOURCE_HOTFIX_HEADER_REGEX.test(normalized);
}

function isHotfixTaskContinuationLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  return /^\s+/.test(line) || HOTFIX_TASK_CONTINUATION_REGEX.test(trimmed);
}

function getLineIndentWidth(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function parseChineseOrderNumber(value: string): number | null {
  const mapping: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };

  return mapping[value] ?? null;
}

function parseHotfixOrderedTaskIndex(line: string): number | null {
  const match = HOTFIX_ORDERED_TASK_ITEM_REGEX.exec(line);
  if (!match) {
    return null;
  }

  const arabicIndex = match[1] ?? match[2];
  if (arabicIndex) {
    const parsed = Number.parseInt(arabicIndex, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const chineseIndex = match[3];
  return chineseIndex ? parseChineseOrderNumber(chineseIndex) : null;
}

function endsWithNestedTaskHint(text: string): boolean {
  return /[:：]\s*$/.test(text.trim());
}

function resolveOrderedTaskIndent(rawIndent: number, orderedIndex: number | null, stack: HotfixTaskStackEntry[]): number {
  if (rawIndent > 0 || stack.length === 0) {
    return rawIndent;
  }

  const current = stack[stack.length - 1]!;
  if (current.lineType !== 'ordered') {
    return current.indent + 2;
  }

  if (orderedIndex === 1 && endsWithNestedTaskHint(current.item.text)) {
    return current.indent + 2;
  }

  return current.indent;
}

function appendHotfixTaskLine(item: HotfixTaskItem, line: string): HotfixTaskItem {
  return {
    ...item,
    text: `${item.text}\n${line}`,
  };
}

function pushHotfixTaskItem(
  items: HotfixTaskItem[],
  item: HotfixTaskItem,
  indent: number,
  lineType: HotfixTaskStackEntry['lineType'],
  stack: HotfixTaskStackEntry[],
): HotfixTaskItem[] {
  while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
    stack.pop();
  }

  const parent = stack[stack.length - 1]?.item;
  if (parent) {
    parent.children = [...(parent.children ?? []), item];
  } else {
    items.push(item);
  }

  stack.push({ indent, item, lineType });
  return items;
}

export function extractHotfixEntryTaskItems(contentLines: string[]): HotfixTaskItem[] {
  const items: HotfixTaskItem[] = [];
  const stack: HotfixTaskStackEntry[] = [];

  for (const rawLine of contentLines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const indent = getLineIndentWidth(line);
    const topLevelItemMatch = HOTFIX_TASK_ITEM_REGEX.exec(trimmed);
    if (topLevelItemMatch) {
      pushHotfixTaskItem(items, { text: topLevelItemMatch[1].trimEnd() }, indent, 'bullet', stack);
      continue;
    }

    const orderedIndex = parseHotfixOrderedTaskIndex(trimmed);
    if (orderedIndex !== null) {
      const resolvedIndent = resolveOrderedTaskIndent(indent, orderedIndex, stack);
      pushHotfixTaskItem(items, { text: trimmed }, resolvedIndent, 'ordered', stack);
      continue;
    }

    if (stack.length > 0 && isHotfixTaskContinuationLine(line) && indent > 0) {
      const current = stack[stack.length - 1]!;
      current.item = appendHotfixTaskLine(current.item, line);
      if (stack.length > 1) {
        const parent = stack[stack.length - 2]!.item;
        if (parent.children && parent.children.length > 0) {
          parent.children[parent.children.length - 1] = current.item;
        }
      } else if (items.length > 0) {
        items[items.length - 1] = current.item;
      }
      continue;
    }

    pushHotfixTaskItem(items, { text: trimmed }, indent, 'plain', stack);
  }

  return items;
}

function formatHotfixTaskItemTextLines(itemText: string, depth: number): string[] {
  const lines = itemText.split('\n');
  const firstLine = lines[0] ?? '';
  const remainingLines = lines.slice(1);
  const prefix = depth === 0 ? '- ' : `${'  '.repeat(depth)}`;
  return [`${prefix}${firstLine}`, ...remainingLines];
}

function formatHotfixTaskItemLines(item: HotfixTaskItem, depth = 0): string[] {
  return [
    ...formatHotfixTaskItemTextLines(item.text, depth),
    ...(item.children ?? []).flatMap((child) => formatHotfixTaskItemLines(child, depth + 1)),
  ];
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
    ...entries.flatMap((entry) => {
      const taskItems = extractHotfixEntryTaskItems(entry.contentLines);
      if (taskItems.length === 0) {
        return [];
      }

      return [entry.assigneeLine, ...taskItems.flatMap((item) => formatHotfixTaskItemLines(item))];
    }),
  ].join('\n');
}

function finalizeVersionBlock(blocks: HotfixVersionBlock[], currentBlock: Omit<HotfixVersionBlock, 'content' | 'taskContent'> | null): null {
  if (!currentBlock) {
    return null;
  }

  const entries = currentBlock.entries.filter((entry) => extractHotfixEntryTaskItems(entry.contentLines).length > 0);
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
    const line = normalizeHeaderLine(rawLine);

    if (isHotfixVersionLine(line)) {
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
      currentEntry.contentLines.push(normalizeContentLine(rawLine));
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
