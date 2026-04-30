import { describe, expect, it, vi } from 'vitest';
import {
  buildPortalNotificationRequestBody,
  PortalNotificationClient,
  PortalNotificationError,
} from '../src/portal-notification.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('portal notification client', () => {
  it('builds the portal request body and sends service credentials', async () => {
    const endpoint = 'http://portal.test/api/notifications/send';
    const fetchMock = vi.fn(async () => jsonResponse({
      success: true,
      code: 'OK',
      message: 'Notification send completed.',
      data: { deliveryId: 'delivery-001' },
    }));
    const client = new PortalNotificationClient({
      sendUrl: endpoint,
      serviceId: 'webchat-service',
      serviceToken: 'service-token-001',
      fetchImpl: fetchMock,
    });

    const data = await client.sendFromService({
      recipientUserId: 'ou_target_001',
      templateId: 'AAqeQyXbldjiN',
      templateVersionName: '1.0.2',
      payload: {
        card_title: '热更测试通过通知（待发）',
        hf_title: '8.2.0',
      },
    });

    expect(data).toEqual({ deliveryId: 'delivery-001' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Portal-Service-Id': 'webchat-service',
      Authorization: 'Bearer service-token-001',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      recipient_user_id: 'ou_target_001',
      template_id: 'AAqeQyXbldjiN',
      template_version_name: '1.0.2',
      payload: {
        card_title: '热更测试通过通知（待发）',
        hf_title: '8.2.0',
      },
      template_variable: {},
    });
  });

  it('rejects invalid required fields before sending', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new PortalNotificationClient({
      serviceId: 'webchat-service',
      serviceToken: 'service-token-001',
      fetchImpl: fetchMock,
    });

    await expect(client.sendFromService({
      recipientUserId: '',
      templateId: 'AAqeQyXbldjiN',
      templateVersionName: '1.0.2',
      payload: {},
    })).rejects.toMatchObject({
      status: 400,
      code: 'NOTIFICATION_REQUEST_INVALID',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-object payloads', () => {
    expect(() => buildPortalNotificationRequestBody({
      recipientUserId: 'ou_target_001',
      templateId: 'AAqeQyXbldjiN',
      templateVersionName: '1.0.2',
      payload: [] as unknown as Record<string, unknown>,
    })).toThrow(PortalNotificationError);
  });

  it('handles invalid service-token responses without exposing the token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      success: false,
      code: 'NOTIFICATION_SERVICE_TOKEN_INVALID',
      message: 'invalid Authorization: Bearer service-token-001',
    }, 401));
    const client = new PortalNotificationClient({
      serviceId: 'webchat-service',
      serviceToken: 'service-token-001',
      fetchImpl: fetchMock,
    });

    await expect(client.sendFromService({
      recipientUserId: 'ou_target_001',
      templateId: 'AAqeQyXbldjiN',
      templateVersionName: '1.0.2',
      payload: {},
    })).rejects.toMatchObject({
      status: 401,
      code: 'NOTIFICATION_SERVICE_TOKEN_INVALID',
      message: expect.not.stringContaining('service-token-001'),
    });
  });

  it('treats HTTP 200 success false as a failure', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      success: false,
      code: 'NOTIFICATION_SEND_FAILED',
      message: 'Feishu channel failed.',
    }));
    const client = new PortalNotificationClient({
      serviceId: 'webchat-service',
      serviceToken: 'service-token-001',
      fetchImpl: fetchMock,
    });

    await expect(client.sendFromService({
      recipientUserId: 'ou_target_001',
      templateId: 'AAqeQyXbldjiN',
      templateVersionName: '1.0.2',
      payload: {},
    })).rejects.toMatchObject({
      status: 200,
      code: 'NOTIFICATION_SEND_FAILED',
    });
  });
});
