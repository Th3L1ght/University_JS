/**
 * Структурований JSON-логер на базі pino (вивід у stdout, керується LOG_LEVEL).
 * Чутливі поля (authorization, cookie, password, token, text) автоматично приховуються.
 */

import pino, { type DestinationStream } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  flush?(): void;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly destination?: DestinationStream;
}

export function createLogger({ level = 'info', destination }: LoggerOptions = {}): Logger {
  const instance = pino(
    {
      level,
      base: { service: 'dogfight-server' },
      redact: {
        paths: ['authorization', 'cookie', 'password', 'token', 'secret', 'chatText'],
        censor: '[REDACTED]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );

  const emit = (
    fn: (obj: Record<string, unknown>, msg: string) => void,
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (fields) fn(fields, message);
    else fn({}, message);
  };

  return {
    debug: (message, fields) => emit(instance.debug.bind(instance), message, fields),
    info: (message, fields) => emit(instance.info.bind(instance), message, fields),
    warn: (message, fields) => emit(instance.warn.bind(instance), message, fields),
    error: (message, fields) => emit(instance.error.bind(instance), message, fields),
    flush: () => instance.flush(),
  };
}
