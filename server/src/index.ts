/**
 * Точка входу сервера: HTTP, WebSocket, кімнати, авторитативні матчі, журнали, graceful shutdown.
 */

import { realpathSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig, type ServerConfig } from './config.ts';
import { createRequestHandler } from './http.ts';
import { createMatchLog, type MatchLog } from './log/matchlog.ts';
import { createLogger, type Logger } from './logger.ts';
import { MatchManager } from './match.ts';
import { createMetrics, type MetricsCollector } from './metrics.ts';
import { RoomManager } from './rooms.ts';
import { attachWebSocketServer, type WsServerHandle } from './ws.ts';

export interface AppInstance {
  readonly server: http.Server;
  readonly rooms: RoomManager;
  readonly matches: MatchManager;
  readonly ws: WsServerHandle;
  readonly metrics: MetricsCollector;
  start(): Promise<AddressInfo | string | null>;
  shutdown(reason?: string): Promise<void>;
  readonly address: AddressInfo | string | null;
}

export function createApp(
  config: ServerConfig,
  { logger = createLogger({ level: config.logLevel }) }: { readonly logger?: Logger } = {},
): AppInstance {
  const metrics = createMetrics();
  let shuttingDown = false;
  let staticReady = !config.serveStatic;

  const rooms = new RoomManager({
    maxRooms: config.limits.maxRooms,
    maxPlayersPerRoom: config.limits.maxPlayersPerRoom,
    emptyRoomTtlMs: config.limits.emptyRoomTtlMs,
  });

  const matches = new MatchManager({ logger });
  rooms.on('removed', (room) => matches.remove(room.id));

  const logs = new Map<string, MatchLog>();
  const finishing = new Set<Promise<void>>();

  rooms.on('created', (room) => {
    logger.info('room.created', {
      roomId: room.id,
      mode: room.mode,
      maxPlayers: room.maxPlayers,
    });
    const log = createMatchLog({
      dir: config.logDir,
      roomId: room.id,
      onError: (error) => logger.error('помилка журналу матчу', { roomId: room.id, error }),
    });
    room.replayId = log.id;
    logs.set(room.id, log);
    log.write({
      type: 'start',
      room: {
        id: room.id,
        name: room.name,
        map: room.map,
        mode: room.mode,
        maxPlayers: room.maxPlayers,
        arena: room.arena,
      },
    });
    room.on('event', (record) => log.write({ ...record }));
  });

  rooms.on('removed', (room) => finishLog(room.id));

  function finishLog(roomId: string): void {
    const log = logs.get(roomId);
    if (!log) return;
    logs.delete(roomId);
    log.write({ type: 'end' });
    const done = log
      .end()
      .catch((error: unknown) => logger.error('помилка завершення журналу', { roomId, error }));
    finishing.add(done);
    void done.finally(() => finishing.delete(done));
  }

  let ws: WsServerHandle | null = null;
  const server = http.createServer(
    createRequestHandler({
      config,
      rooms,
      logger,
      metrics,
      isReady: () => {
        if (shuttingDown) return { ready: false, reason: 'shutting_down' };
        if (config.serveStatic && !staticReady) {
          return { ready: false, reason: 'static_bundle_missing' };
        }
        return { ready: true };
      },
      addBots: (room, count) => matches.addBots(room, count),
      stats: () => ({ connections: ws?.connections.size ?? 0, ...matches.stats() }),
    }),
  );
  server.on('clientError', (error: unknown, socket) => {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    logger.debug('clientError', { code });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  ws = attachWebSocketServer({ server, rooms, matches, config, logger, metrics });

  async function start(): Promise<AddressInfo | string | null> {
    await mkdir(config.logDir, { recursive: true });
    if (config.serveStatic) {
      try {
        await stat(config.staticDir);
        staticReady = true;
      } catch {
        staticReady = false;
        logger.warn('каталог зі статикою не знайдено (виконайте npm run build)', {
          staticDir: config.staticDir,
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    logger.info('server.started', {
      address,
      env: config.nodeEnv,
      version: config.appVersion,
      logDir: config.logDir,
    });
    return address;
  }

  let shutdownPromise: Promise<void> | null = null;
  function shutdown(reason = 'shutdown'): Promise<void> {
    shuttingDown = true;
    shutdownPromise ??= (async () => {
      logger.info('server.shutdown', { reason, phase: 'start' });
      const timeoutMs = config.limits.shutdownTimeoutMs;

      const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();

      matches.close();
      await ws?.close({ timeoutMs });
      rooms.destroy();
      for (const roomId of [...logs.keys()]) finishLog(roomId);
      await Promise.allSettled([...finishing]);

      const force = setTimeout(() => {
        logger.warn('server.shutdown', { reason, phase: 'force_close' });
        server.closeAllConnections();
      }, timeoutMs);
      await httpClosed;
      clearTimeout(force);
      logger.info('server.shutdown', { reason, phase: 'done' });
      logger.flush?.();
    })();
    return shutdownPromise;
  }

  return {
    server,
    rooms,
    matches,
    ws,
    metrics,
    start,
    shutdown,
    get address() {
      return server.address();
    },
  };
}

async function main(): Promise<void> {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });
  const app = createApp(config, { logger });

  const fatal = (kind: string) => (error: unknown) => {
    logger.error(`server.fatal`, {
      kind,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
    });
    logger.flush?.();
    setTimeout(() => process.exit(1), 3000).unref();
    void app.shutdown(kind).finally(() => process.exit(1));
  };
  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));

  let stopping = false;
  const onSignal = (signal: string): void => {
    if (stopping) {
      logger.warn('повторний сигнал: примусовий вихід', { signal });
      process.exit(1);
    }
    stopping = true;
    app.shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('помилка під час завершення', { error });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  await app.start();
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
if (isMain) await main();
