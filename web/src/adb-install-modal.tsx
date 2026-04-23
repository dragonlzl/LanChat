import { useMemo, useState } from 'react';
import {
  installAdbPackageStream,
  isAdbServiceUnavailableError,
  type AdbDevice,
  type AdbInstallEvent,
  type AdbInstallStage,
} from './adb-client';

interface AdbInstallModalProps {
  packageName: string;
  packageUrl: string;
  devices: AdbDevice[];
  onClose: () => void;
}

type AdbInstallModalMode = 'select-device' | 'install-progress';

const DEVICE_INFO_LABELS: Array<{ key: string; label: string }> = [
  { key: 'manufacturer', label: '厂商' },
  { key: 'model', label: '型号' },
  { key: 'android_version', label: 'Android 版本' },
  { key: 'cpu', label: 'CPU' },
  { key: 'max_mem_gb', label: '最大内存' },
  { key: 'battery_status', label: '电池状态' },
  { key: 'battery_level_percent', label: '电量' },
  { key: 'battery_temperature_c', label: '电池温度' },
  { key: 'resolution', label: '分辨率' },
  { key: 'ip', label: 'IP' },
];
const EMPTY_DEVICE_INFO_VALUE = '暂无';

function formatDeviceValue(key: string, value: unknown): string {
  if (value === undefined || value === null) {
    return EMPTY_DEVICE_INFO_VALUE;
  }
  if (typeof value === 'string') {
    const normalizedValue = value.trim();
    return normalizedValue || EMPTY_DEVICE_INFO_VALUE;
  }

  if (key === 'max_mem_gb' && typeof value === 'number') {
    return `${value.toFixed(2)} GB`;
  }
  if (key === 'battery_level_percent' && typeof value === 'number') {
    return `${value}%`;
  }
  if (key === 'battery_temperature_c' && typeof value === 'number') {
    return `${value.toFixed(1)} ℃`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    const serializedValue = JSON.stringify(value);
    return serializedValue && serializedValue !== '{}' && serializedValue !== '[]'
      ? serializedValue
      : EMPTY_DEVICE_INFO_VALUE;
  } catch {
    return String(value);
  }
}

function getDeviceInfoRows(device: AdbDevice): Array<{ label: string; value: string }> {
  const knownKeys = new Set(DEVICE_INFO_LABELS.map((item) => item.key));
  const rows: Array<{ label: string; value: string }> = [
    { label: '设备 ID', value: device.device_id },
    { label: '连接状态', value: device.state },
  ];

  for (const item of DEVICE_INFO_LABELS) {
    const value = formatDeviceValue(item.key, device.device_info[item.key]);
    rows.push({ label: item.label, value });
  }

  for (const [key, rawValue] of Object.entries(device.device_info)) {
    if (knownKeys.has(key)) {
      continue;
    }

    const value = formatDeviceValue(key, rawValue);
    rows.push({ label: key, value });
  }

  return rows;
}

function getInstallStageLabel(stage: AdbInstallStage | null): string {
  if (stage === 'downloading') {
    return '下载中';
  }
  if (stage === 'installing') {
    return '安装中';
  }
  if (stage === 'finished') {
    return '安装完成';
  }
  if (stage === 'failed') {
    return '安装失败';
  }
  return '准备安装';
}

function clampProgressPercent(percent: number | null | undefined): number | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(percent)));
}

function getInstallErrorMessage(error: unknown): string {
  if (isAdbServiceUnavailableError(error)) {
    return '本地adb服务未开启';
  }
  return error instanceof Error && error.message.trim() ? error.message : '安装失败';
}

export function AdbInstallModal({ packageName, packageUrl, devices, onClose }: AdbInstallModalProps) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [mode, setMode] = useState<AdbInstallModalMode>('select-device');
  const [progress, setProgress] = useState<AdbInstallEvent | null>(null);
  const selectedDevice = useMemo(
    () => devices.find((device) => device.device_id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );
  const progressPercent = clampProgressPercent(progress?.percent);
  const installFinished = Boolean(progress && (progress.stage === 'finished' || progress.stage === 'failed' || progress.success !== undefined));
  const installFailed = Boolean(progress && (progress.stage === 'failed' || progress.success === false));
  const installBusy = mode === 'install-progress' && !installFinished;
  const canClose = !installBusy;

  async function handleStartInstall() {
    if (!selectedDevice || installBusy) {
      return;
    }

    const initialProgress: AdbInstallEvent = {
      device_id: selectedDevice.device_id,
      stage: 'downloading',
      percent: 0,
      message: '准备下载安装包…',
    };

    setMode('install-progress');
    setProgress(initialProgress);

    try {
      const result = await installAdbPackageStream(selectedDevice.device_id, packageUrl, setProgress);
      setProgress(result);
    } catch (error) {
      setProgress({
        device_id: selectedDevice.device_id,
        stage: 'failed',
        percent: null,
        message: getInstallErrorMessage(error),
        success: false,
      });
    }
  }

  return (
    <div className="modal-backdrop" onClick={canClose ? onClose : undefined}>
      <div className="modal-card adb-install-modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="section-head align-start">
          <div>
            <h3>{mode === 'select-device' ? '选择安装设备' : '安装包体'}</h3>
            <p>{packageName}</p>
          </div>
          <button
            className="modal-close-button"
            type="button"
            onClick={onClose}
            disabled={!canClose}
            aria-label="关闭弹窗"
            title={canClose ? '关闭' : '安装进行中，完成后可关闭'}
          >
            ×
          </button>
        </div>

        {mode === 'select-device' ? (
          <div className="adb-install-body">
            <div className="adb-install-package-url" title={packageUrl}>{packageUrl}</div>
            <div className="adb-device-picker-layout">
              <aside className="adb-device-list" aria-label="ADB 设备列表">
                {devices.length > 0 ? devices.map((device) => {
                  const selected = selectedDeviceId === device.device_id;
                  return (
                    <button
                      key={device.device_id}
                      className={`adb-device-option${selected ? ' adb-device-option-selected' : ''}`}
                      type="button"
                      onClick={() => setSelectedDeviceId(device.device_id)}
                      aria-pressed={selected}
                    >
                      <strong>{device.device_id}</strong>
                      <span>{device.state}</span>
                    </button>
                  );
                }) : (
                  <div className="empty-state adb-device-empty">未检测到已连接 Android 设备。</div>
                )}
              </aside>

              <section className="adb-device-detail">
                {selectedDevice ? (
                  <>
                    <div className="adb-device-detail-head">
                      <strong>{selectedDevice.device_id}</strong>
                      <span>{selectedDevice.state}</span>
                    </div>
                    <div className="adb-device-info-grid">
                      {getDeviceInfoRows(selectedDevice).map((row) => (
                        <div key={`${row.label}-${row.value}`} className="adb-device-info-row">
                          <span>{row.label}</span>
                          <strong>{row.value}</strong>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="empty-state adb-device-empty">请先从左侧选择一个设备。</div>
                )}
              </section>
            </div>
          </div>
        ) : (
          <div className="adb-install-progress-panel">
            <div className={`adb-install-result-card${installFailed ? ' adb-install-result-card-failed' : ''}`}>
              <span>{getInstallStageLabel(progress?.stage ?? null)}</span>
              <strong>{progressPercent !== null ? `${progressPercent}%` : '未知'}</strong>
            </div>
            <div className="adb-install-progress-track" aria-hidden="true">
              <div
                className={`adb-install-progress-fill${progressPercent === null ? ' adb-install-progress-fill-unknown' : ''}${installFailed ? ' adb-install-progress-fill-failed' : ''}`}
                style={{ width: `${progressPercent ?? 100}%` }}
              />
            </div>
            <div className="adb-install-progress-message">
              <strong>{progress?.device_id ?? selectedDevice?.device_id}</strong>
              <span>{progress?.message || '等待安装进度…'}</span>
            </div>
          </div>
        )}

        <div className="modal-actions adb-install-actions">
          {mode === 'select-device' ? (
            <>
              <button className="secondary-button" type="button" onClick={onClose}>
                取消
              </button>
              <button className="primary-button" type="button" onClick={() => void handleStartInstall()} disabled={!selectedDevice}>
                开始安装
              </button>
            </>
          ) : (
            <button className="primary-button" type="button" onClick={onClose} disabled={!canClose}>
              {installFinished ? '关闭' : '安装中…'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
