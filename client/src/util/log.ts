/**
 * Мінімальний логер із префіксом області: `[loader] повідомлення`.
 */

export interface LogSink {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

let sink: LogSink = console;

export function setLogSink(newSink: LogSink | null): void {
  sink = newSink ?? console;
}

function write(
  level: 'info' | 'warn' | 'error',
  scope: string,
  message: string,
  data?: unknown,
): void {
  const line = `[${scope}] ${message}`;
  if (data === undefined) sink[level](line);
  else sink[level](line, data);
}

export const log = {
  info: (scope: string, message: string, data?: unknown): void =>
    write('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown): void =>
    write('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown): void =>
    write('error', scope, message, data),
};
