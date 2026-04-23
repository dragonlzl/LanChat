export const ADB_API_BASE_URL = 'http://127.0.0.1:8765';
const ADB_DEVICES_ENDPOINT_PATH = '/api/v1/adb/devices';
const ADB_INSTALL_STREAM_ENDPOINT_PATH = '/api/v1/adb/install/stream';

export type AdbInstallStage = 'downloading' | 'installing' | 'finished' | 'failed';

export interface AdbDeviceInfo {
  manufacturer?: string;
  model?: string;
  android_version?: string;
  cpu?: string;
  max_mem_gb?: number;
  battery_status?: string;
  battery_level_percent?: number;
  battery_temperature_c?: number;
  resolution?: string;
  ip?: string;
  [key: string]: unknown;
}

export interface AdbDevice {
  device_id: string;
  state: string;
  device_info: AdbDeviceInfo;
}

export interface AdbInstallEvent {
  device_id: string;
  stage: AdbInstallStage;
  percent: number | null;
  message: string;
  success?: boolean;
}

export class AdbServiceUnavailableError extends Error {
  constructor() {
    super('本地adb服务未开启');
  }
}

export function isAdbServiceUnavailableError(error: unknown): error is AdbServiceUnavailableError {
  return error instanceof AdbServiceUnavailableError;
}

export function isAdbInstallSupportedPackageUrl(packageUrl: string): boolean {
  try {
    const url = new URL(packageUrl);
    const pathname = decodeURIComponent(url.pathname).toLowerCase();
    return pathname.endsWith('.apk') || pathname.endsWith('.apks');
  } catch {
    const normalized = packageUrl.toLowerCase().split(/[?#]/u)[0] ?? '';
    return normalized.endsWith('.apk') || normalized.endsWith('.apks');
  }
}

export async function probeAdbService(): Promise<boolean> {
  try {
    await fetch(`${ADB_API_BASE_URL}${ADB_DEVICES_ENDPOINT_PATH}`, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
    });
    return true;
  } catch {
    return false;
  }
}

async function readAdbErrorMessage(response: Response): Promise<string> {
  const fallbackMessage = `ADB 请求失败 (${response.status})`;
  let text = '';

  try {
    text = await response.text();
  } catch {
    return fallbackMessage;
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    return fallbackMessage;
  }

  try {
    const payload = JSON.parse(trimmedText) as { message?: unknown; error?: unknown };
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
  } catch {
    return trimmedText;
  }

  return fallbackMessage;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function normalizeAdbDevice(value: unknown): AdbDevice | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const deviceId = typeof record.device_id === 'string' ? record.device_id.trim() : '';
  if (!deviceId) {
    return null;
  }

  const deviceInfo = toRecord(record.device_info) ?? {};
  return {
    device_id: deviceId,
    state: typeof record.state === 'string' && record.state.trim() ? record.state.trim() : 'unknown',
    device_info: deviceInfo,
  };
}

export async function fetchAdbDevices(): Promise<AdbDevice[]> {
  let response: Response;
  try {
    response = await fetch(`${ADB_API_BASE_URL}${ADB_DEVICES_ENDPOINT_PATH}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    if (await probeAdbService()) {
      throw new Error('本地adb服务已响应，但设备列表被浏览器拦截；请确认已重启并运行支持跨域/PNA的新版ADB工具');
    }
    throw new AdbServiceUnavailableError();
  }

  if (!response.ok) {
    throw new Error(await readAdbErrorMessage(response));
  }

  let payload: { success?: unknown; devices?: unknown; message?: unknown };
  try {
    payload = await response.json() as { success?: unknown; devices?: unknown; message?: unknown };
  } catch {
    throw new Error('ADB 设备响应解析失败');
  }

  if (payload.success === false) {
    throw new Error(typeof payload.message === 'string' && payload.message.trim() ? payload.message.trim() : '获取设备失败');
  }

  if (!Array.isArray(payload.devices)) {
    return [];
  }

  return payload.devices.flatMap((device) => {
    const normalized = normalizeAdbDevice(device);
    return normalized ? [normalized] : [];
  });
}

function isAdbInstallStage(value: unknown): value is AdbInstallStage {
  return value === 'downloading' || value === 'installing' || value === 'finished' || value === 'failed';
}

function normalizeInstallEvent(value: unknown): AdbInstallEvent | null {
  const record = toRecord(value);
  if (!record || !isAdbInstallStage(record.stage)) {
    return null;
  }

  const rawPercent = record.percent;
  const percent = typeof rawPercent === 'number' && Number.isFinite(rawPercent) ? rawPercent : null;
  return {
    device_id: typeof record.device_id === 'string' ? record.device_id : '',
    stage: record.stage,
    percent,
    message: typeof record.message === 'string' ? record.message : '',
    success: typeof record.success === 'boolean' ? record.success : undefined,
  };
}

function parseSseChunk(chunk: string): AdbInstallEvent | null {
  const dataLines = chunk
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  try {
    return normalizeInstallEvent(JSON.parse(dataLines.join('\n')));
  } catch {
    return null;
  }
}

function isFinalInstallEvent(event: AdbInstallEvent): boolean {
  return event.stage === 'finished' || event.stage === 'failed' || event.success !== undefined;
}

export async function installAdbPackageStream(
  deviceId: string,
  packageUrl: string,
  onEvent: (event: AdbInstallEvent) => void,
  signal?: AbortSignal,
): Promise<AdbInstallEvent> {
  let response: Response;
  try {
    response = await fetch(`${ADB_API_BASE_URL}${ADB_INSTALL_STREAM_ENDPOINT_PATH}`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_id: deviceId,
        package_url: packageUrl,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (await probeAdbService()) {
      throw new Error('本地adb服务已响应，但安装请求被浏览器拦截；请确认已重启并运行支持跨域/PNA、POST/OPTIONS/SSE的新版ADB工具');
    }
    throw new AdbServiceUnavailableError();
  }

  if (!response.ok || !response.body) {
    throw new Error(await readAdbErrorMessage(response));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/u);
      buffer = chunks.pop() ?? '';

      for (const chunk of chunks) {
        const event = parseSseChunk(chunk);
        if (!event) {
          continue;
        }

        onEvent(event);
        if (isFinalInstallEvent(event)) {
          return event;
        }
      }
    }

    const trailingEvent = buffer.trim() ? parseSseChunk(buffer) : null;
    if (trailingEvent) {
      onEvent(trailingEvent);
      if (isFinalInstallEvent(trailingEvent)) {
        return trailingEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error('安装进度连接已中断');
}
