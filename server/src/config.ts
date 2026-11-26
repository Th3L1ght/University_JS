/**
 * Завантаження й перевірка конфігурації зі змінних середовища через Zod.
 * Усі помилки збираються разом і викидаються одним ConfigError. Результат заморожено.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Некоректна конфігурація:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const intEnv = (name: string, fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw === '' ? String(fallback) : raw.trim()))
    .refine((s) => /^-?\d+$/.test(s), {
      error: `${name} має бути цілим числом`,
    })
    .transform((s) => Number(s))
    .refine((n) => n >= min && n <= max, {
      error: `${name} має бути від ${min} до ${max}`,
    });

const RawEnvSchema = z.object({
  NODE_ENV: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'production' : v))
    .pipe(
      z.enum(['development', 'production', 'test'], {
        error: 'NODE_ENV має бути development, production або test',
      }),
    ),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'info' : v.toLowerCase()))
    .pipe(
      z.enum(['debug', 'info', 'warn', 'error', 'silent'], {
        error: 'LOG_LEVEL має бути debug, info, warn, error або silent',
      }),
    ),
  APP_VERSION: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? '1.0.0' : v.trim())),
  HOST: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? '0.0.0.0' : v))
    .refine((v) => !/\s/.test(v), { error: 'HOST не може містити пробіли' }),
  PORT: intEnv('PORT', 3000, 0, 65535),
  LOG_DIR: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? './logs' : v)),
  STATIC_DIR: z.string().optional(),
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? []
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    ),
  MAX_ROOMS: intEnv('MAX_ROOMS', 20, 1, 1000),
  MAX_PLAYERS_PER_ROOM: intEnv('MAX_PLAYERS_PER_ROOM', 8, 2, 64),
  MAX_CONNECTIONS: intEnv('MAX_CONNECTIONS', 200, 1, 100000),
  MAX_CONNECTIONS_PER_IP: intEnv('MAX_CONNECTIONS_PER_IP', 10, 1, 1000),
  MAX_BODY_BYTES: intEnv('MAX_BODY_BYTES', 4096, 64, 1048576),
  EMPTY_ROOM_TTL_MS: intEnv('EMPTY_ROOM_TTL_MS', 60000, 10, 86400000),
  SHUTDOWN_TIMEOUT_MS: intEnv('SHUTDOWN_TIMEOUT_MS', 5000, 10, 120000),
  WS_MAX_PAYLOAD: intEnv('WS_MAX_PAYLOAD', 16 * 1024, 256, 1048576),
  AUTH_TIMEOUT_MS: intEnv('AUTH_TIMEOUT_MS', 5000, 10, 60000),
  HEARTBEAT_MS: intEnv('HEARTBEAT_MS', 15000, 10, 300000),
  MAX_BUFFERED_BYTES: intEnv('MAX_BUFFERED_BYTES', 1024 * 1024, 1024, 67108864),
  RATE_LIMIT_PER_SEC: intEnv('RATE_LIMIT_PER_SEC', 20, 1, 1000),
  RATE_LIMIT_BURST: intEnv('RATE_LIMIT_BURST', 40, 1, 10000),
  INPUT_RATE_LIMIT_PER_SEC: intEnv('INPUT_RATE_LIMIT_PER_SEC', 90, 1, 10000),
  INPUT_RATE_LIMIT_BURST: intEnv('INPUT_RATE_LIMIT_BURST', 180, 1, 100000),
  NETSIM_ENABLED: intEnv('NETSIM_ENABLED', 1, 0, 1),
});

export interface ServerConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  readonly appVersion: string;
  readonly host: string;
  readonly port: number;
  readonly serveStatic: boolean;
  readonly logDir: string;
  readonly staticDir: string;
  readonly allowedOrigins: readonly string[];
  readonly limits: {
    readonly maxRooms: number;
    readonly maxPlayersPerRoom: number;
    readonly maxConnections: number;
    readonly maxConnectionsPerIp: number;
    readonly maxBodyBytes: number;
    readonly emptyRoomTtlMs: number;
    readonly shutdownTimeoutMs: number;
  };
  readonly ws: {
    readonly maxPayload: number;
    readonly authTimeoutMs: number;
    readonly heartbeatMs: number;
    readonly maxBufferedBytes: number;
    readonly rateLimitPerSec: number;
    readonly rateLimitBurst: number;
    readonly inputRateLimitPerSec: number;
    readonly inputRateLimitBurst: number;
    readonly netsimEnabled: boolean;
  };
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message));
  }
  const d = parsed.data;
  return Object.freeze({
    nodeEnv: d.NODE_ENV,
    logLevel: d.LOG_LEVEL,
    appVersion: d.APP_VERSION,
    host: d.HOST,
    port: d.PORT,
    serveStatic: d.NODE_ENV !== 'development',
    logDir: path.resolve(cwd, d.LOG_DIR),
    staticDir: path.resolve(cwd, d.STATIC_DIR || path.join(REPO_ROOT, 'client/dist')),
    allowedOrigins: Object.freeze([...d.ALLOWED_ORIGINS]),
    limits: Object.freeze({
      maxRooms: d.MAX_ROOMS,
      maxPlayersPerRoom: d.MAX_PLAYERS_PER_ROOM,
      maxConnections: d.MAX_CONNECTIONS,
      maxConnectionsPerIp: d.MAX_CONNECTIONS_PER_IP,
      maxBodyBytes: d.MAX_BODY_BYTES,
      emptyRoomTtlMs: d.EMPTY_ROOM_TTL_MS,
      shutdownTimeoutMs: d.SHUTDOWN_TIMEOUT_MS,
    }),
    ws: Object.freeze({
      maxPayload: d.WS_MAX_PAYLOAD,
      authTimeoutMs: d.AUTH_TIMEOUT_MS,
      heartbeatMs: d.HEARTBEAT_MS,
      maxBufferedBytes: d.MAX_BUFFERED_BYTES,
      rateLimitPerSec: d.RATE_LIMIT_PER_SEC,
      rateLimitBurst: d.RATE_LIMIT_BURST,
      inputRateLimitPerSec: d.INPUT_RATE_LIMIT_PER_SEC,
      inputRateLimitBurst: d.INPUT_RATE_LIMIT_BURST,
      netsimEnabled: d.NETSIM_ENABLED === 1,
    }),
  });
}
