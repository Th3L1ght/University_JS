import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as shared from '@dogfight/shared';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('@dogfight/shared: чистота пакета', () => {
  test('імпортується в Node без DOM і створює світ', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(typeof shared.World, 'function');
    const world = new shared.World({ width: 800, height: 600, seed: 7 });
    world.populate();
    world.step(shared.TICK_DT);
    assert.ok([...world].length >= world.rules.initialAsteroids);
  });

  test('публічний API містить симуляцію, протокол і кодеки', () => {
    for (const name of [
      'World',
      'Ship',
      'Asteroid',
      'Bullet',
      'Explosion',
      'createPickup',
      'createRng',
      'Vector2',
      'findCollisions',
      'TICK_RATE',
      'validateInput',
      'getCodec',
      'binaryCodec',
      'jsonCodec',
    ]) {
      assert.ok(name in shared, `немає експорту ${name}`);
    }
  });

  test('у вихідному коді немає Math.random, Date.now, DOM і node:*', () => {
    const forbidden = [
      [/Math\.random/, 'Math.random'],
      [/Date\.now/, 'Date.now'],
      [/new Date\(/, 'new Date()'],
      [/performance\.now/, 'performance.now'],
      [/\bdocument\b/, 'document'],
      [/\bwindow\b/, 'window'],
      [/\bcanvas\b/i, 'canvas'],
      [/['"]node:/, 'node:*'],
      [/\brequire\(/, 'require'],
    ];
    const files = listFiles(SRC).filter((file) => file.endsWith('.js'));
    assert.ok(files.length >= 15);
    for (const file of files) {
      // Коментарі можуть згадувати заборонені слова: перевіряємо лише код.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const [pattern, label] of forbidden) {
        assert.ok(!pattern.test(code), `${file}: знайдено ${label}`);
      }
    }
  });
});
