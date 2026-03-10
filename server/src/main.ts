import { networkInterfaces } from 'node:os';
import { createChatApp } from './app.js';
import { parseConfig } from './config.js';
import { configureLogger, logError, logInfo, logWarn } from './logger.js';

function collectUrls(host: string, port: number): string[] {
  if (host !== '0.0.0.0' && host !== '::') {
    return [`http://${host}:${port}`];
  }

  const addresses = new Set<string>([`http://localhost:${port}`]);
  const interfaces = networkInterfaces();

  for (const values of Object.values(interfaces)) {
    for (const value of values ?? []) {
      if (value.family === 'IPv4' && !value.internal) {
        addresses.add(`http://${value.address}:${port}`);
      }
    }
  }

  return Array.from(addresses);
}

async function main() {
  const config = parseConfig();
  configureLogger(config.logsDir);

  process.on('unhandledRejection', (reason) => {
    logError('process', '未处理的 Promise 拒绝', { error: reason });
  });

  const { httpServer, close } = createChatApp(config);
  let closing = false;

  const shutdown = async (signal: string) => {
    if (closing) {
      return;
    }

    closing = true;
    logWarn('process', '收到退出信号，准备关闭服务', { signal });

    try {
      await close();
    } catch (error) {
      logError('process', '关闭服务失败', { signal, error });
      process.exitCode = 1;
      return;
    }

    process.exitCode = 0;
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  logInfo('startup', '局域网聊天服务已启动', {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    logsDir: config.logsDir,
  });

  for (const url of collectUrls(config.host, config.port)) {
    logInfo('startup', '访问地址', { url });
  }
}

main().catch((error) => {
  logError('startup', '服务启动失败', { error });
  process.exitCode = 1;
});
