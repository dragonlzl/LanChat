import type { HotfixVersionBlock, TaskMessageContent, TaskMessageItem } from './types';

const HOTFIX_TASK_ITEM_REGEX = /^-\s+(.+)$/;
const HOTFIX_TASK_CONTINUATION_REGEX = /^(?:\d+[.)、]\s*|[（(]\d+[)）]\s*|[一二三四五六七八九十]+[、.．]\s*)/;
const HOTFIX_ORDERED_TASK_ITEM_REGEX = /^(?:(\d+)[.)](?!\d)\s*|(\d+)、\s*|[（(](\d+)[)）]\s*|([一二三四五六七八九十]+)[、.．]\s*)(.+)$/;

type PreviewTaskItem = {
  text: string;
  children?: PreviewTaskItem[];
};

type PreviewTaskStackEntry = {
  indent: number;
  item: PreviewTaskItem;
  lineType: 'bullet' | 'ordered' | 'plain';
};

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

  const arabicIndex = match[1] ?? match[2] ?? match[3];
  if (arabicIndex) {
    const parsed = Number.parseInt(arabicIndex, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const chineseIndex = match[4];
  return chineseIndex ? parseChineseOrderNumber(chineseIndex) : null;
}

function endsWithNestedTaskHint(text: string): boolean {
  return /[:：]\s*$/.test(text.trim());
}

function resolveOrderedTaskIndent(rawIndent: number, orderedIndex: number | null, stack: PreviewTaskStackEntry[]): number {
  if (rawIndent > 0 || stack.length === 0) {
    return rawIndent;
  }

  const current = stack[stack.length - 1]!;
  if (current.lineType !== 'ordered') {
    return orderedIndex === 1 && endsWithNestedTaskHint(current.item.text)
      ? current.indent + 2
      : 0;
  }

  if (orderedIndex === 1 && endsWithNestedTaskHint(current.item.text)) {
    return current.indent + 2;
  }

  return current.indent;
}

function appendPreviewTaskLine(item: PreviewTaskItem, line: string): PreviewTaskItem {
  return {
    ...item,
    text: `${item.text}\n${line}`,
  };
}

function pushPreviewTaskItem(
  items: PreviewTaskItem[],
  item: PreviewTaskItem,
  indent: number,
  lineType: PreviewTaskStackEntry['lineType'],
  stack: PreviewTaskStackEntry[],
): void {
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
}

function extractHotfixEntryPreviewItems(contentLines: string[]): PreviewTaskItem[] {
  const items: PreviewTaskItem[] = [];
  const stack: PreviewTaskStackEntry[] = [];

  for (const rawLine of contentLines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const indent = getLineIndentWidth(line);
    const itemMatch = HOTFIX_TASK_ITEM_REGEX.exec(trimmed);
    if (itemMatch) {
      pushPreviewTaskItem(items, { text: itemMatch[1].trimEnd() }, indent, 'bullet', stack);
      continue;
    }

    const orderedIndex = parseHotfixOrderedTaskIndex(trimmed);
    if (orderedIndex !== null) {
      const resolvedIndent = resolveOrderedTaskIndent(indent, orderedIndex, stack);
      pushPreviewTaskItem(items, { text: trimmed }, resolvedIndent, 'ordered', stack);
      continue;
    }

    if (stack.length > 0 && indent > 0) {
      const current = stack[stack.length - 1]!;
      current.item = appendPreviewTaskLine(current.item, line);
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

    pushPreviewTaskItem(items, { text: trimmed }, indent, 'plain', stack);
  }

  return items;
}

function countPreviewTaskItems(items: PreviewTaskItem[]): number {
  return items.reduce((total, item) => total + 1 + countPreviewTaskItems(item.children ?? []), 0);
}

function isTaskItemTreeCompleted(item: TaskMessageItem): boolean {
  return item.completed && (item.children ?? []).every((child) => isTaskItemTreeCompleted(child));
}

export function areTaskContentItemsCompleted(taskContent: TaskMessageContent | null): boolean {
  if (!taskContent) {
    return false;
  }

  return taskContent.sections.every((section) =>
    section.groups.every((group) => group.items.every((item) => isTaskItemTreeCompleted(item))),
  );
}

export function countHotfixBlockItems(block: HotfixVersionBlock): number {
  return block.entries.reduce((total, entry) => total + countPreviewTaskItems(extractHotfixEntryPreviewItems(entry.contentLines)), 0);
}
