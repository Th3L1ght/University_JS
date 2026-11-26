/**
 * Спільні допоміжні засоби тестів: тимчасовий екземпляр застосунку й тестовий WebSocket-клієнт.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { binaryCodec } from '@dogfight/shared';
import { WebSocket, type ClientOptions, type RawData } from 'ws';
import { loadConfig, type ServerConfig } from '../src/config.ts';
import { createApp, type AppInstance } from '../src/index.ts';
import { createLogger } from '../src/logger.ts';
import type { Room } from '../src/rooms.ts';

export interface TestEnv {
  readonly app: AppInstance;
  readonly config: ServerConfig;
  readonly dir: string;
  readonly staticDir: string;
  readonly port: number;
  readonly url: string;
  readonly wsUrl: string;
  stop(): Promise<void>;
}

export async function startTestApp(env: Record<string, string> = {}): Promise<TestEnv> {
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
  const address = app.address;
  if (!address || typeof address === 'string') {
    throw new Error('Очікується TCP-адреса сервера');
  }
  const { port } = address;

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

export type TestMessage = Record<string, unknown>;

export interface TestClient {
  readonly socket: WebSocket;
  readonly inbox: TestMessage[];
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  send(object: unknown): void;
  raw(data: string | Buffer | ArrayBuffer, options?: { readonly binary?: boolean }): void;
  next(match: string | ((m: TestMessage) => boolean), timeoutMs?: number): Promise<TestMessage>;
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function openClient(wsUrl: string, options: ClientOptions = {}): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, options);
    const inbox: TestMessage[] = [];
    const waiters: Array<{
      match: (m: TestMessage) => boolean;
      resolve: (m: TestMessage) => void;
      reject: (e: Error) => void;
    }> = [];

    const closed = new Promise<{ readonly code: number; readonly reason: string }>(
      (resolveClosed) => {
        socket.on('close', (code, reason) => {
          for (const waiter of waiters.splice(0)) {
            waiter.reject(new Error(`сокет закрито (${code}) під час очікування`));
          }
          resolveClosed({ code, reason: reason.toString() });
        });
      },
    );
    closed.catch(() => {});

    socket.on('message', (data, isBinary) => {
      const buf = rawToBuffer(data);
      const parsed: unknown = isBinary ? binaryCodec.decode(buf) : JSON.parse(buf.toString('utf8'));
      const message: TestMessage =
        parsed !== null && typeof parsed === 'object' ? { ...parsed } : { value: parsed };
      const index = waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) waiters.splice(index, 1)[0]?.resolve(message);
      else inbox.push(message);
    });

    const client: TestClient = {
      socket,
      inbox,
      closed,
      send: (object) => socket.send(JSON.stringify(object)),
      raw: (data, options2) => socket.send(data, options2 ?? {}),
      next(match, timeoutMs = 2000) {
        const predicate = typeof match === 'string' ? (m: TestMessage) => m.type === match : match;
        const index = inbox.findIndex(predicate);
        if (index >= 0) {
          const hit = inbox.splice(index, 1)[0];
          if (hit) return Promise.resolve(hit);
        }
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

export function makeRoom(
  app: AppInstance,
  overrides: Partial<{
    name: string;
    map: string;
    mode: string;
    maxPlayers: number;
    arena: Record<string, number>;
  }> = {},
): Room {
  return app.rooms.create({
    name: 'Test Room',
    map: 'Open Space',
    mode: 'Sandbox',
    maxPlayers: 8,
    arena: {},
    ...overrides,
  });
}

export const join = (client: TestClient, room: string, nickname: string): void =>
  client.send({ v: 1, type: 'join', room, nickname });

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
