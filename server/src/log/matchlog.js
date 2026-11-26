/**
 * Потоковий журнал матчу. Події кімнати ({ t, type, ... }) проходять через Transform у
 * objectMode, що перетворює кожен об'єкт на рядок NDJSON, і через pipeline() потрапляють у
 * файл LOG_DIR/<roomId>-<мітка часу>.ndjson.
 *
 * Backpressure: pipeline зв'язує Transform із потоком запису. Коли диск не встигає, потік запису
 * перестає брати дані, Transform накопичує внутрішню чергу до highWaterMark, і write() починає
 * повертати false - сигнал виробнику почекати події 'drain' (див. drained()).
 */

import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Об'єкт -> рядок NDJSON. Запис, що не серіалізується (цикл), пропускається й лічиться. */
export class NdjsonTransform extends Transform {
  skipped = 0;

  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false });
  }

  _transform(record, _encoding, callback) {
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      this.skipped += 1;
      callback();
      return;
    }
    callback(null, `${line}\n`);
  }
}

/** Мітка часу для імені файлу: 20261116t150405123z. */
export function timestampForFile(ms) {
  return new Date(ms).toISOString().replace(/[-:.]/g, '').toLowerCase();
}

/**
 * @param {object} options
 * @param {string} options.dir каталог журналів (LOG_DIR)
 * @param {string} options.roomId
 * @param {number} [options.startedAt] мс від епохи; `t` у записах рахується від нього
 * @param {() => number} [options.now]
 * @param {(file: string) => import('node:stream').Writable} [options.createDestination] підміна файлу (тести)
 * @param {(error: Error) => void} [options.onError]
 */
export function createMatchLog({
  dir,
  roomId,
  startedAt = Date.now(),
  now = Date.now,
  createDestination = (file) => createWriteStream(file, { flags: 'wx' }),
  onError,
}) {
  const id = `${roomId}-${timestampForFile(startedAt)}`;
  const file = path.join(dir, `${id}.ndjson`);
  const transform = new NdjsonTransform();
  const destination = createDestination(file);

  const finished = pipeline(transform, destination);
  // Помилка диска не повинна стати unhandled rejection: фіксуємо її тут, а end() віддасть її викликачу.
  finished.catch((error) => onError?.(error));

  let ended = false;
  return {
    id,
    file,

    /**
     * Дописує подію. @returns {boolean} false - внутрішня черга повна: варто дочекатися drained().
     */
    write(record) {
      if (ended) return false;
      return transform.write({ t: now() - startedAt, ...record });
    },

    /** Проміс, що виконується, коли черга спорожніла (backpressure знято). */
    async drained() {
      if (transform.writableNeedDrain) await once(transform, 'drain');
    },

    /** Завершує запис і чекає, поки всі дані потраплять на диск. Можна викликати повторно. */
    end() {
      if (!ended) {
        ended = true;
        transform.end();
      }
      return finished;
    },

    get bytesWritten() {
      return destination.bytesWritten ?? 0;
    },
    get skipped() {
      return transform.skipped;
    },
    get queued() {
      return transform.writableLength;
    },
  };
}
