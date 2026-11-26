import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Lobby } from '../src/lobby/lobby.js';
import { setLogSink } from '../src/util/log.js';

setLogSink({ info() {}, warn() {}, error() {} });

const ROOM = {
  id: 'belt-1a2b',
  name: 'Belt',
  map: 'M',
  mode: 'X',
  players: 1,
  maxPlayers: 4,
  arena: { initialAsteroids: 5 },
};
const FULL = { ...ROOM, id: 'full-0000', name: 'Full', players: 4 };

/** Підміна fetch: маршрут -> функція (url, init) => Response | Error. */
let routes;
const realFetch = globalThis.fetch;
beforeEach(() => {
  routes = {};
  globalThis.fetch = async (url, init = {}) => {
    const handler = routes[`${init.method ?? 'GET'} ${url}`];
    if (!handler)
      throw new TypeError(`fetch failed: немає маршруту ${init.method ?? 'GET'} ${url}`);
    const result = await handler(url, init);
    if (result instanceof Error) throw result;
    return result;
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Фейкове з'єднання: записує відправлене й дозволяє емітити події з тесту. */
class FakeConnection extends EventTarget {
  state = 'idle';
  sent = [];
  closed = false;
  connect() {
    this.state = 'open';
  }
  send(type, payload = {}) {
    this.sent.push({ type, ...payload });
    return 'sent';
  }
  close() {
    this.closed = true;
    this.state = 'closed';
  }
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function makeLobby(overrides = {}) {
  const connections = [];
  const lobby = new Lobby({
    retry: { attempts: 1, baseMs: 1 },
    wsUrl: 'ws://test/ws',
    createConnection: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    ...overrides,
  });
  const events = [];
  for (const type of [
    'roomsUpdated',
    'roomCreated',
    'entered',
    'roster',
    'chat',
    'connection',
    'left',
    'error',
    'joined',
    'closed',
  ]) {
    lobby.addEventListener(type, (e) => events.push([type, e.detail]));
  }
  return { lobby, connections, events, kinds: () => events.map(([type]) => type) };
}

const serverRooms = (rooms = [ROOM, FULL]) => {
  routes['GET ./api/rooms'] = () => json(200, { rooms });
};

describe('Lobby: джерела списку кімнат і fallback', () => {
  test('сервер: GET /api/rooms -> roomsUpdated{source:"server"}, replayId зберігається', async () => {
    serverRooms([{ ...ROOM, replayId: 'belt-1a2b-2026' }]);
    const { lobby, events } = makeLobby();
    const rooms = await lobby.refresh();
    assert.equal(rooms[0].replayId, 'belt-1a2b-2026');
    assert.equal(events[0][1].source, 'server');
    assert.equal(lobby.mode, 'server');
    lobby.close();
  });

  test('сервера немає (мережевий збій) -> статичний ./api/rooms.json, режим static', async () => {
    routes['GET ./api/rooms.json'] = () => json(200, { rooms: [ROOM] });
    const { lobby, events } = makeLobby();
    await lobby.refresh();
    assert.equal(events[0][1].source, 'static');
    assert.equal(lobby.mode, 'static');
    lobby.close();
  });

  test('сервер повертає 404 (статичний хостинг) -> статичний список; 500 -> помилка, без fallback', async () => {
    routes['GET ./api/rooms'] = () => json(404, { error: 'not_found' });
    routes['GET ./api/rooms.json'] = () => json(200, { rooms: [ROOM] });
    const a = makeLobby();
    await a.lobby.refresh();
    assert.equal(a.events[0][1].source, 'static');
    a.lobby.close();

    routes['GET ./api/rooms'] = () => json(500, { error: 'internal_error' });
    const b = makeLobby();
    assert.equal(await b.lobby.refresh(), null);
    assert.equal(b.events[0][0], 'error');
    assert.equal(b.events[0][1].kind, 'http');
    b.lobby.close();
  });

  test('embedded (file://): мережі немає взагалі', async () => {
    const { lobby, events } = makeLobby({ embedded: true });
    const rooms = await lobby.refresh();
    assert.ok(rooms.length >= 3);
    assert.equal(events[0][1].source, 'embedded');
    assert.equal(lobby.mode, 'embedded');
    lobby.close();
  });
});

describe('Lobby: створення кімнати (POST /api/rooms)', () => {
  test('відправляє JSON POST, емітить roomCreated і оновлює список', async () => {
    serverRooms([]);
    let request;
    routes['POST ./api/rooms'] = (_url, init) => {
      request = init;
      return json(201, ROOM);
    };
    const { lobby, events } = makeLobby();
    await lobby.refresh();
    serverRooms([ROOM]);

    const room = await lobby.createRoom({ name: 'Belt', maxPlayers: 4 });
    assert.equal(room.id, ROOM.id);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { name: 'Belt', maxPlayers: 4 });
    assert.ok(events.some(([type]) => type === 'roomCreated'));
    assert.equal(lobby.rooms.length, 1, 'список оновлено');
    lobby.close();
  });

  test('помилка валідації сервера: у події error є пояснення з details', async () => {
    serverRooms([]);
    routes['POST ./api/rooms'] = () =>
      json(400, {
        error: 'validation_failed',
        message: 'Некоректні дані',
        details: ['name має містити 2-40 символів'],
      });
    const { lobby, events } = makeLobby();
    await lobby.refresh();
    assert.equal(await lobby.createRoom({ name: 'x' }), null);
    const error = events.find(([type]) => type === 'error')[1];
    assert.equal(error.kind, 'http');
    assert.match(error.error.message, /name має містити/);
    lobby.close();
  });

  test('без сервера створення кімнат недоступне (kind: offline)', async () => {
    const { lobby, events } = makeLobby({ embedded: true });
    await lobby.refresh();
    assert.equal(await lobby.createRoom({ name: 'Local' }), null);
    assert.equal(events.at(-1)[1].kind, 'offline');
    lobby.close();
  });
});

describe('Lobby: сесія кімнати через WebSocket', () => {
  async function entered() {
    serverRooms();
    const ctx = makeLobby();
    await ctx.lobby.refresh();
    ctx.lobby.enterRoom(ROOM.id, { nickname: 'Maverick' });
    const [connection] = ctx.connections;
    connection.emit('connected');
    return { ...ctx, connection };
  }

  test('після connected надсилається join; welcome -> entered; roster і chat пересилаються', async () => {
    const { lobby, connection, events } = await entered();
    assert.deepEqual(connection.sent, [{ type: 'join', room: ROOM.id, nickname: 'Maverick' }]);

    connection.emit('welcome', {
      v: 1,
      type: 'welcome',
      playerId: 'p1',
      room: ROOM,
      players: [{ id: 'p1', nickname: 'Maverick' }],
    });
    const enteredEvent = events.find(([type]) => type === 'entered')[1];
    assert.equal(enteredEvent.playerId, 'p1');
    assert.equal(lobby.inRoom, true);

    connection.emit('roster', {
      players: [
        { id: 'p1', nickname: 'Maverick' },
        { id: 'p2', nickname: 'Goose' },
      ],
    });
    connection.emit('chat', { nickname: 'Goose', text: 'привіт' });
    assert.equal(events.find(([type]) => type === 'roster')[1].players.length, 2);
    assert.equal(events.find(([type]) => type === 'chat')[1].text, 'привіт');
    lobby.close();
  });

  test('sendChat відправляє повідомлення; порожнє й надто довге відхиляються', async () => {
    const { lobby, connection, events } = await entered();
    assert.equal(lobby.sendChat('  вітаю  '), 'вітаю');
    assert.deepEqual(connection.sent.at(-1), { type: 'chat', text: 'вітаю' });
    assert.equal(lobby.sendChat('   '), null);
    assert.equal(lobby.sendChat('x'.repeat(201)), null);
    assert.equal(events.filter(([type]) => type === 'error').length, 2);
    lobby.close();
  });

  test('повторне підключення: join надсилається знову й inRoom скидається до нового welcome', async () => {
    const { lobby, connection, events } = await entered();
    connection.emit('welcome', { playerId: 'p1', room: ROOM, players: [] });
    connection.emit('reconnecting', { attempt: 1, delayMs: 250 });
    assert.equal(lobby.inRoom, false);
    assert.deepEqual(events.at(-1), [
      'connection',
      { state: 'reconnecting', attempt: 1, delayMs: 250 },
    ]);
    connection.emit('connected');
    assert.equal(connection.sent.filter((m) => m.type === 'join').length, 2);
    lobby.close();
  });

  test('сервер закрив з’єднання кодом 4004 -> error{full} і left', async () => {
    const { lobby, connection, events } = await entered();
    connection.emit('disconnected', { code: 4004, willReconnect: false });
    const error = events.find(([type]) => type === 'error')[1];
    assert.equal(error.kind, 'full');
    assert.ok(events.some(([type]) => type === 'left'));
    assert.equal(lobby.inRoom, false);
    lobby.close();
  });

  test('помилка від сервера (error{code}) стає подією error із цим kind', async () => {
    const { lobby, connection, events } = await entered();
    connection.emit('error', { code: 'nickname_taken', message: 'нікнейм зайнятий' });
    assert.equal(events.find(([type]) => type === 'error')[1].kind, 'nickname_taken');
    lobby.close();
  });

  test('leaveRoom: надсилає leave, закриває з’єднання, емітить left', async () => {
    const { lobby, connection, events } = await entered();
    connection.emit('welcome', { playerId: 'p1', room: ROOM, players: [] });
    lobby.leaveRoom();
    assert.deepEqual(connection.sent.at(-1), { type: 'leave' });
    assert.equal(connection.closed, true);
    assert.equal(events.filter(([type]) => type === 'left').length, 1);
    lobby.close();
  });

  test('валідація входу: короткий нікнейм, невідома й заповнена кімната', async () => {
    serverRooms();
    const { lobby, events, connections } = makeLobby();
    await lobby.refresh();
    assert.equal(await lobby.enterRoom(ROOM.id, { nickname: 'x' }), null);
    assert.equal(await lobby.enterRoom('nope', { nickname: 'Pilot' }), null);
    assert.equal(await lobby.enterRoom(FULL.id, { nickname: 'Pilot' }), null);
    assert.deepEqual(
      events.filter(([type]) => type === 'error').map(([, d]) => d.kind),
      ['nickname', 'not-found', 'full'],
    );
    assert.equal(connections.length, 0, 'з’єднань не відкривалось');
    lobby.close();
  });

  test('"Почати матч": join закриває лобі й WebSocket ДО події joined; власне місце не вважається зайнятим', async () => {
    serverRooms([{ ...ROOM, players: 4, maxPlayers: 4 }]); // кімната повна, бо в ній сам гравець
    const ctx = makeLobby();
    await ctx.lobby.refresh();
    // Вхід у повну кімнату заборонений...
    assert.equal(await ctx.lobby.enterRoom(ROOM.id, { nickname: 'Maverick' }), null);

    // ...але гравець, що вже всередині, може почати матч.
    serverRooms();
    await ctx.lobby.refresh();
    ctx.lobby.enterRoom(ROOM.id, { nickname: 'Maverick' });
    const [connection] = ctx.connections;
    connection.emit('connected');
    connection.emit('welcome', { playerId: 'p1', room: ROOM, players: [] });
    serverRooms([{ ...ROOM, players: 4, maxPlayers: 4 }]);
    await ctx.lobby.refresh();

    const order = [];
    ctx.lobby.addEventListener('closed', () => order.push(['closed', connection.closed]));
    ctx.lobby.addEventListener('joined', () => order.push(['joined', connection.closed]));
    const room = await ctx.lobby.join(ROOM.id, { nickname: 'Maverick' });
    assert.equal(room.id, ROOM.id);
    assert.deepEqual(
      order,
      [
        ['closed', true],
        ['joined', true],
      ],
      'WebSocket закрито ще до joined',
    );
  });

  test('у режимі без сервера enterRoom одразу запускає локальний матч (joined)', async () => {
    const { lobby, events, connections } = makeLobby({ embedded: true });
    await lobby.refresh();
    const room = await lobby.enterRoom(lobby.rooms[0].id, { nickname: 'Pilot' });
    assert.ok(room);
    assert.ok(events.some(([type]) => type === 'joined'));
    assert.equal(connections.length, 0);
  });

  test('close() закриває WebSocket і скасовує запит, що летить', async () => {
    routes['GET ./api/rooms'] = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }),
      );
    const { lobby, events } = makeLobby();
    const pending = lobby.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lobby.activeRequests, 1);
    lobby.close('test');
    assert.equal(await pending, null);
    assert.equal(lobby.activeRequests, 0);
    assert.deepEqual(
      events.map(([type]) => type),
      ['closed'],
      'жодного error після скасування',
    );
  });
});
