import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { CloseCode } from '../src/protocol.js';
import { safeSend } from '../src/ws.js';
import { join, makeRoom, openClient, sleep, startTestApp } from './helpers.js';

/** Виконує сценарій на окремому екземплярі застосунку й гарантовано зупиняє його. */
async function withApp(env, scenario) {
  const app = await startTestApp(env);
  try {
    await scenario(app);
  } finally {
    await app.stop();
  }
}

describe('WebSocket: вхід у кімнату, roster і чат', () => {
  test('welcome із roster; другий гравець бачить roster; чат доходить усім, зокрема відправнику', () =>
    withApp({}, async (env) => {
      const room = makeRoom(env.app, { name: 'Chat Room' });
      const alice = await openClient(env.wsUrl);
      join(alice, room.id, 'Alice');
      const welcome = await alice.next('welcome');
      assert.equal(welcome.v, 1);
      assert.equal(welcome.room.id, room.id);
      assert.deepEqual(
        welcome.players.map((p) => p.nickname),
        ['Alice'],
      );

      const bob = await openClient(env.wsUrl);
      join(bob, room.id, 'Bob');
      const bobWelcome = await bob.next('welcome');
      assert.deepEqual(bobWelcome.players.map((p) => p.nickname).sort(), ['Alice', 'Bob']);
      const roster = await alice.next((m) => m.type === 'roster' && m.players.length === 2);
      assert.deepEqual(roster.players.map((p) => p.nickname).sort(), ['Alice', 'Bob']);

      alice.send({ v: 1, type: 'chat', text: 'привіт, Бобе' });
      const [toAlice, toBob] = await Promise.all([alice.next('chat'), bob.next('chat')]);
      for (const message of [toAlice, toBob]) {
        assert.equal(message.nickname, 'Alice');
        assert.equal(message.text, 'привіт, Бобе');
        assert.equal(message.room, room.id);
        assert.equal(typeof message.ts, 'number');
      }

      bob.socket.close(1000);
      await bob.closed;
      const after = await alice.next((m) => m.type === 'roster' && m.players.length === 1);
      assert.equal(after.players[0].nickname, 'Alice');
      alice.socket.close(1000);
      await alice.closed;
    }));

  test('чат ізольований між кімнатами', () =>
    withApp({}, async (env) => {
      const a = makeRoom(env.app, { name: 'Room A' });
      const b = makeRoom(env.app, { name: 'Room B' });
      const inA = await openClient(env.wsUrl);
      const inB = await openClient(env.wsUrl);
      join(inA, a.id, 'Alice');
      join(inB, b.id, 'Bob');
      await inA.next('welcome');
      await inB.next('welcome');

      inA.send({ v: 1, type: 'chat', text: 'тільки для A' });
      await inA.next('chat');
      await sleep(100);
      assert.equal(inB.inbox.filter((m) => m.type === 'chat').length, 0);
    }));

  test('зайнятий нікнейм: помилка без закриття, можна спробувати інший', () =>
    withApp({}, async (env) => {
      const room = makeRoom(env.app);
      const first = await openClient(env.wsUrl);
      join(first, room.id, 'Maverick');
      await first.next('welcome');

      const second = await openClient(env.wsUrl);
      join(second, room.id, 'maverick');
      const error = await second.next('error');
      assert.equal(error.code, 'nickname_taken');
      join(second, room.id, 'Goose');
      assert.equal((await second.next('welcome')).players.length, 2);
    }));

  test('повторний join у кімнаті -> error already_joined, з’єднання живе', () =>
    withApp({}, async (env) => {
      const room = makeRoom(env.app);
      const client = await openClient(env.wsUrl);
      join(client, room.id, 'Maverick');
      await client.next('welcome');
      join(client, room.id, 'Maverick');
      assert.equal((await client.next('error')).code, 'already_joined');
      client.send({ v: 1, type: 'ping', t: 7 });
      assert.equal((await client.next('pong')).t, 7);
    }));

  test('кімнати немає -> 4003; кімната заповнена -> 4004', () =>
    withApp({}, async (env) => {
      const lost = await openClient(env.wsUrl);
      join(lost, 'no-such-room', 'Pilot');
      assert.equal((await lost.closed).code, CloseCode.ROOM_NOT_FOUND);

      const room = makeRoom(env.app, { maxPlayers: 2 });
      const players = [];
      for (const name of ['One', 'Two']) {
        const client = await openClient(env.wsUrl);
        join(client, room.id, name);
        await client.next('welcome');
        players.push(client);
      }
      const third = await openClient(env.wsUrl);
      join(third, room.id, 'Three');
      assert.equal((await third.closed).code, CloseCode.ROOM_FULL);
      assert.equal(room.size, 2);
    }));

  test('leave: клієнт виходить із кімнати, сервер закриває з 1000', () =>
    withApp({}, async (env) => {
      const room = makeRoom(env.app);
      const client = await openClient(env.wsUrl);
      join(client, room.id, 'Maverick');
      await client.next('welcome');
      client.send({ v: 1, type: 'leave' });
      assert.equal((await client.closed).code, CloseCode.NORMAL);
    }));
});

describe('WebSocket: порушення протоколу й політики', () => {
  const closeWith = (env, send) =>
    openClient(env.wsUrl).then(async (client) => {
      send(client);
      return client.closed;
    });

  test('невалідний JSON -> 1007; хибна версія -> 1007; зайве поле -> 1007', () =>
    withApp({}, async (env) => {
      assert.equal((await closeWith(env, (c) => c.raw('{oops'))).code, CloseCode.INVALID_PAYLOAD);
      assert.equal(
        (await closeWith(env, (c) => c.raw('{"v":9,"type":"ping"}'))).code,
        CloseCode.INVALID_PAYLOAD,
      );
      assert.equal(
        (await closeWith(env, (c) => c.raw('{"v":1,"type":"ping","x":1}'))).code,
        CloseCode.INVALID_PAYLOAD,
      );
    }));

  test('невідомий тип -> 1008; chat до join -> 1008', () =>
    withApp({}, async (env) => {
      assert.equal(
        (await closeWith(env, (c) => c.send({ v: 1, type: 'fly' }))).code,
        CloseCode.POLICY_VIOLATION,
      );
      assert.equal(
        (await closeWith(env, (c) => c.send({ v: 1, type: 'chat', text: 'hi' }))).code,
        CloseCode.POLICY_VIOLATION,
      );
    }));

  test('бінарний кадр -> 1003', () =>
    withApp({}, async (env) => {
      const result = await closeWith(env, (c) => c.raw(Buffer.from([1, 2, 3]), { binary: true }));
      assert.equal(result.code, CloseCode.UNSUPPORTED_DATA);
    }));

  test('кадр більший за maxPayload -> 1009', () =>
    withApp({ WS_MAX_PAYLOAD: '256' }, async (env) => {
      const result = await closeWith(env, (c) =>
        c.raw(JSON.stringify({ v: 1, type: 'chat', text: 'x'.repeat(1000) })),
      );
      assert.equal(result.code, CloseCode.MESSAGE_TOO_BIG);
    }));

  test('rate limit (token bucket): надлишок повідомлень -> 1008 rate_limited', () =>
    withApp({ RATE_LIMIT_BURST: '3', RATE_LIMIT_PER_SEC: '1' }, async (env) => {
      const client = await openClient(env.wsUrl);
      for (let i = 0; i < 10; i += 1) client.send({ v: 1, type: 'ping', t: i });
      const result = await client.closed;
      assert.equal(result.code, CloseCode.POLICY_VIOLATION);
      assert.equal(result.reason, 'rate_limited');
    }));

  test('таймаут авторизації: без join сокет закривається кодом 4001', () =>
    withApp({ AUTH_TIMEOUT_MS: '150' }, async (env) => {
      const started = Date.now();
      const client = await openClient(env.wsUrl);
      const result = await client.closed;
      assert.equal(result.code, CloseCode.AUTH_TIMEOUT);
      assert.ok(Date.now() - started >= 140);
    }));

  test('успішний join скасовує таймаут авторизації', () =>
    withApp({ AUTH_TIMEOUT_MS: '150' }, async (env) => {
      const room = makeRoom(env.app);
      const client = await openClient(env.wsUrl);
      join(client, room.id, 'Maverick');
      await client.next('welcome');
      await sleep(300);
      assert.equal(client.socket.readyState, WebSocket.OPEN);
    }));

  test('ліміт з’єднань: понад MAX_CONNECTIONS -> 1013', () =>
    withApp({ MAX_CONNECTIONS: '1' }, async (env) => {
      const first = await openClient(env.wsUrl);
      const second = await openClient(env.wsUrl);
      assert.equal((await second.closed).code, CloseCode.TRY_AGAIN_LATER);
      assert.equal(first.socket.readyState, WebSocket.OPEN);
    }));
});

describe('WebSocket: heartbeat, помилки сокетів, повільні клієнти', () => {
  test('heartbeat: клієнт, що не відповідає на ping, відключається після 2 пропусків', () =>
    withApp({ HEARTBEAT_MS: '40', AUTH_TIMEOUT_MS: '60000' }, async (env) => {
      const started = Date.now();
      const dead = await openClient(env.wsUrl, { autoPong: false }); // мовчить на ping
      const alive = await openClient(env.wsUrl); // відповідає автоматично
      const result = await dead.closed;
      const elapsed = Date.now() - started;

      assert.equal(result.code, 1006, 'terminate() = аномальне закриття без close-кадру');
      assert.ok(elapsed >= 70, `відключено не раніше ~2 інтервалів (${elapsed} мс)`);
      assert.equal(alive.socket.readyState, WebSocket.OPEN, 'живий клієнт лишається');
    }));

  test('помилка на сокеті не завалює процес: обробник socket.on("error") є', () =>
    withApp({ AUTH_TIMEOUT_MS: '60000' }, async (env) => {
      const client = await openClient(env.wsUrl);
      await sleep(50);
      const [{ socket }] = [...env.app.ws.connections];
      assert.ok(socket.listenerCount('error') >= 1, 'на сокеті має бути обробник error');
      // Без обробника ця подія кинула б необроблений виняток і зупинила процес.
      assert.doesNotThrow(() => socket.emit('error', new Error('імітація мережевого збою')));

      const health = await fetch(`${env.url}/health`);
      assert.equal(health.status, 200);
      client.socket.terminate();
    }));

  test('раптове обривання клієнта прибирає його з кімнати', () =>
    withApp({}, async (env) => {
      const room = makeRoom(env.app);
      const a = await openClient(env.wsUrl);
      const b = await openClient(env.wsUrl);
      join(a, room.id, 'Alice');
      join(b, room.id, 'Bob');
      await a.next('welcome');
      await b.next('welcome');
      b.socket.terminate();
      const roster = await a.next((m) => m.type === 'roster' && m.players.length === 1);
      assert.equal(roster.players[0].nickname, 'Alice');
    }));

  describe('safeSend: політика повільного клієнта', () => {
    const logger = { warn() {}, info() {}, error() {}, debug() {} };
    const makeConn = (overrides = {}) => {
      const calls = { send: [], terminate: 0, close: [] };
      const socket = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: (data, callback) => {
          calls.send.push(JSON.parse(data));
          callback?.();
        },
        terminate: () => {
          calls.terminate += 1;
        },
        close: (code) => calls.close.push(code),
        ...overrides,
      };
      return { conn: { socket, dropped: 0 }, calls };
    };
    const options = (stats) => ({ maxBufferedBytes: 1000, logger, stats });

    test('нормальний буфер: повідомлення відправляється', () => {
      const { conn, calls } = makeConn();
      assert.equal(safeSend(conn, 'pong', { t: 1 }, options()), 'sent');
      assert.deepEqual(calls.send[0], { v: 1, type: 'pong', t: 1 });
    });

    test('буфер вище порога: повідомлення відкидається, не відправляється', () => {
      const { conn, calls } = makeConn({ bufferedAmount: 1500 });
      const stats = { dropped: 0 };
      assert.equal(safeSend(conn, 'pong', {}, options(stats)), 'dropped');
      assert.equal(calls.send.length, 0);
      assert.equal(conn.dropped, 1);
      assert.equal(stats.dropped, 1);
    });

    test('буфер вище жорсткої межі (4×): сокет відключається', () => {
      const { conn, calls } = makeConn({ bufferedAmount: 4500 });
      assert.equal(safeSend(conn, 'pong', {}, options()), 'closed');
      assert.equal(calls.terminate, 1);
    });

    test('100 відкинутих підряд -> закриття з кодом 4005', () => {
      const { conn, calls } = makeConn({ bufferedAmount: 1500 });
      let last;
      for (let i = 0; i < 100; i += 1) last = safeSend(conn, 'pong', {}, options());
      assert.equal(last, 'closed');
      assert.deepEqual(calls.close, [CloseCode.SLOW_CONSUMER]);
    });

    test('закритий сокет: нічого не відправляється', () => {
      const { conn, calls } = makeConn({ readyState: WebSocket.CLOSED });
      assert.equal(safeSend(conn, 'pong', {}, options()), 'closed');
      assert.equal(calls.send.length, 0);
    });
  });
});

describe('Graceful shutdown', () => {
  test('закриває клієнтів кодом 1001, дописує журнали, зупиняє прийом з’єднань', async () => {
    const env = await startTestApp();
    try {
      const room = makeRoom(env.app, { name: 'Shutdown Room' });
      const client = await openClient(env.wsUrl);
      join(client, room.id, 'Maverick');
      await client.next('welcome');
      client.send({ v: 1, type: 'chat', text: 'до завершення' });
      await client.next('chat');

      await env.app.shutdown('test');

      const result = await client.closed;
      assert.equal(result.code, CloseCode.GOING_AWAY);
      assert.equal(env.app.server.listening, false, 'сервер більше не слухає порт');
      await assert.rejects(fetch(`${env.url}/health`), 'нові з’єднання не приймаються');

      const files = await readdir(env.config.logDir);
      assert.equal(files.length, 1);
      const lines = (await readFile(path.join(env.config.logDir, files[0]), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      assert.deepEqual(
        lines.map((l) => l.type),
        ['start', 'join', 'chat', 'leave', 'end'],
        'журнал завершено і містить end',
      );
    } finally {
      await env.stop();
    }
  });

  test('повторний виклик shutdown повертає той самий проміс', async () => {
    const env = await startTestApp();
    try {
      assert.equal(env.app.shutdown('a'), env.app.shutdown('b'));
      await env.app.shutdown('c');
    } finally {
      await env.stop();
    }
  });

  test('журнал кімнати без гравців теж закривається при завершенні', async () => {
    const env = await startTestApp();
    try {
      makeRoom(env.app, { name: 'Idle Room' });
      await env.app.shutdown('test');
      const files = await readdir(env.config.logDir);
      assert.equal(files.length, 1);
      const text = await readFile(path.join(env.config.logDir, files[0]), 'utf8');
      assert.ok(text.trim().endsWith('"type":"end"}'));
    } finally {
      await env.stop();
    }
  });
});
