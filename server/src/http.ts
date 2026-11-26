/**
 * HTTP-шар на node:http (без фреймворків): REST API, стрімінг журналів, статика з захистом
 * від path traversal.
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import { validateRoomInput } from '@dogfight/shared';
import type { BotInfo } from './bot.ts';
import type { ServerConfig } from './config.ts';
import type { Logger } from './logger.ts';
import type { MatchManagerSummary, MatchStats } from './match.ts';
import { RoomError, type Room, type RoomManager } from './rooms.ts';

export const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
});

const REPLAY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,120}$/;

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff' };

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(payload);
}

const ignorePrematureClose = (error: unknown): void => {
  if (errorCode(error) !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
};

export async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'payload_too_large', `тіло запиту перевищує ${limit} байтів`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limit) {
      throw new HttpError(413, 'payload_too_large', `тіло запиту перевищує ${limit} байтів`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'очікується Content-Type: application/json');
  }
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'тіло запиту не є коректним JSON');
  }
}

export async function resolveStaticPath(rootDir: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'bad_path', 'некоректне кодування шляху');
  }
  if (decoded.includes('\0')) throw new HttpError(400, 'bad_path', 'NUL у шляху');

  const segments = decoded.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) throw new HttpError(403, 'forbidden', 'вихід за межі каталогу');

  const candidate = path.resolve(rootDir, ...segments);
  if (candidate !== rootDir && !candidate.startsWith(rootDir + path.sep)) {
    throw new HttpError(403, 'forbidden', 'вихід за межі каталогу');
  }

  let real: string;
  let realRoot: string;
  try {
    realRoot = await realpath(rootDir);
    real = await realpath(candidate);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new HttpError(403, 'forbidden', 'символічне посилання виходить за межі каталогу');
  }
  return real;
}

export interface RequestContext {
  readonly config: ServerConfig;
  readonly rooms: RoomManager;
  readonly logger: Logger;
  readonly addBots?: (room: Room, count: number) => BotInfo[];
  readonly stats: () => {
    readonly connections: number;
    readonly matches: readonly MatchStats[];
    readonly summary: MatchManagerSummary;
  };
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { config, logger }: RequestContext,
  pathname: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'method_not_allowed', 'дозволені GET і HEAD');
  }

  let file = await resolveStaticPath(config.staticDir, pathname);
  if (file === null) throw new HttpError(404, 'not_found', 'файл не знайдено');
  let info = await stat(file);
  if (info.isDirectory()) {
    file = path.join(file, 'index.html');
    try {
      info = await stat(file);
    } catch {
      throw new HttpError(404, 'not_found', 'файл не знайдено');
    }
  }
  if (!info.isFile()) throw new HttpError(404, 'not_found', 'файл не знайдено');

  res.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'last-modified': info.mtime.toUTCString(),
    'cache-control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(file), res).catch(ignorePrematureClose);
  logger.debug('static', { file: path.relative(config.staticDir, file), bytes: info.size });
}

async function serveReplay(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  { config }: RequestContext,
  rawId: string,
): Promise<void> {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    throw new HttpError(400, 'bad_replay_id', 'некоректне кодування id');
  }
  if (!REPLAY_ID_PATTERN.test(id)) {
    throw new HttpError(400, 'bad_replay_id', 'некоректний id журналу');
  }

  const file = path.join(config.logDir, `${id}.ndjson`);
  let info;
  try {
    info = await stat(file);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      throw new HttpError(404, 'replay_not_found', 'журнал не знайдено');
    }
    throw error;
  }
  if (!info.isFile()) throw new HttpError(404, 'replay_not_found', 'журнал не знайдено');

  res.writeHead(200, {
    'content-type': MIME_TYPES['.ndjson'] ?? 'application/x-ndjson; charset=utf-8',
    'content-length': info.size,
    'content-disposition': `inline; filename="${id}.ndjson"`,
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  if (info.size === 0) {
    res.end();
    return;
  }
  await pipeline(createReadStream(file, { end: info.size - 1 }), res).catch(ignorePrematureClose);
}

export function createRequestHandler(
  context: RequestContext,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const { config, rooms, logger, stats } = context;

  function methodNotAllowed(res: http.ServerResponse, allow: string): HttpError {
    res.setHeader('allow', allow);
    return new HttpError(405, 'method_not_allowed', `дозволені методи: ${allow}`);
  }

  async function createRoom(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson(req, config.limits.maxBodyBytes);
    const checked = validateRoomInput(body, { maxPlayersLimit: config.limits.maxPlayersPerRoom });
    if (!checked.ok) {
      sendJson(res, 400, { error: 'validation_failed', details: checked.error });
      return;
    }
    try {
      const room = rooms.create(checked.data);
      sendJson(res, 201, room.toJSON(), { location: `/api/rooms/${room.id}` });
    } catch (error: unknown) {
      if (error instanceof RoomError && error.code === 'room_limit') {
        throw new HttpError(409, 'room_limit', error.message);
      }
      throw error;
    }
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = req.url ?? '/';
    if (!target.startsWith('/')) {
      throw new HttpError(400, 'bad_request', 'очікується шлях, що починається з "/"');
    }
    const pathname = target.split(/[?#]/, 1)[0] ?? '/';

    if (pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw methodNotAllowed(res, 'GET, HEAD');
      const memory = process.memoryUsage();
      const current = stats();
      sendJson(res, 200, {
        status: 'ok',
        uptimeSec: Math.round(process.uptime()),
        rooms: rooms.size,
        connections: current.connections,
        tick: current.summary,
        memory: { rss: memory.rss, heapUsed: memory.heapUsed },
        node: process.version,
        env: config.nodeEnv,
      });
      return;
    }

    if (pathname === '/api/stats') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw methodNotAllowed(res, 'GET, HEAD');
      const { connections, matches, summary } = stats();
      const elu = performance.eventLoopUtilization();
      sendJson(res, 200, {
        uptimeSec: Math.round(process.uptime()),
        connections,
        memory: process.memoryUsage(),
        eventLoopUtilization: {
          idle: Math.round(elu.idle * 100) / 100,
          active: Math.round(elu.active * 100) / 100,
          utilization: Math.round(elu.utilization * 10000) / 10000,
        },
        summary,
        matches,
      });
      return;
    }

    const botsRoute = /^\/api\/rooms\/([^/]+)\/bots$/.exec(pathname);
    if (botsRoute && botsRoute[1]) {
      if (req.method !== 'POST') throw methodNotAllowed(res, 'POST');
      const room = rooms.get(botsRoute[1]);
      if (!room) throw new HttpError(404, 'room_not_found', 'кімнату не знайдено');
      const body = await readJson(req, config.limits.maxBodyBytes);
      const count =
        body && typeof body === 'object' && 'count' in body && typeof body.count === 'number'
          ? body.count
          : 1;
      if (!Number.isInteger(count) || count < 1 || count > 16) {
        sendJson(res, 400, { error: 'validation_failed', details: ['count має бути цілим 1..16'] });
        return;
      }
      const added = context.addBots ? context.addBots(room, count) : [];
      sendJson(res, 201, { room: room.id, bots: added });
      return;
    }

    if (pathname === '/api/rooms') {
      if (req.method === 'GET') {
        sendJson(res, 200, { rooms: rooms.list() });
        return;
      }
      if (req.method === 'POST') {
        await createRoom(req, res);
        return;
      }
      throw methodNotAllowed(res, 'GET, POST');
    }

    const replay = /^\/api\/replays\/([^/]+)$/.exec(pathname);
    if (replay && replay[1]) {
      if (req.method !== 'GET') throw methodNotAllowed(res, 'GET');
      await serveReplay(req, res, context, replay[1]);
      return;
    }

    if (pathname === '/ws') {
      throw new HttpError(426, 'upgrade_required', 'цей шлях приймає лише WebSocket');
    }

    if (pathname.startsWith('/api/')) {
      throw new HttpError(404, 'not_found', 'невідомий API-маршрут');
    }
    if (config.serveStatic) {
      await serveStatic(req, res, context, pathname);
      return;
    }
    throw new HttpError(404, 'not_found', 'не знайдено (режим розробки: клієнт віддає Vite)');
  }

  return async function handleRequest(req, res): Promise<void> {
    try {
      await route(req, res);
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const headers: Record<string, string> = {};
        if (error.status === 413) {
          headers.connection = 'close';
          res.on('finish', () => req.socket?.destroy());
        }
        sendJson(res, error.status, { error: error.code, message: error.message }, headers);
        return;
      }
      logger.error('помилка обробки запиту', { method: req.method, url: req.url, error });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: 'internal_error', message: 'внутрішня помилка сервера' });
    }
  };
}
