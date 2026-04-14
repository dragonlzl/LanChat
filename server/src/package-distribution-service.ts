import type {
  PackageDistributionPreviewBlock,
  PackageTaskEntry,
  TaskMessageContent,
  TaskMessageGroup,
  TaskMessageItem,
  TaskMessageSection,
} from './types.js';

const DIRECTORY_LINK_REGEX = /<a\s+[^>]*href=(['"])(.*?)\1[^>]*>(.*?)<\/a>/giu;
const PACKAGE_DISTRIBUTION_FILE_EXTENSIONS = ['.apk', '.apks', '.aab'] as const;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function normalizePackageSourceUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('包体链接不能为空');
  }

  const withProtocol = /^https?:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error(`包体链接无效：${trimmed}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`包体链接协议不受支持：${trimmed}`);
  }

  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }

  return url.toString();
}

function buildBasicDirectoryViewUrl(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  if (!url.searchParams.has('get')) {
    url.searchParams.set('get', 'basic');
  }
  return url.toString();
}

function extractBlockLabels(sourceUrl: string): { title: string; branchLabel: string; versionLabel: string } {
  const url = new URL(sourceUrl);
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const versionLabel = segments.at(-1) ?? url.host;
  const branchLabel = segments.at(-2) ?? url.host;
  const title = segments.length >= 2 ? `${branchLabel} / ${versionLabel}` : versionLabel;

  return {
    title,
    branchLabel,
    versionLabel,
  };
}

function isIgnoredDirectoryLink(rawHref: string, displayText: string): boolean {
  const normalizedHref = rawHref.trim();
  const normalizedText = displayText.trim();
  return (
    !normalizedHref
    || normalizedHref === '..'
    || normalizedText === '..'
    || normalizedHref.includes('?get=login')
  );
}

function toPackageTaskEntry(sourceUrl: string, rawHref: string, displayText: string, index: number): PackageTaskEntry {
  const entryUrl = new URL(rawHref, sourceUrl);
  const entryType = rawHref.endsWith('/') || displayText.endsWith('/') ? 'directory' : 'file';
  const entryName = decodeHtmlEntities(displayText.replace(/<[^>]*>/gu, '').trim()).replace(/\/$/, '');
  const fallbackName = decodeURIComponent(entryUrl.pathname.split('/').filter(Boolean).at(-1) ?? '');
  const name = entryName || fallbackName || `entry-${index + 1}`;

  return {
    id: `entry-${index + 1}`,
    name,
    path: name,
    entryType,
    url: entryUrl.toString(),
  };
}

function parseDirectoryEntries(sourceUrl: string, html: string): PackageTaskEntry[] {
  const entries: PackageTaskEntry[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = DIRECTORY_LINK_REGEX.exec(html)) !== null) {
    const rawHref = decodeHtmlEntities(match[2] ?? '');
    const displayText = decodeHtmlEntities(match[3] ?? '');
    if (isIgnoredDirectoryLink(rawHref, displayText)) {
      continue;
    }

    entries.push(toPackageTaskEntry(sourceUrl, rawHref, displayText, entries.length));
  }

  return entries;
}

function isSupportedPackageDistributionFileEntry(entry: PackageTaskEntry): boolean {
  if (entry.entryType !== 'file') {
    return false;
  }

  const pathname = new URL(entry.url).pathname.toLowerCase();
  return PACKAGE_DISTRIBUTION_FILE_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}

function filterPreviewEntries(entries: PackageTaskEntry[]): PackageTaskEntry[] {
  return entries.filter((entry) => (
    entry.entryType === 'directory' || isSupportedPackageDistributionFileEntry(entry)
  ));
}

export class PackageDistributionService {
  async fetchPreviewBlocks(rawUrls: string[]): Promise<PackageDistributionPreviewBlock[]> {
    const normalizedUrls = Array.from(
      new Set(
        rawUrls
          .map((value) => normalizePackageSourceUrl(value))
          .filter(Boolean),
      ),
    );

    if (normalizedUrls.length === 0) {
      throw new Error('请至少输入一个包体链接');
    }

    return Promise.all(
      normalizedUrls.map(async (sourceUrl, index) => {
        const candidateUrls = [buildBasicDirectoryViewUrl(sourceUrl), sourceUrl];
        let response: Response | null = null;
        let html = '';

        for (const candidateUrl of candidateUrls) {
          const candidateResponse = await fetch(candidateUrl, {
            headers: {
              Accept: 'text/html,application/xhtml+xml',
            },
          });

          if (!candidateResponse.ok) {
            continue;
          }

          const candidateHtml = await candidateResponse.text();
          const candidateEntries = parseDirectoryEntries(sourceUrl, candidateHtml);
          if (candidateEntries.length === 0) {
            response = candidateResponse;
            html = candidateHtml;
            continue;
          }

          response = candidateResponse;
          html = candidateHtml;
          break;
        }

        if (!response || !response.ok) {
          throw new Error(`包体链接读取失败：${sourceUrl} (${response?.status ?? 'network'})`);
        }
        const entries = filterPreviewEntries(parseDirectoryEntries(sourceUrl, html));
        const labels = extractBlockLabels(sourceUrl);

        return {
          id: `package-block-${index + 1}`,
          title: labels.title,
          sourceUrl,
          branchLabel: labels.branchLabel,
          versionLabel: labels.versionLabel,
          entries,
          fileCount: entries.filter((entry) => entry.entryType === 'file').length,
          directoryCount: entries.filter((entry) => entry.entryType === 'directory').length,
        } satisfies PackageDistributionPreviewBlock;
      }),
    );
  }
}

type PackageDistributionTaskInputEntry = PackageTaskEntry & {
  assignee?: string;
  assignees?: string[];
};

type PackageDistributionTaskInputBlock = {
  title?: string;
  sourceUrl?: string;
  entries?: PackageDistributionTaskInputEntry[];
};

function normalizePackageTaskAssignees(rawAssignees: unknown, fallbackAssignee: unknown): string[] {
  const inputValues = Array.isArray(rawAssignees)
    ? rawAssignees
    : typeof fallbackAssignee === 'string' && fallbackAssignee.trim()
      ? [fallbackAssignee]
      : [];

  const normalizedValues: string[] = [];
  const seen = new Set<string>();

  for (const value of inputValues) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalized = value.trim();
    const dedupeKey = normalized.toLowerCase();
    if (!normalized || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalizedValues.push(normalized);
  }

  return normalizedValues;
}

function buildPackageDistributionTaskText(taskContent: TaskMessageContent): string {
  return taskContent.sections
    .map((section) => {
      const lines = [section.title];
      if (section.packageSource?.sourceUrl) {
        lines.push(`链接：${section.packageSource.sourceUrl}`);
      }

      const directoryNames = (section.packageSource?.entries ?? [])
        .filter((entry) => entry.entryType === 'directory')
        .map((entry) => entry.name);
      if (directoryNames.length > 0) {
        lines.push(`目录：${directoryNames.join('、')}`);
      }

      for (const group of section.groups) {
        lines.push(`@${group.assignee}`);
        for (const item of group.items) {
          lines.push(`- ${item.text}`);
        }
      }

      return lines.join('\n');
    })
    .join('\n\n')
    .trim();
}

export function buildPackageDistributionTaskMessage(rawBlocks: unknown): { textContent: string; taskContent: TaskMessageContent } {
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
    throw new Error('请先获取并选择包体内容');
  }

  let itemIndex = 0;
  const sections: TaskMessageSection[] = rawBlocks.map((rawBlock, sectionIndex) => {
    if (typeof rawBlock !== 'object' || rawBlock === null) {
      throw new Error('包体任务内容格式错误');
    }

    const block = rawBlock as PackageDistributionTaskInputBlock;
    const sourceUrl = typeof block.sourceUrl === 'string' ? normalizePackageSourceUrl(block.sourceUrl) : '';
    const title = typeof block.title === 'string' && block.title.trim() ? block.title.trim() : extractBlockLabels(sourceUrl).title;
    const entries = Array.isArray(block.entries) ? block.entries : [];

    if (!sourceUrl || entries.length === 0) {
      throw new Error('包体任务内容不能为空');
    }

    const normalizedEntries: PackageTaskEntry[] = [];
    const groupsByAssignee = new Map<string, TaskMessageGroup>();

    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error('包体条目格式错误');
      }

      const normalizedEntry = toPackageTaskEntry(
        sourceUrl,
        typeof entry.url === 'string' ? entry.url : '',
        typeof entry.name === 'string' ? entry.name : '',
        normalizedEntries.length,
      );
      normalizedEntry.id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : normalizedEntry.id;
      normalizedEntry.path = typeof entry.path === 'string' && entry.path.trim() ? entry.path.trim() : normalizedEntry.name;
      normalizedEntry.entryType = entry.entryType === 'directory' ? 'directory' : 'file';
      normalizedEntries.push(normalizedEntry);

      if (normalizedEntry.entryType !== 'file') {
        continue;
      }

      const assignees = normalizePackageTaskAssignees(entry.assignees, entry.assignee);
      if (assignees.length === 0) {
        throw new Error(`请选择文件 ${normalizedEntry.name} 的测试人员`);
      }

      for (const assignee of assignees) {
        const existingGroup = groupsByAssignee.get(assignee);
        const item: TaskMessageItem = {
          id: `task-${++itemIndex}`,
          text: normalizedEntry.name,
          completed: false,
          completedByNickname: null,
          changed: false,
          resource: {
            kind: 'remote-package-file',
            sourceUrl,
            fileUrl: normalizedEntry.url,
            fileName: normalizedEntry.name,
            filePath: normalizedEntry.path,
          },
        };

        if (existingGroup) {
          existingGroup.items.push(item);
        } else {
          groupsByAssignee.set(assignee, {
            id: `group-${sectionIndex + 1}-${groupsByAssignee.size + 1}`,
            assignee,
            items: [item],
          });
        }
      }
    }

    const groups = Array.from(groupsByAssignee.values());
    if (groups.length === 0) {
      throw new Error(`链接 ${title} 下没有可分配的文件`);
    }

    return {
      id: `section-${sectionIndex + 1}`,
      title,
      groups,
      packageSource: {
        sourceUrl,
        entries: normalizedEntries,
      },
    };
  });

  const taskContent: TaskMessageContent = {
    kind: 'package-distribution',
    sections,
  };

  return {
    textContent: buildPackageDistributionTaskText(taskContent),
    taskContent,
  };
}
