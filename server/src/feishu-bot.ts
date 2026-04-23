import type { FeishuBotSettings, TaskMessageContent, TaskNotificationRecipient } from './types.js';

type WebhookResponse = {
  code?: number;
  msg?: string;
  StatusCode?: number;
  StatusMessage?: string;
};

type FeishuCardMarkdownElement = {
  tag: 'markdown';
  content: string;
  text_align: 'left';
  text_size: 'normal_v2';
  margin: string;
};

type FeishuInteractiveCard = {
  schema: '2.0';
  config: {
    update_multi: true;
    style: {
      text_size: {
        normal_v2: {
          default: 'normal';
          pc: 'normal';
          mobile: 'heading';
        };
      };
    };
  };
  body: {
    direction: 'vertical';
    padding: string;
    elements: FeishuCardMarkdownElement[];
  };
  header: {
    title: {
      tag: 'plain_text';
      content: string;
    };
    subtitle: {
      tag: 'plain_text';
      content: string;
    };
    template: 'green';
    padding: string;
  };
};

const FEISHU_WEBHOOK_MAX_BYTES = 20 * 1024;

export type SendTaskNotificationInput = {
  taskTitles: string[];
  taskContent: TaskMessageContent;
  recipients: TaskNotificationRecipient[];
};

function escapeCardMarkdownText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function buildMentionMarkdown(recipients: TaskNotificationRecipient[]): string {
  if (recipients.length === 0) {
    return '测试通过';
  }

  return `${recipients.map((recipient) => `<at id=${escapeCardMarkdownText(recipient.memberId)}></at>`).join(' ')} 测试通过`;
}

function buildTaskItemMarkdownLines(item: TaskMessageContent['sections'][number]['groups'][number]['items'][number], depth = 0): string[] {
  const escapedText = escapeCardMarkdownText(item.text.trim());
  const completedByText = item.completed && item.completedByNickname
    ? ` \`${escapeCardMarkdownText(item.completedByNickname)}\``
    : '';
  const indent = '  '.repeat(depth);
  return [
    `${indent}- ${item.completed ? `✅ ~~${escapedText}~~` : escapedText}${completedByText}`,
    ...(item.children ?? []).flatMap((child) => buildTaskItemMarkdownLines(child, depth + 1)),
  ];
}

function buildGroupMarkdown(group: TaskMessageContent['sections'][number]['groups'][number]): string {
  const lines: string[] = [];

  if (group.assignee.trim()) {
    lines.push(`@${escapeCardMarkdownText(group.assignee.trim())}`);
  }

  group.items.forEach((item) => {
    lines.push(...buildTaskItemMarkdownLines(item));
  });

  return lines.join('\n');
}

function buildSectionElements(
  section: TaskMessageContent['sections'][number],
  sectionIndex: number,
): FeishuCardMarkdownElement[] {
  const elements: FeishuCardMarkdownElement[] = [];
  const sectionTitle = section.title.trim();

  if (sectionTitle) {
    elements.push(
      createMarkdownElement(
        `**${escapeCardMarkdownText(sectionTitle)}**`,
        sectionIndex === 0 ? '0px 0px 0px 0px' : '12px 0px 0px 0px',
      ),
    );
  }

  section.groups.forEach((group, groupIndex) => {
    elements.push(
      createMarkdownElement(
        buildGroupMarkdown(group),
        groupIndex === 0 ? '2px 0px 0px 0px' : '4px 0px 0px 0px',
      ),
    );
  });

  return elements;
}

function createMarkdownElement(content: string, margin: string): FeishuCardMarkdownElement {
  return {
    tag: 'markdown',
    content,
    text_align: 'left',
    text_size: 'normal_v2',
    margin,
  };
}

function buildTaskNotificationCard(input: SendTaskNotificationInput): FeishuInteractiveCard {
  const sectionElements = input.taskContent.sections.flatMap((section, index) => buildSectionElements(section, index));
  const footerElement = createMarkdownElement(buildMentionMarkdown(input.recipients), sectionElements.length > 0 ? '8px 0px 0px 0px' : '0px 0px 0px 0px');

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      style: {
        text_size: {
          normal_v2: {
            default: 'normal',
            pc: 'normal',
            mobile: 'heading',
          },
        },
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [...sectionElements, footerElement],
    },
    header: {
      title: {
        tag: 'plain_text',
        content: input.taskTitles.join(' / ') || '任务通知',
      },
      subtitle: {
        tag: 'plain_text',
        content: '热更验证通知',
      },
      template: 'green',
      padding: '12px 12px 12px 12px',
    },
  };
}

function buildTaskNotificationPayload(input: SendTaskNotificationInput): Record<string, unknown> {
  const card = buildTaskNotificationCard(input);
  const payload = {
    msg_type: 'interactive',
    card,
  } satisfies Record<string, unknown>;

  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= FEISHU_WEBHOOK_MAX_BYTES) {
    return payload;
  }

  return {
    msg_type: 'interactive',
    card: {
      ...card,
      body: {
        ...card.body,
        elements: [
          createMarkdownElement(`**${escapeCardMarkdownText(input.taskTitles.join(' / ') || '任务已完成')}**`, '0px 0px 0px 0px'),
          createMarkdownElement(buildMentionMarkdown(input.recipients), '16px 0px 0px 0px'),
        ],
      },
    },
  } satisfies Record<string, unknown>;
}

export class FeishuBotClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async sendTaskNotification(settings: FeishuBotSettings, input: SendTaskNotificationInput): Promise<void> {
    const webhookUrl = settings.webhookUrl.trim();

    if (!webhookUrl) {
      throw new Error('飞书 webhook 未配置');
    }
    if (input.recipients.length === 0) {
      throw new Error('请选择至少一位飞书通知成员');
    }

    await this.sendWebhookPayload(webhookUrl, buildTaskNotificationPayload(input));
  }

  private async sendWebhookPayload(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
    const responsePayload = await this.fetchJson<WebhookResponse>(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const statusCode = typeof responsePayload.code === 'number'
      ? responsePayload.code
      : typeof responsePayload.StatusCode === 'number'
        ? responsePayload.StatusCode
        : null;

    if (statusCode !== null && statusCode !== 0) {
      throw new Error(
        responsePayload.msg?.trim()
        || responsePayload.StatusMessage?.trim()
        || `飞书 webhook 调用失败 (${statusCode})`,
      );
    }
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(url, init);
    const rawText = await response.text();
    let payload: unknown = null;

    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const errorMessage =
        typeof payload === 'object'
        && payload !== null
        && 'msg' in payload
        && typeof payload.msg === 'string'
          ? payload.msg
          : rawText.trim() || `HTTP ${response.status}`;
      throw new Error(errorMessage);
    }

    return (payload ?? {}) as T;
  }
}
