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
import { RoomManager } from './rooms.ts';
import { attachWebSocketServer, type WsServerHandle } from './ws.ts';

export interface AppInstance {
  readonly server: http.Server;
  readonly rooms: RoomManager;
  readonly matches: MatchManager;
  readonly ws: WsServerHandle;
  start(): Promise<AddressInfo | string | null>;
  shutdown(reason?: string): Promise<void>;
  readonly address: AddressInfo | string | null;
}

export function createApp(
  config: ServerConfig,
  { logger = createLogger() }: { readonly logger?: Logger } = {},
): AppInstance {
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
    const log = createMatchLog({
      dir: config.logDir,
      roomId: room.id,
      onError: (error) => logger.error('помилка журналу матчу', { room: room.id, error }),
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
      .catch((error: unknown) =>
        logger.error('помилка завершення журналу', { room: roomId, error }),
      );
    finishing.add(done);
    void done.finally(() => finishing.delete(done));
  }

  let ws: WsServerHandle | null = null;
  const server = http.createServer(
    createRequestHandler({
      config,
      rooms,
      logger,
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
  ws = attachWebSocketServer({ server, rooms, matches, config, logger });

  async function start(): Promise<AddressInfo | string | null> {
    await mkdir(config.logDir, { recursive: true });
    if (config.serveStatic) {
      try {
        await stat(config.staticDir);
      } catch {
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
    logger.info('сервер запущено', { address, env: config.nodeEnv, logDir: config.logDir });
    return address;
  }

  let shutdownPromise: Promise<void> | null = null;
  function shutdown(reason = 'shutdown'): Promise<void> {
    shutdownPromise ??= (async () => {
      logger.info('graceful shutdown: початок', { reason });
      const timeoutMs = config.limits.shutdownTimeoutMs;

      const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();

      matches.close();
      await ws?.close({ timeoutMs });
      rooms.destroy();
      for (const roomId of [...logs.keys()]) finishLog(roomId);
      await Promise.allSettled([...finishing]);

      const force = setTimeout(() => {
        logger.warn('graceful shutdown: примусово закриваю залишкові з’єднання');
        server.closeAllConnections();
      }, timeoutMs);
      await httpClosed;
      clearTimeout(force);
      logger.info('graceful shutdown: завершено');
    })();
    return shutdownPromise;
  }

  return {
    server,
    rooms,
    matches,
    ws,
    start,
    shutdown,
    get address() {
      return server.address();
    },
  };
}

async function main(): Promise<void> {
  const logger = createLogger();

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

  const app = createApp(config, { logger });

  const fatal = (kind: string) => (error: unknown) => {
    logger.error(`фатальна помилка: ${kind}`, { error });
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
