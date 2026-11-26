import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { Room, RoomError, RoomManager } from '../src/rooms.ts';

const makeRoom = (overrides = {}) =>
  new Room({ id: 'arena', name: 'Arena', maxPlayers: 3, ...overrides });
const player = (id, nickname = `Pilot${id}`) => ({ id, nickname });

/** Збирає всі події кімнати в масив [назва, аргумент]. */
function record(room, names = ['join', 'leave', 'chat', 'empty', 'event']) {
  const seen = [];
  for (const name of names) room.on(name, (arg) => seen.push([name, arg]));
  return seen;
}

describe('Room', () => {
  test('join: додає гравця, емітить join і event, повертає roster', () => {
    const room = makeRoom();
    const seen = record(room);
    const roster = room.join(player('p1', 'Maverick'));

    assert.deepEqual(roster, [{ id: 'p1', nickname: 'Maverick' }]);
    assert.equal(room.size, 1);
    assert.deepEqual(
      seen.map(([name]) => name),
      ['join', 'event'],
    );
    assert.deepEqual(seen[1][1], { type: 'join', playerId: 'p1', nickname: 'Maverick' });
  });

  test('join: повторний id, зайнятий нікнейм (без урахування регістру), заповнена кімната', () => {
    const room = makeRoom({ maxPlayers: 2 });
    room.join(player('p1', 'Maverick'));

    assert.throws(
      () => room.join(player('p1', 'Other')),
      (e) => e instanceof RoomError && e.code === 'player_exists',
    );
    assert.throws(
      () => room.join(player('p2', 'MAVERICK')),
      (e) => e.code === 'nickname_taken',
    );
    room.join(player('p2', 'Goose'));
    assert.equal(room.isFull, true);
    assert.throws(
      () => room.join(player('p3', 'Iceman')),
      (e) => e.code === 'room_full',
    );
    assert.equal(room.size, 2);
  });

  test('leave: емітить leave і event; "empty" лише коли вийшов останній', () => {
    const room = makeRoom();
    room.join(player('p1'));
    room.join(player('p2'));
    const seen = record(room);

    assert.equal(room.leave('p1'), true);
    assert.deepEqual(
      seen.map(([name]) => name),
      ['leave', 'event'],
    );
    assert.equal(room.leave('p1'), false, 'повторний вихід нічого не робить');

    room.leave('p2');
    assert.deepEqual(
      seen.map(([name]) => name),
      ['leave', 'event', 'leave', 'event', 'empty'],
    );
    assert.equal(seen.at(-1)[1], room);
  });

  test('chat: емітить chat і event із nickname та ts; сторонній гравець не може писати', () => {
    const room = makeRoom({ now: () => 1234 });
    room.join(player('p1', 'Maverick'));
    const seen = record(room, ['chat', 'event']);

    const message = room.chat('p1', 'привіт');
    assert.deepEqual(message, { playerId: 'p1', nickname: 'Maverick', text: 'привіт', ts: 1234 });
    assert.equal(seen[0][0], 'chat');
    assert.deepEqual(seen[1][1], { type: 'chat', ...message });
    assert.throws(
      () => room.chat('ghost', 'hi'),
      (e) => e.code === 'not_member',
    );
  });

  test('toJSON має ту саму форму, що й public/api/rooms.json', () => {
    const room = makeRoom({ map: 'Belt', mode: 'Survival', arena: { initialAsteroids: 5 } });
    room.join(player('p1'));
    assert.deepEqual(room.toJSON(), {
      id: 'arena',
      name: 'Arena',
      map: 'Belt',
      mode: 'Survival',
      players: 1,
      maxPlayers: 3,
      arena: { initialAsteroids: 5 },
      replayId: null,
    });
  });
});

describe('RoomManager', () => {
  const make = (overrides = {}) =>
    new RoomManager({ maxRooms: 2, maxPlayersPerRoom: 4, emptyRoomTtlMs: 1000, ...overrides });
  const input = (name = 'Room') => ({ name, map: 'M', mode: 'X', maxPlayers: 8, arena: {} });

  test('create: емітить created, обмежує maxPlayers верхньою межею менеджера', () => {
    const manager = make();
    const created = [];
    manager.on('created', (room) => created.push(room));
    const room = manager.create(input());
    assert.equal(created[0], room);
    assert.equal(room.maxPlayers, 4);
    assert.equal(manager.get(room.id), room);
    assert.equal(manager.list().length, 1);
    manager.destroy();
  });

  test('create: ліміт кількості кімнат', () => {
    const manager = make();
    manager.create(input('A1'));
    manager.create(input('B1'));
    assert.throws(
      () => manager.create(input('C1')),
      (e) => e instanceof RoomError && e.code === 'room_limit',
    );
    manager.destroy();
  });

  test('create: колізію ідентифікаторів розв’язує повторною генерацією', () => {
    const ids = ['same', 'same', 'other'];
    const manager = make({ makeId: () => ids.shift() });
    const a = manager.create(input());
    const b = manager.create(input());
    assert.deepEqual([a.id, b.id], ['same', 'other']);
    manager.destroy();
  });

  test('подія "empty" автоматично видаляє кімнату й емітить removed', () => {
    const manager = make();
    const removed = [];
    manager.on('removed', (room) => removed.push(room.id));
    const room = manager.create(input());
    room.join(player('p1'));
    room.join(player('p2'));

    room.leave('p1');
    assert.equal(manager.has(room.id), true, 'ще є гравець - кімната жива');
    room.leave('p2');
    assert.equal(manager.has(room.id), false);
    assert.deepEqual(removed, [room.id]);
    assert.equal(manager.size, 0);
    manager.destroy();
  });

  test('кімната, у яку ніхто не зайшов, видаляється за TTL', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const manager = make({ emptyRoomTtlMs: 5000 });
      const room = manager.create(input());
      mock.timers.tick(4999);
      assert.equal(manager.has(room.id), true);
      mock.timers.tick(1);
      assert.equal(manager.has(room.id), false);
    } finally {
      mock.timers.reset();
    }
  });

  test('перший join скасовує TTL', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const manager = make({ emptyRoomTtlMs: 5000 });
      const room = manager.create(input());
      room.join(player('p1'));
      mock.timers.tick(60_000);
      assert.equal(manager.has(room.id), true, 'кімната з гравцем не видаляється за TTL');
      manager.destroy();
    } finally {
      mock.timers.reset();
    }
  });

  test('remove: повертає false для невідомої кімнати; повторне видалення безпечне', () => {
    const manager = make();
    const room = manager.create(input());
    assert.equal(manager.remove(room.id), true);
    assert.equal(manager.remove(room.id), false);
    assert.equal(manager.remove('nope'), false);
    manager.destroy();
  });
});
