/**
 * Читання журналу матчу: асинхронний генератор поверх createReadStream, що віддає по одному
 * розібраному об'єкту на рядок NDJSON. Файл ніколи не завантажується в пам'ять цілком:
 * у пам'яті лише поточний чанк і незавершений хвіст рядка.
 */

import { createReadStream } from 'node:fs';

export class ReplayParseError extends Error {
  constructor(lineNumber, cause) {
    super(`Журнал пошкоджено: рядок ${lineNumber} не є коректним JSON`, { cause });
    this.name = 'ReplayParseError';
    this.lineNumber = lineNumber;
  }
}

/**
 * Розбиває потік тексту на рядки й парсить кожен як JSON.
 * Порожні рядки пропускаються; хвіст без завершального '\n' теж обробляється.
 *
 * @param {AsyncIterable<string>} chunks
 * @param {{ skipInvalid?: boolean }} [options]
 */
export async function* parseNdjson(chunks, { skipInvalid = false } = {}) {
  let buffer = '';
  let lineNumber = 0;

  const parseLine = (line) => {
    lineNumber += 1;
    if (line.trim() === '') return { skip: true };
    try {
      return { value: JSON.parse(line) };
    } catch (error) {
      if (skipInvalid) return { skip: true };
      throw new ReplayParseError(lineNumber, error);
    }
  };

  for await (const chunk of chunks) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const parsed = parseLine(line);
      if (!parsed.skip) yield parsed.value;
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer !== '') {
    const parsed = parseLine(buffer);
    if (!parsed.skip) yield parsed.value;
  }
}

/**
 * @param {string} file шлях до .ndjson
 * @param {{ skipInvalid?: boolean, signal?: AbortSignal, highWaterMark?: number }} [options]
 * @yields {object} подія матчу { t, type, ... }
 */
export async function* readReplay(file, { skipInvalid = false, signal, highWaterMark } = {}) {
  // encoding: 'utf8' - декодер стежить, щоб багатобайтовий символ не розрізався межею чанка.
  const stream = createReadStream(file, { encoding: 'utf8', signal, highWaterMark });
  try {
    yield* parseNdjson(stream, { skipInvalid });
  } finally {
    stream.destroy(); // ранній вихід із for await не повинен лишати відкритий дескриптор
  }
}
