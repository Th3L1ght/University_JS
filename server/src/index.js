/**
 * Точка входу сервера. Збирає застосунок із частин (HTTP, WebSocket, кімнати, журнали матчів)
 * і керує життєвим циклом процесу: запуск, коректне завершення за SIGINT/SIGTERM, захист від
 * необроблених помилок.
 *
 * createApp() не має побічних ефектів до виклику start(), тож тести запускають кілька
 * незалежних екземплярів. main() виконується лише коли файл запущено напряму.
 */

import { realpathSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { createRequestHandler } from './http.js';
import { createMatchLog } from './log/matchlog.js';
import { createLogger } from './logger.js';
import { RoomManager } from './rooms.js';
import { attachWebSocketServer } from './ws.js';

/**
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{ logger?: ReturnType<typeof createLogger> }} [options]
 */
export function createApp(config, { logger = createLogger() } = {}) {
  const rooms = new RoomManager({
    maxRooms: config.limits.maxRooms,
    maxPlayersPerRoom: config.limits.maxPlayersPerRoom,
    emptyRoomTtlMs: config.limits.emptyRoomTtlMs,
  });

  // --- Журнали матчів: по одному потоку на кімнату ---
  const logs = new Map(); // roomId -> matchlog
  const finishing = new Set(); // проміси завершення журналів видалених кімнат

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
    // Універсальне подія "event" кімнати -> рядок NDJSON.
    room.on('event', (record) => log.write(record));
  });

  rooms.on('removed', (room) => finishLog(room.id));

  /** Дописує завершальний запис і закриває журнал кімнати (без повторів). */
  function finishLog(roomId) {
    const log = logs.get(roomId);
    if (!log) return;
    logs.delete(roomId);
    log.write({ type: 'end' });
    const done = log
      .end()
      .catch((error) => logger.error('помилка завершення журналу', { room: roomId, error }));
    finishing.add(done);
    done.finally(() => finishing.delete(done));
  }

  // --- HTTP і WebSocket ---
  let ws = null;
  const server = http.createServer(
    createRequestHandler({
      config,
      rooms,
      logger,
      stats: () => ({ connections: ws?.connections.size ?? 0 }),
    }),
  );
  // Некоректний HTTP від клієнта: відповідаємо 400 і закриваємо, процес не падає.
  server.on('clientError', (error, socket) => {
    logger.debug('clientError', { code: error.code });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  ws = attachWebSocketServer({ server, rooms, config, logger });

  async function start() {
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
    await new Promise((resolve, reject) => {
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

  /**
   * Коректне завершення:
   *  1. перестаємо приймати нові з'єднання;
   *  2. закриваємо активні WebSocket-клієнти (код 1001);
   *  3. завершуємо запис усіх журналів на диск;
   *  4. чекаємо закриття HTTP-з'єднань (з обмеженням у часі) і повертаємося - процес вийде з кодом 0.
   */
  let shutdownPromise = null;
  function shutdown(reason = 'shutdown') {
    shutdownPromise ??= (async () => {
      logger.info('graceful shutdown: початок', { reason });
      const timeoutMs = config.limits.shutdownTimeoutMs;

      const httpClosed = new Promise((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();

      await ws.close({ timeoutMs });
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
    ws,
    start,
    shutdown,
    get address() {
      return server.address();
    },
  };
}

/** Запуск як процесу: конфігурація, сигнали, захист від необроблених помилок. */
async function main() {
  const logger = createLogger();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }

  const app = createApp(config, { logger });

  // Політика "fail fast": необроблена помилка означає невідомий стан процесу. Логуємо причину,
  // намагаємося коректно завершитися (логи на диск) і виходимо з кодом 1 - рестарт за менеджером процесів.
  const fatal = (kind) => (error) => {
    logger.error(`фатальна помилка: ${kind}`, { error });
    setTimeout(() => process.exit(1), 3000).unref();
    app.shutdown(kind).finally(() => process.exit(1));
  };
  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));

  let stopping = false;
  const onSignal = (signal) => {
    if (stopping) {
      logger.warn('повторний сигнал: примусовий вихід', { signal });
      process.exit(1);
    }
    stopping = true;
    app.shutdown(signal).then(
      () => process.exit(0),
      (error) => {
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
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) await main();
