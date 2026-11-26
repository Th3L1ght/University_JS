/**
 * Простий структурований логер: `ISO-час РІВЕНЬ повідомлення {json-поля}`.
 * Рівень 'silent' вимикає вивід (для тестів).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface LogSink {
  write(text: string): unknown;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly out?: LogSink;
  readonly err?: LogSink;
}

function serializeFields(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, (_key, value: unknown) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value,
  );
}

export function createLogger({
  level = 'info',
  out = process.stdout,
  err = process.stderr,
}: LoggerOptions = {}): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (
    name: Exclude<LogLevel, 'silent'>,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVELS[name] < threshold) return;
    const target = LEVELS[name] >= LEVELS.warn ? err : out;
    const suffix = fields === undefined ? '' : ` ${serializeFields(fields)}`;
    target.write(
      `${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${message}${suffix}\n`,
    );
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
