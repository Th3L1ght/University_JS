import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import { TokenBucket } from '../src/rate_limit.js';

describe('loadConfig', () => {
  test('значення за замовчуванням', () => {
    const config = loadConfig({}, '/work');
    assert.equal(config.port, 3000);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.nodeEnv, 'production');
    assert.equal(config.serveStatic, true);
    assert.equal(config.logDir, path.resolve('/work', './logs'));
    assert.equal(config.limits.maxPlayersPerRoom, 8);
    assert.equal(config.ws.maxPayload, 16 * 1024);
    assert.equal(config.ws.authTimeoutMs, 5000);
    assert.equal(config.ws.heartbeatMs, 15000);
    assert.ok(config.staticDir.endsWith(path.join('client', 'dist')));
  });

  test('читає значення зі змінних середовища', () => {
    const config = loadConfig(
      {
        PORT: '8080',
        HOST: '127.0.0.1',
        LOG_DIR: 'out/logs',
        MAX_ROOMS: '3',
        NODE_ENV: 'development',
      },
      '/work',
    );
    assert.equal(config.port, 8080);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.logDir, path.resolve('/work', 'out/logs'));
    assert.equal(config.limits.maxRooms, 3);
    assert.equal(config.serveStatic, false, 'у development статику віддає Vite');
  });

  test('порожнє значення = значення за замовчуванням', () => {
    assert.equal(loadConfig({ PORT: '' }).port, 3000);
  });

  test('збирає ВСІ помилки в один ConfigError', () => {
    assert.throws(
      () =>
        loadConfig({
          PORT: 'abc',
          MAX_ROOMS: '0',
          NODE_ENV: 'staging',
          HOST: 'bad host',
          WS_MAX_PAYLOAD: '10',
        }),
      (error) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.problems.length, 5);
        assert.match(error.message, /PORT/);
        assert.match(error.message, /MAX_ROOMS/);
        assert.match(error.message, /NODE_ENV/);
        assert.match(error.message, /HOST/);
        assert.match(error.message, /WS_MAX_PAYLOAD/);
        return true;
      },
    );
  });

  test('число поза діапазоном і дробове значення відхиляються', () => {
    assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
    assert.throws(() => loadConfig({ PORT: '30.5' }), /PORT/);
  });

  test('конфігурація заморожена', () => {
    const config = loadConfig({});
    assert.throws(() => {
      config.port = 1;
    }, TypeError);
    assert.throws(() => {
      config.limits.maxRooms = 1;
    }, TypeError);
  });
});

describe('TokenBucket', () => {
  test('дозволяє сплеск до capacity, потім відмовляє', () => {
    const now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1, now: () => now });
    assert.deepEqual(
      [bucket.take(), bucket.take(), bucket.take(), bucket.take()],
      [true, true, true, false],
    );
  });

  test('поповнюється зі сталою швидкістю й не перевищує capacity', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 2, now: () => now });
    bucket.take();
    bucket.take();
    assert.equal(bucket.take(), false);
    now = 500; // +1 жетон
    assert.equal(bucket.take(), true);
    assert.equal(bucket.take(), false);
    now = 60_000;
    assert.equal(bucket.take(), true);
    assert.ok(bucket.tokens <= 2);
  });

  test('годинник, що йде назад, не ламає лічильник', () => {
    let now = 1000;
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1, now: () => now });
    bucket.take();
    now = 0;
    assert.equal(bucket.take(), false);
  });
});
