/**
 * Простий структурований логер: `ISO-час РІВЕНЬ повідомлення {json-поля}`.
 * Рівень 'silent' вимикає вивід (для тестів).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function serializeFields(fields) {
  return JSON.stringify(fields, (_key, value) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value,
  );
}

/**
 * @param {object} [options]
 * @param {keyof typeof LEVELS} [options.level]
 * @param {{ write: (text: string) => unknown }} [options.out] приймач info/debug
 * @param {{ write: (text: string) => unknown }} [options.err] приймач warn/error
 */
export function createLogger({ level = 'info', out = process.stdout, err = process.stderr } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (name, message, fields) => {
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
