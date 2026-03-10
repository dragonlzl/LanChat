import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './types.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export function parseConfig(argv: string[] = process.argv.slice(2)): AppConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string', default: '0.0.0.0' },
      port: { type: 'string', default: '3000' },
      'data-dir': { type: 'string', default: './data' },
    },
    allowPositionals: false,
  });

  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${values.port}`);
  }

  const baseDirectory = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : process.cwd();
  const dataDir = resolve(baseDirectory, values['data-dir']);
  const uploadsDir = resolve(dataDir, 'uploads');
  const logsDir = resolve(dataDir, 'logs');
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  return {
    host: values.host,
    port,
    dataDir,
    databasePath: resolve(dataDir, 'chat.sqlite'),
    uploadsDir,
    logsDir,
    webDistDir: resolve(currentDirectory, '../../web/dist'),
    allowDebugIp: process.env.NODE_ENV !== 'production',
  };
}
