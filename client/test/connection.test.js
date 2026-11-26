import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { createApp } from '../../server/src/index.js';
import { loadConfig } from '../../server/src/config.js';
import { createLogger } from '../../server/src/logger.js';
import { Connection, NO_RECONNECT_CODES } from '../src/net/connection.js';
import { backoffDelay } from '../src/util/backoff.js';

/** Керований тестом WebSocket: жодної мережі, події викликаються вручну. */
class FakeWebSocket {
  static instances = [];
  readyState = 0;
  sent = [];
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  // --- Керування з тесту ---
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(object) {
    this.onmessage?.({ data: typeof object === 'string' ? object : JSON.stringify(object) });
  }
  serverClose(code, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const last = () => FakeWebSocket.instances.at(-1);
const make = (options = {}) =>
  new Connection({
    url: 'ws://test/ws',
    WebSocketImpl: FakeWebSocket,
    random: () => 0,
    backoff: { baseMs: 100, maxMs: 1000, maxAttempts: Infinity },
    ...options,
  });

afterEach(() => {
  FakeWebSocket.instances = [];
  mock.timers.reset();
});

describe('Connection: черга відправки', () => {
  test('повідомлення в стані CONNECTING стають у чергу й відправляються по порядку після відкриття', () => {
    const connection = make();
    connection.connect();
    assert.equal(connection.send('join', { room: 'a', nickname: 'Pilot' }), 'queued');
    assert.equal(connection.send('chat', { text: 'один' }), 'queued');
    assert.equal(connection.queued, 2);
    assert.deepEqual(last().sent, []);

    last().open();
    assert.deepEqual(
      last().sent.map((m) => [m.v, m.type]),
      [
        [1, 'join'],
        [1, 'chat'],
      ],
    );
    assert.equal(connection.queued, 0);
    assert.equal(connection.send('ping'), 'sent', 'у відкритому стані - одразу');
  });

  test('подія connected приходить РАНІШЕ за скидання черги: join застосунку випереджає чат із черги', () => {
    const connection = make();
    connection.connect();
    connection.addEventListener('connected', () =>
      connection.send('join', { room: 'a', nickname: 'Pilot' }),
    );
    connection.send('chat', { text: 'із черги' });
    last().open();
    assert.deepEqual(
      last().sent.map((m) => m.type),
      ['join', 'chat'],
    );
  });

  test('send до connect() і після остаточного закриття - помилка; переповнена черга - помилка', () => {
    const connection = make({ maxQueue: 2 });
    assert.throws(() => connection.send('ping'), /connect/);
    connection.connect();
    connection.send('ping');
    connection.send('ping');
    assert.throws(() => connection.send('ping'), /переповнена/);
    connection.close();
    assert.throws(() => connection.send('ping'), /закрито/);
  });

  test('close() скидає чергу', () => {
    const connection = make();
    connection.connect();
    connection.send('chat', { text: 'x' });
    connection.close();
    assert.equal(connection.queued, 0);
  });
});

describe('Connection: диспетчеризація за type', () => {
  test('кожен type стає подією з повним повідомленням у detail', () => {
    const connection = make();
    connection.connect();
    last().open();
    const seen = [];
    connection.addEventListener('roster', (e) => seen.push(['roster', e.detail.players.length]));
    connection.addEventListener('chat', (e) => seen.push(['chat', e.detail.text]));
    last().receive({ v: 1, type: 'roster', players: [{ id: '1', nickname: 'A' }] });
    last().receive({ v: 1, type: 'chat', text: 'привіт' });
    last().receive({ v: 1, type: 'unknown_type' }); // без підписників: просто ігнорується
    assert.deepEqual(seen, [
      ['roster', 1],
      ['chat', 'привіт'],
    ]);
  });

  test('не JSON, хибна версія і не-об’єкт -> protocolerror, а не виняток', () => {
    const connection = make();
    connection.connect();
    last().open();
    const reasons = [];
    connection.addEventListener('protocolerror', (e) => reasons.push(e.detail.reason));
    last().receive('{oops');
    last().receive({ v: 2, type: 'chat' });
    last().receive({ type: 'chat' });
    last().receive('[1]');
    assert.equal(reasons.length, 4);
  });
});

describe('Connection: перепідключення з експоненційним backoff', () => {
  test('затримки 50, 100, 200, 400, 500 (стеля 1000/2), скидання лічильника після відкриття', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const connection = make();
    const delays = [];
    connection.addEventListener('reconnecting', (e) => delays.push(e.detail.delayMs));
    connection.connect();
    last().open();

    for (let i = 0; i < 6; i += 1) {
      last().serverClose(1006);
      mock.timers.tick(delays.at(-1));
    }
    assert.deepEqual(delays, [50, 100, 200, 400, 500, 500]);
    assert.equal(FakeWebSocket.instances.length, 7, 'кожне перепідключення створює новий сокет');

    last().open(); // успішне підключення скидає лічильник
    last().serverClose(1006);
    assert.equal(delays.at(-1), 50);
  });

  test('події disconnected/reconnecting містять код, спробу й willReconnect', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const connection = make();
    const log = [];
    connection.addEventListener('disconnected', (e) =>
      log.push(['disconnected', e.detail.code, e.detail.willReconnect]),
    );
    connection.addEventListener('reconnecting', (e) =>
      log.push(['reconnecting', e.detail.attempt]),
    );
    connection.connect();
    last().open();
    last().serverClose(1001, 'going away');
    assert.deepEqual(log, [
      ['disconnected', 1001, true],
      ['reconnecting', 1],
    ]);
    assert.equal(connection.state, 'reconnecting');
  });

  test('повідомлення, надіслані під час перепідключення, потрапляють у чергу й іду після connected', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const connection = make();
    connection.addEventListener('connected', () =>
      connection.send('join', { room: 'a', nickname: 'Pilot' }),
    );
    connection.connect();
    last().open();
    last().serverClose(1006);
    assert.equal(connection.send('chat', { text: 'поки нема зв’язку' }), 'queued');
    mock.timers.tick(50);
    last().open();
    assert.deepEqual(
      last().sent.map((m) => m.type),
      ['join', 'chat'],
    );
  });

  test('коди відмови сервера не викликають перепідключення', () => {
    for (const code of NO_RECONNECT_CODES) {
      FakeWebSocket.instances = [];
      const connection = make();
      let detail;
      connection.addEventListener('disconnected', (e) => (detail = e.detail));
      connection.connect();
      last().open();
      last().serverClose(code);
      assert.equal(detail.willReconnect, false, `код ${code}`);
      assert.equal(connection.state, 'closed');
    }
    assert.ok(NO_RECONNECT_CODES.includes(4004) && NO_RECONNECT_CODES.includes(1008));
  });

  test('close() користувача скасовує запланований таймер перепідключення', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const connection = make();
    connection.connect();
    last().open();
    last().serverClose(1006);
    connection.close();
    mock.timers.tick(10_000);
    assert.equal(FakeWebSocket.instances.length, 1, 'нового сокета не створено');
    assert.equal(connection.state, 'closed');
  });

  test('maxAttempts: після вичерпання спроб - failed', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const connection = make({ backoff: { baseMs: 10, maxMs: 100, maxAttempts: 2 } });
    let failed = null;
    connection.addEventListener('failed', (e) => (failed = e.detail));
    connection.connect();
    last().open();
    for (let i = 0; i < 3; i += 1) {
      last().serverClose(1006);
      mock.timers.tick(1000);
    }
    assert.deepEqual(failed, { attempts: 2 });
    assert.equal(connection.state, 'closed');
  });
});

describe('backoffDelay', () => {
  test('рівний джитер: від 50% до 100% стелі, стеля зростає вдвічі й обмежена maxMs', () => {
    assert.equal(
      backoffDelay(1, { baseMs: 200 }, () => 0),
      100,
    );
    assert.equal(
      backoffDelay(1, { baseMs: 200 }, () => 1),
      200,
    );
    assert.equal(
      backoffDelay(3, { baseMs: 200 }, () => 1),
      800,
    );
    assert.equal(
      backoffDelay(10, { baseMs: 200, maxMs: 1000 }, () => 1),
      1000,
    );
  });
});

describe('Connection + реальний сервер (інтеграція)', () => {
  test('join -> welcome -> чат -> зупинка сервера дає disconnected(1001) і reconnecting', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dogfight-client-'));
    const config = loadConfig(
      { PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'test', LOG_DIR: path.join(dir, 'logs') },
      dir,
    );
    const app = createApp(config, { logger: createLogger({ level: 'silent' }) });
    await app.start();
    const room = app.rooms.create({
      name: 'Integration',
      map: 'M',
      mode: 'X',
      maxPlayers: 4,
      arena: {},
    });

    const connection = new Connection({
      url: `ws://127.0.0.1:${app.address.port}/ws`,
      backoff: { baseMs: 20, maxMs: 40 },
    });
    const once = (type) =>
      new Promise((resolve) =>
        connection.addEventListener(type, (e) => resolve(e.detail), { once: true }),
      );
    try {
      connection.addEventListener('connected', () =>
        connection.send('join', { room: room.id, nickname: 'Maverick' }),
      );
      const welcomed = once('welcome');
      connection.connect();
      const welcome = await welcomed;
      assert.equal(welcome.room.id, room.id);
      assert.deepEqual(
        welcome.players.map((p) => p.nickname),
        ['Maverick'],
      );

      const chatted = once('chat');
      connection.send('chat', { text: 'привіт із клієнта' });
      assert.equal((await chatted).text, 'привіт із клієнта');

      const disconnected = once('disconnected');
      const reconnecting = once('reconnecting');
      await app.shutdown('test');
      const closed = await disconnected;
      assert.equal(closed.code, 1001);
      assert.equal(
        closed.willReconnect,
        true,
        'сервер просто зупинився - клієнт має пробувати знову',
      );
      assert.equal((await reconnecting).attempt, 1);
    } finally {
      connection.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
