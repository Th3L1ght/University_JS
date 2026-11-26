/**
 * HTTP-шар на node:http (без фреймворків): REST API, стрімінг журналів матчів, статика з
 * захистом від path traversal. Обробник приймає залежності явно (config, rooms, logger).
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { validateRoomInput } from './protocol.js';
import { RoomError } from './rooms.js';

export const MIME_TYPES = Object.freeze({
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

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

// --- Відповіді ---

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff' };

export function sendJson(res, status, body, headers = {}) {
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

/** Клієнт обірвав завантаження - це не помилка сервера. */
const ignorePrematureClose = (error) => {
  if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
};

// --- Читання тіла запиту з обмеженням розміру ---

/**
 * Читає тіло запиту, не виходячи за `limit` байтів: надмірний запит відхиляється одразу, не
 * накопичуючи дані в пам'яті.
 */
export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'payload_too_large', `тіло запиту перевищує ${limit} байтів`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new HttpError(413, 'payload_too_large', `тіло запиту перевищує ${limit} байтів`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit) {
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

// --- Статичні файли ---

/**
 * Перетворює шлях із URL на абсолютний шлях усередині `rootDir` або повертає null, якщо файлу немає.
 * Захист від path traversal у три шари:
 *   1. після декодування шлях не може містити NUL і сегмент ".." (також із "\\"), інакше 403;
 *   2. результат path.resolve мусить лишатися всередині кореня;
 *   3. realpath (після розкриття симлінків) теж мусить лишатися всередині реального кореня.
 *
 * @param {string} rootDir абсолютний шлях до теки зі статикою
 * @param {string} pathname шлях із URL (ще закодований)
 */
export async function resolveStaticPath(rootDir, pathname) {
  let decoded;
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

  let real;
  let realRoot;
  try {
    realRoot = await realpath(rootDir);
    real = await realpath(candidate);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new HttpError(403, 'forbidden', 'символічне посилання виходить за межі каталогу');
  }
  return real;
}

async function serveStatic(req, res, { config, logger }, pathname) {
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

// --- Журнали матчів ---

/** GET /api/replays/:id - віддає файл журналу потоком, без завантаження в пам'ять. */
async function serveReplay(req, res, { config }, rawId) {
  let id;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    throw new HttpError(400, 'bad_replay_id', 'некоректне кодування id');
  }
  if (!REPLAY_ID_PATTERN.test(id))
    throw new HttpError(400, 'bad_replay_id', 'некоректний id журналу');

  const file = path.join(config.logDir, `${id}.ndjson`);
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'replay_not_found', 'журнал не знайдено');
    throw error;
  }
  if (!info.isFile()) throw new HttpError(404, 'replay_not_found', 'журнал не знайдено');

  res.writeHead(200, {
    'content-type': MIME_TYPES['.ndjson'],
    'content-length': info.size,
    'content-disposition': `inline; filename="${id}.ndjson"`,
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  if (info.size === 0) {
    res.end();
    return;
  }
  // end: журнал активного матчу може рости під час передачі - віддаємо рівно стільки, скільки обіцяли.
  // pipeline() передає backpressure: коли клієнт читає повільно, читання файлу призупиняється.
  await pipeline(createReadStream(file, { end: info.size - 1 }), res).catch(ignorePrematureClose);
}

// --- Маршрутизація ---

/**
 * @param {object} context
 * @param {object} context.config результат loadConfig()
 * @param {import('./rooms.js').RoomManager} context.rooms
 * @param {{ debug: Function, info: Function, warn: Function, error: Function }} context.logger
 * @param {() => { connections: number }} context.stats
 */
export function createRequestHandler(context) {
  const { config, rooms, logger, stats } = context;

  async function route(req, res) {
    // Працюємо із СИРИМ шляхом, а не з new URL().pathname: WHATWG URL мовчки схлопує "%2e%2e" і
    // "/../", і ми б не побачили спробу path traversal. Явна перевірка живе в resolveStaticPath.
    const target = req.url ?? '/';
    if (!target.startsWith('/'))
      throw new HttpError(400, 'bad_request', 'очікується шлях, що починається з "/"');
    const pathname = target.split(/[?#]/, 1)[0];

    if (pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw methodNotAllowed(res, 'GET, HEAD');
      const memory = process.memoryUsage();
      return sendJson(res, 200, {
        status: 'ok',
        uptimeSec: Math.round(process.uptime()),
        rooms: rooms.size,
        connections: stats().connections,
        memory: { rss: memory.rss, heapUsed: memory.heapUsed },
        node: process.version,
        env: config.nodeEnv,
      });
    }

    if (pathname === '/api/rooms') {
      if (req.method === 'GET') return sendJson(res, 200, { rooms: rooms.list() });
      if (req.method === 'POST') return createRoom(req, res);
      throw methodNotAllowed(res, 'GET, POST');
    }

    const replay = /^\/api\/replays\/([^/]+)$/.exec(pathname);
    if (replay) {
      if (req.method !== 'GET') throw methodNotAllowed(res, 'GET');
      return serveReplay(req, res, context, replay[1]);
    }

    if (pathname === '/ws') {
      throw new HttpError(426, 'upgrade_required', 'цей шлях приймає лише WebSocket');
    }

    if (pathname.startsWith('/api/'))
      throw new HttpError(404, 'not_found', 'невідомий API-маршрут');
    if (config.serveStatic) return serveStatic(req, res, context, pathname);
    throw new HttpError(404, 'not_found', 'не знайдено (режим розробки: клієнт віддає Vite)');
  }

  function methodNotAllowed(res, allow) {
    res.setHeader('allow', allow);
    return new HttpError(405, 'method_not_allowed', `дозволені методи: ${allow}`);
  }

  async function createRoom(req, res) {
    const body = await readJson(req, config.limits.maxBodyBytes);
    const checked = validateRoomInput(body, { maxPlayersLimit: config.limits.maxPlayersPerRoom });
    if (!checked.ok) {
      return sendJson(res, 400, { error: 'validation_failed', details: checked.errors });
    }
    try {
      const room = rooms.create(checked.value);
      return sendJson(res, 201, room.toJSON(), { location: `/api/rooms/${room.id}` });
    } catch (error) {
      if (error instanceof RoomError && error.code === 'room_limit') {
        throw new HttpError(409, 'room_limit', error.message);
      }
      throw error;
    }
  }

  return async function handleRequest(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        if (res.headersSent) return res.destroy();
        const headers = {};
        if (error.status === 413) {
          // Клієнт може й далі слати тіло: закриваємо з'єднання після відповіді.
          headers.connection = 'close';
          res.on('finish', () => req.socket?.destroy());
        }
        return sendJson(res, error.status, { error: error.code, message: error.message }, headers);
      }
      logger.error('помилка обробки запиту', { method: req.method, url: req.url, error });
      if (res.headersSent) return res.destroy();
      return sendJson(res, 500, { error: 'internal_error', message: 'внутрішня помилка сервера' });
    }
  };
}
