/**
 * Завантаження й перевірка конфігурації з змінних середовища (process.env).
 * Усі помилки збираються разом і викидаються одним ConfigError, щоб за один запуск
 * видно було всі хибні значення. Результат заморожено.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// server/src/config.js -> корінь репозиторію - дві теки вгору
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export class ConfigError extends Error {
  constructor(problems) {
    super(`Некоректна конфігурація:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Ціле число з діапазону; порожнє значення дає `fallback`. */
function readInt(env, name, fallback, { min, max }, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    problems.push(`${name} має бути цілим числом, отримано "${raw}"`);
    return fallback;
  }
  const value = Number(raw);
  if (value < min || value > max) {
    problems.push(`${name} має бути від ${min} до ${max}, отримано ${value}`);
    return fallback;
  }
  return value;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [cwd] від якої теки рахувати відносні шляхи
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const problems = [];

  const nodeEnv = env.NODE_ENV || 'production';
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    problems.push(`NODE_ENV має бути development, production або test, отримано "${nodeEnv}"`);
  }

  const host = env.HOST || '0.0.0.0';
  if (/\s/.test(host)) problems.push(`HOST не може містити пробіли, отримано "${host}"`);

  const config = {
    nodeEnv,
    host,
    port: readInt(env, 'PORT', 3000, { min: 0, max: 65535 }, problems),
    // У режимі розробки клієнта віддає Vite, у решті випадків - цей сервер.
    serveStatic: nodeEnv !== 'development',
    logDir: path.resolve(cwd, env.LOG_DIR || './logs'),
    staticDir: path.resolve(cwd, env.STATIC_DIR || path.join(REPO_ROOT, 'client/dist')),
    limits: {
      maxRooms: readInt(env, 'MAX_ROOMS', 20, { min: 1, max: 1000 }, problems),
      maxPlayersPerRoom: readInt(env, 'MAX_PLAYERS_PER_ROOM', 8, { min: 2, max: 64 }, problems),
      maxConnections: readInt(env, 'MAX_CONNECTIONS', 200, { min: 1, max: 100000 }, problems),
      maxBodyBytes: readInt(env, 'MAX_BODY_BYTES', 4096, { min: 64, max: 1048576 }, problems),
      emptyRoomTtlMs: readInt(
        env,
        'EMPTY_ROOM_TTL_MS',
        60000,
        { min: 10, max: 86400000 },
        problems,
      ),
      shutdownTimeoutMs: readInt(
        env,
        'SHUTDOWN_TIMEOUT_MS',
        5000,
        { min: 10, max: 120000 },
        problems,
      ),
    },
    ws: {
      maxPayload: readInt(env, 'WS_MAX_PAYLOAD', 16 * 1024, { min: 256, max: 1048576 }, problems),
      authTimeoutMs: readInt(env, 'AUTH_TIMEOUT_MS', 5000, { min: 10, max: 60000 }, problems),
      heartbeatMs: readInt(env, 'HEARTBEAT_MS', 15000, { min: 10, max: 300000 }, problems),
      maxBufferedBytes: readInt(
        env,
        'MAX_BUFFERED_BYTES',
        1024 * 1024,
        { min: 1024, max: 67108864 },
        problems,
      ),
      rateLimitPerSec: readInt(env, 'RATE_LIMIT_PER_SEC', 20, { min: 1, max: 1000 }, problems),
      rateLimitBurst: readInt(env, 'RATE_LIMIT_BURST', 40, { min: 1, max: 10000 }, problems),
      // Ігровий трафік (бінарні кадри вводу й ping) має власне відро: 30 Гц вводу + запас.
      inputRateLimitPerSec: readInt(
        env,
        'INPUT_RATE_LIMIT_PER_SEC',
        90,
        { min: 1, max: 10000 },
        problems,
      ),
      inputRateLimitBurst: readInt(
        env,
        'INPUT_RATE_LIMIT_BURST',
        180,
        { min: 1, max: 100000 },
        problems,
      ),
      // 1 - дозволити емуляцію мережі (latency/jitter/drop) через /ws?... і повідомлення netsim.
      netsimEnabled: readInt(env, 'NETSIM_ENABLED', 1, { min: 0, max: 1 }, problems) === 1,
    },
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze({
    ...config,
    limits: Object.freeze(config.limits),
    ws: Object.freeze(config.ws),
  });
}
