/**
 * Спільні допоміжні засоби тестів: тимчасовий екземпляр застосунку й тестовий WebSocket-клієнт.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/index.js';
import { createLogger } from '../src/logger.js';

/**
 * Запускає застосунок на вільному порту з тимчасовими каталогами.
 * @param {Record<string, string>} [env] перевизначення змінних середовища
 */
export async function startTestApp(env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dogfight-test-'));
  const staticDir = path.join(dir, 'static');
  await mkdir(staticDir, { recursive: true });

  const config = loadConfig(
    {
      PORT: '0',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_DIR: path.join(dir, 'logs'),
      STATIC_DIR: staticDir,
      ...env,
    },
    dir,
  );
  const app = createApp(config, { logger: createLogger({ level: 'silent' }) });
  await app.start();
  const { port } = app.address;

  return {
    app,
    config,
    dir,
    staticDir,
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async stop() {
      await app.shutdown('test');
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Тестовий клієнт: накопичує повідомлення й дозволяє чекати конкретне.
 * @returns {Promise<{ socket: WebSocket, send: Function, raw: Function, next: Function, closed: Promise<{code: number, reason: string}> }>}
 */
export function openClient(wsUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, options);
    const inbox = [];
    const waiters = [];

    const closed = new Promise((resolveClosed) => {
      socket.on('close', (code, reason) => {
        for (const waiter of waiters.splice(0))
          waiter.reject(new Error(`сокет закрито (${code}) під час очікування`));
        resolveClosed({ code, reason: reason.toString() });
      });
    });
    closed.catch(() => {});

    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const index = waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
      else inbox.push(message);
    });

    const client = {
      socket,
      inbox,
      closed,
      send: (object) => socket.send(JSON.stringify(object)),
      raw: (data, options2) => socket.send(data, options2),
      /** Чекає повідомлення, що відповідає типу (рядок) або предикату. */
      next(match, timeoutMs = 2000) {
        const predicate = typeof match === 'string' ? (message) => message.type === match : match;
        const index = inbox.findIndex(predicate);
        if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
        return new Promise((resolveNext, rejectNext) => {
          const waiter = { match: predicate, resolve: resolveNext, reject: rejectNext };
          waiters.push(waiter);
          setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) {
              waiters.splice(at, 1);
              rejectNext(new Error(`таймаут очікування повідомлення ${String(match)}`));
            }
          }, timeoutMs).unref();
        });
      },
    };

    socket.once('open', () => resolve(client));
    socket.once('error', reject);
  });
}

/** Створює кімнату напряму через менеджер. */
export function makeRoom(app, overrides = {}) {
  return app.rooms.create({
    name: 'Test Room',
    map: 'Open Space',
    mode: 'Sandbox',
    maxPlayers: 8,
    arena: {},
    ...overrides,
  });
}

export const join = (client, room, nickname) => client.send({ v: 1, type: 'join', room, nickname });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
