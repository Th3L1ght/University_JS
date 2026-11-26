/**
 * Мінімальний логер із префіксом області: `[loader] повідомлення`.
 * Усі дії завантаження, повторів, скасувань і помилок проходять тут, тому їх легко відстежити
 * в консолі браузера (див. Failure Gallery в README).
 */

let sink = console;

/** Підміна приймача логів (для тестів). */
export function setLogSink(newSink) {
  sink = newSink ?? console;
}

function write(level, scope, message, data) {
  const line = `[${scope}] ${message}`;
  if (data === undefined) sink[level](line);
  else sink[level](line, data);
}

export const log = {
  info: (scope, message, data) => write('info', scope, message, data),
  warn: (scope, message, data) => write('warn', scope, message, data),
  error: (scope, message, data) => write('error', scope, message, data),
};
