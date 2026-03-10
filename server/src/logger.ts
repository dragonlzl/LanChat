import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

type LogDetails = Record<string, unknown>;

const loggerState: { logDir: string | null } = {
  logDir: null,
};

function stringifyValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (typeof value === 'string') {
    return /[\s=]/.test(value) ? JSON.stringify(value) : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatDetails(details?: LogDetails): string {
  if (!details || Object.keys(details).length === 0) {
    return '';
  }

  return Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${stringifyValue(value)}`)
    .join(' ');
}

function getLogPaths(timestamp: string) {
  if (!loggerState.logDir) {
    return null;
  }

  const day = timestamp.slice(0, 10);
  return {
    app: resolve(loggerState.logDir, `app-${day}.log`),
    error: resolve(loggerState.logDir, `error-${day}.log`),
  };
}

function appendToFile(filePath: string, line: string) {
  try {
    appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (error) {
    const fallback = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[${new Date().toISOString()}] [ERROR] [logger] 写入日志文件失败 file=${filePath} error=${JSON.stringify(fallback)}`);
  }
}

function emitToConsole(level: LogLevel, line: string) {
  if (level === 'ERROR') {
    console.error(line);
    return;
  }

  if (level === 'WARN') {
    console.warn(line);
    return;
  }

  console.log(line);
}

export function configureLogger(logDir: string) {
  const resolvedDir = resolve(logDir);

  try {
    mkdirSync(resolvedDir, { recursive: true });
    loggerState.logDir = resolvedDir;
  } catch (error) {
    loggerState.logDir = null;
    const reason = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[${new Date().toISOString()}] [ERROR] [logger] 初始化日志目录失败 logDir=${JSON.stringify(resolvedDir)} error=${JSON.stringify(reason)}`);
  }
}

function writeLog(level: LogLevel, scope: string, message: string, details?: LogDetails) {
  const timestamp = new Date().toISOString();
  const suffix = formatDetails(details);
  const line = suffix
    ? `[${timestamp}] [${level}] [${scope}] ${message} ${suffix}`
    : `[${timestamp}] [${level}] [${scope}] ${message}`;

  emitToConsole(level, line);

  const paths = getLogPaths(timestamp);
  if (!paths) {
    return;
  }

  appendToFile(paths.app, line);
  if (level === 'ERROR') {
    appendToFile(paths.error, line);
  }
}

export function logInfo(scope: string, message: string, details?: LogDetails) {
  writeLog('INFO', scope, message, details);
}

export function logWarn(scope: string, message: string, details?: LogDetails) {
  writeLog('WARN', scope, message, details);
}

export function logError(scope: string, message: string, details?: LogDetails) {
  writeLog('ERROR', scope, message, details);
}
