import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { createMatchLog, NdjsonTransform, timestampForFile } from '../src/log/matchlog.js';
import { parseNdjson, ReplayParseError, readReplay } from '../src/log/replay.js';

let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dogfight-log-'));
});
after(() => rm(dir, { recursive: true, force: true }));

const collect = async (iterable) => {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
};

describe('NdjsonTransform', () => {
  test('перетворює об’єкти на рядки NDJSON', async () => {
    const transform = new NdjsonTransform();
    const chunks = [];
    transform.on('data', (chunk) => chunks.push(chunk.toString()));
    transform.write({ a: 1 });
    transform.write({ b: 'привіт' });
    transform.end();
    await new Promise((resolve) => transform.on('end', resolve));
    assert.equal(chunks.join(''), '{"a":1}\n{"b":"привіт"}\n');
  });

  test('запис, що не серіалізується, пропускається, потік живий', async () => {
    const transform = new NdjsonTransform();
    const chunks = [];
    transform.on('data', (chunk) => chunks.push(chunk.toString()));
    transform.write({ bad: 10n }); // BigInt не серіалізується в JSON
    transform.write({ ok: true });
    transform.end();
    await new Promise((resolve) => transform.on('end', resolve));
    assert.equal(chunks.join(''), '{"ok":true}\n');
    assert.equal(transform.skipped, 1);
  });
});

describe('createMatchLog -> readReplay (круговий шлях)', () => {
  test('імена файлів, поле t і порядок подій', async () => {
    let clock = 10_000;
    const log = createMatchLog({ dir, roomId: 'arena-1', startedAt: 10_000, now: () => clock });
    assert.equal(log.id, `arena-1-${timestampForFile(10_000)}`);
    assert.equal(log.file, path.join(dir, `${log.id}.ndjson`));

    log.write({ type: 'start' });
    clock += 250;
    log.write({ type: 'join', playerId: 'p1', nickname: 'Maverick' });
    clock += 750;
    log.write({ type: 'chat', text: 'привіт' });
    await log.end();

    const events = await collect(readReplay(log.file));
    assert.deepEqual(events, [
      { t: 0, type: 'start' },
      { t: 250, type: 'join', playerId: 'p1', nickname: 'Maverick' },
      { t: 1000, type: 'chat', text: 'привіт' },
    ]);
    const raw = await readFile(log.file, 'utf8');
    assert.equal(raw.split('\n').length, 4, 'три рядки й завершальний \\n');
  });

  test('end() можна викликати повторно, запис після завершення ігнорується', async () => {
    const log = createMatchLog({ dir, roomId: 'twice' });
    log.write({ type: 'a' });
    const first = log.end();
    assert.equal(log.end(), first);
    assert.equal(log.write({ type: 'late' }), false);
    await first;
    assert.equal((await collect(readReplay(log.file))).length, 1);
  });
});

// Великі записи: черга Transform обмежена ~16 КіБ читаної сторони + 16 об'єктів записуваної,
// тож дрібні записи (десятки байтів) довго не викликали б сигнал backpressure.
const PAD = 'x'.repeat(2000);

describe('backpressure', () => {
  test('повільний диск: write() повертає false, drained() чекає, порядок і повнота збережені', async () => {
    const written = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const slowDisk = () =>
      new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          setTimeout(() => {
            written.push(chunk.toString());
            concurrent -= 1;
            callback();
          }, 1);
        },
      });
    const log = createMatchLog({ dir, roomId: 'slow', createDestination: slowDisk });

    let sawBackpressure = false;
    let drains = 0;
    for (let i = 0; i < 200; i += 1) {
      const ok = log.write({ type: 'tick', i, pad: PAD });
      if (!ok) {
        sawBackpressure = true;
        assert.ok(log.queued > 0, 'у черзі є непереписані дані');
        await log.drained();
        drains += 1;
      }
    }
    await log.end();

    assert.equal(sawBackpressure, true, 'сигнал backpressure має бути');
    assert.ok(drains > 0);
    assert.equal(maxConcurrent, 1, 'писач отримує дані строго по одному');
    assert.equal(written.length, 200);
    const indexes = written.map((line) => JSON.parse(line).i);
    assert.deepEqual(indexes, [...Array(200).keys()], 'порядок збережено');
  });

  test('помилка запису: end() відхиляється, onError викликається, процес не падає', async () => {
    const errors = [];
    const failing = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error('диск повний'));
        },
      });
    const log = createMatchLog({
      dir,
      roomId: 'failing',
      createDestination: failing,
      onError: (e) => errors.push(e.message),
    });
    log.write({ type: 'x' });
    await assert.rejects(log.end(), /диск повний/);
    assert.deepEqual(errors, ['диск повний']);
  });
});

describe('readReplay / parseNdjson', () => {
  test('рядки, розрізані межами чанків (у тому числі посеред багатобайтового символу)', async () => {
    const file = path.join(dir, 'chunks.ndjson');
    const lines = [
      { t: 1, text: 'привіт, світе' },
      { t: 2, text: '日本語🚀' },
      { t: 3, text: 'end' },
    ];
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    for (const highWaterMark of [1, 3, 7, 64]) {
      assert.deepEqual(
        await collect(readReplay(file, { highWaterMark })),
        lines,
        `highWaterMark=${highWaterMark}`,
      );
    }
  });

  test('останній рядок без \\n і порожні рядки', async () => {
    const result = await collect(parseNdjson(['{"a":1}\n\n{"b"', ':2}']));
    assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
  });

  test('пошкоджений рядок -> ReplayParseError із номером рядка', async () => {
    const file = path.join(dir, 'broken.ndjson');
    await writeFile(file, '{"ok":1}\n{broken\n{"ok":3}\n');
    await assert.rejects(collect(readReplay(file)), (error) => {
      assert.ok(error instanceof ReplayParseError);
      assert.equal(error.lineNumber, 2);
      return true;
    });
    assert.deepEqual(await collect(readReplay(file, { skipInvalid: true })), [
      { ok: 1 },
      { ok: 3 },
    ]);
  });

  test('ранній вихід із for await закриває потік, файл можна видалити й перечитати', async () => {
    const file = path.join(dir, 'early.ndjson');
    await writeFile(
      file,
      Array.from({ length: 1000 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n',
    );
    let first;
    for await (const event of readReplay(file, { highWaterMark: 16 })) {
      first = event;
      break;
    }
    assert.deepEqual(first, { i: 0 });
    assert.equal((await collect(readReplay(file))).length, 1000);
  });

  test('відсутній файл: помилка ENOENT, а не зависання', async () => {
    await assert.rejects(collect(readReplay(path.join(dir, 'missing.ndjson'))), { code: 'ENOENT' });
  });
});
