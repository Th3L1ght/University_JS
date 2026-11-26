import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  binaryCodec,
  BinaryFormatError,
  buildSnapshotMessage,
  createRng,
  expandInputMessage,
  getCodec,
  INPUT_LIMITS,
  jsonCodec,
  RECORD_BYTES,
  snapshotForClient,
  TICK_DT,
  validateInput,
  World,
} from '@dogfight/shared';

const ANGLE_TOLERANCE = 0.0005 + 1e-9; // Int16, шаг 1/1000 рад
const F32 = (value) => Math.fround(value);

/** Світ із чотирма гравцями, який трохи пожив: у знімку є кулі, астероїди й бонуси. */
function livingWorld(steps = 400) {
  const world = new World({ width: 1280, height: 720, seed: 42 });
  for (const id of ['a', 'b', 'c', 'd']) world.addPlayer(id);
  world.populate();
  const rng = createRng(5);
  const events = [];
  world.addEventListener('exploded', (event) => {
    const { kind, size, x, y } = event.detail;
    events.push({ type: 'explosion', kind, size, x, y });
  });
  for (let i = 0; i < steps; i += 1) {
    for (const id of ['a', 'b', 'c', 'd']) {
      world.setInput(id, {
        thrust: rng() < 0.6,
        turn: Math.floor(rng() * 3) - 1,
        fire: rng() < 0.5,
        missile: false,
      });
    }
    world.step(TICK_DT);
  }
  return { world, events };
}

describe('бінарний кодек: INPUT', () => {
  const message = {
    type: 'input',
    seq: 1234567,
    tick: 98765,
    thrust: true,
    turn: -1,
    fire: true,
    missile: false,
    prev: [
      { thrust: true, turn: -1, fire: false, missile: false },
      { thrust: false, turn: 0, fire: true, missile: true },
      { thrust: true, turn: 1, fire: false, missile: false },
    ],
  };

  test('round-trip збігається точно (turn ∈ {-1, 0, 1} кодується без втрат)', () => {
    assert.deepEqual(binaryCodec.decode(binaryCodec.encode(message)), message);
  });

  test('розмір кадру: 15 + 2·count байт', () => {
    assert.equal(binaryCodec.encode(message).byteLength, 21);
    assert.equal(binaryCodec.encode({ ...message, prev: [] }).byteLength, 15);
  });

  test('аналоговий turn квантується в Int8 (крок 1/127)', () => {
    const decoded = binaryCodec.decode(binaryCodec.encode({ ...message, turn: 0.5, prev: [] }));
    assert.ok(Math.abs(decoded.turn - 0.5) <= 0.5 / 127 + 1e-9);
  });

  test('порядок байтів - little-endian', () => {
    const view = new DataView(binaryCodec.encode({ ...message, seq: 0x01020304, prev: [] }));
    assert.equal(view.getUint8(0), 0xd6);
    assert.equal(view.getUint8(1), 1);
    assert.equal(view.getUint8(4), 0x04); // молодший байт першим
    assert.equal(view.getUint8(7), 0x01);
  });

  test('expandInputMessage розгортає історію від старішої до новішої', () => {
    const commands = expandInputMessage(message);
    assert.deepEqual(
      commands.map((command) => command.seq),
      [message.seq - 3, message.seq - 2, message.seq - 1, message.seq],
    );
    assert.equal(commands.at(-1).fire, true);
  });

  test('биті кадри відхиляються з BinaryFormatError', () => {
    const good = binaryCodec.encode(message);
    const cases = {
      'порожній кадр': new ArrayBuffer(0),
      'хибний magic': Uint8Array.from([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer,
      'інша версія': Uint8Array.from([0xd6, 9, 1, 0]).buffer,
      'невідомий тип': Uint8Array.from([0xd6, 1, 99, 0]).buffer,
      'обрізаний кадр': good.slice(0, good.byteLength - 1),
    };
    for (const [label, buffer] of Object.entries(cases)) {
      assert.throws(() => binaryCodec.decode(buffer), BinaryFormatError, label);
    }
  });
});

describe('бінарний кодек: SNAPSHOT', () => {
  test('round-trip реального знімка в межах точності квантування', () => {
    const { world, events } = livingWorld();
    const message = buildSnapshotMessage(world, { tick: 4242, events });
    message.lastProcessedSeq = 777;
    assert.ok(message.ships.length === 4);
    assert.ok(message.asteroids.length > 0);

    const decoded = binaryCodec.decode(binaryCodec.encode(message));
    assert.equal(decoded.type, 'snapshot');
    assert.equal(decoded.tick, 4242);
    assert.equal(decoded.lastProcessedSeq, 777);
    assert.equal(decoded.ships.length, message.ships.length);
    assert.equal(decoded.asteroids.length, message.asteroids.length);
    assert.equal(decoded.bullets.length, message.bullets.length);
    assert.equal(decoded.pickups.length, message.pickups.length);
    assert.equal(decoded.events.length, message.events.length);

    message.ships.forEach((ship, i) => {
      const out = decoded.ships[i];
      assert.equal(out.id, ship.id);
      assert.equal(out.x, F32(ship.x));
      assert.equal(out.y, F32(ship.y));
      assert.equal(out.vx, F32(ship.vx));
      assert.equal(out.vy, F32(ship.vy));
      assert.ok(Math.abs(out.angle - ship.angle) <= ANGLE_TOLERANCE, 'кут: Int16, 1/1000 рад');
      assert.equal(out.hp, Math.round(ship.hp));
      assert.equal(out.alive, ship.alive);
      assert.equal(out.thrust, ship.thrust);
      assert.equal(out.rapid, ship.rapid);
      assert.equal(out.score, ship.score);
      assert.ok(Math.abs(out.invulnerable - ship.invulnerable) <= 0.05 + 1e-9);
      assert.ok(Math.abs(out.fireCooldown - ship.fireCooldown) <= 0.0005 + 1e-9);
    });
    message.asteroids.forEach((a, i) => {
      const out = decoded.asteroids[i];
      assert.equal(out.id, a.id);
      assert.equal(out.size, a.size);
      assert.equal(out.hunter, a.hunter);
      assert.equal(out.x, F32(a.x));
      assert.ok(Math.abs(out.vx - a.vx) <= 0.05 + 1e-9);
      assert.ok(Math.abs(out.angle - a.angle) <= ANGLE_TOLERANCE);
    });
    message.bullets.forEach((b, i) => {
      const out = decoded.bullets[i];
      assert.equal(out.id, b.id);
      assert.equal(out.owner, b.owner);
      assert.equal(out.missile, b.missile);
      assert.ok(Math.abs(out.vy - b.vy) <= 0.05 + 1e-9);
    });
    message.events.forEach((e, i) => {
      assert.equal(decoded.events[i].kind, e.kind);
      assert.equal(decoded.events[i].x, F32(e.x));
    });
  });

  test('кут на межах (-π, π] кодується Int16 без переповнення', () => {
    const { world } = livingWorld(10);
    const message = buildSnapshotMessage(world, { tick: 1 });
    for (const angle of [Math.PI, -Math.PI + 1e-6, 0, 1.2345678, -2.7182818]) {
      message.ships[0].angle = angle;
      const out = binaryCodec.decode(binaryCodec.encode(message)).ships[0];
      assert.ok(Math.abs(out.angle - angle) <= ANGLE_TOLERANCE, `angle=${angle}`);
    }
  });

  test('розмір відповідає специфікації розкладки', () => {
    const { world, events } = livingWorld();
    const m = buildSnapshotMessage(world, { tick: 1, events });
    const expected =
      19 +
      m.ships.length * RECORD_BYTES.ship +
      m.asteroids.length * RECORD_BYTES.asteroid +
      m.bullets.length * RECORD_BYTES.bullet +
      m.pickups.length * RECORD_BYTES.pickup +
      m.events.length * RECORD_BYTES.event;
    assert.equal(binaryCodec.encode(m).byteLength, expected);
  });

  test('snapshotForClient підставляє lastProcessedSeq й не чіпає оригінал', () => {
    const { world } = livingWorld(20);
    const base = binaryCodec.encode(buildSnapshotMessage(world, { tick: 9 }));
    const a = snapshotForClient(base, 11);
    const b = snapshotForClient(base, 22);
    assert.equal(binaryCodec.decode(a).lastProcessedSeq, 11);
    assert.equal(binaryCodec.decode(b).lastProcessedSeq, 22);
    assert.equal(binaryCodec.decode(base).lastProcessedSeq, 0);
    assert.equal(a.byteLength, base.byteLength);
  });

  test('бінарний знімок істотно менший за JSON (4 гравці)', () => {
    const { world, events } = livingWorld();
    const message = buildSnapshotMessage(world, { tick: 1, events });
    const binary = binaryCodec.encode(message).byteLength;
    const json = new TextEncoder().encode(jsonCodec.encode(message)).byteLength;
    assert.ok(binary * 2 < json, `binary=${binary}, json=${json}`);
  });
});

describe('PING / PONG', () => {
  test('round-trip f64 clientTime і u32 serverTick', () => {
    const ping = { type: 'ping', clientTime: 123456.789012 };
    assert.deepEqual(binaryCodec.decode(binaryCodec.encode(ping)), ping);
    const pong = { type: 'pong', clientTime: 99.5, serverTick: 3_000_000_000 };
    assert.deepEqual(binaryCodec.decode(binaryCodec.encode(pong)), pong);
  });
});

describe('JSON-кодек', () => {
  test('round-trip усіх типів повідомлень', () => {
    const { world, events } = livingWorld(60);
    const messages = [
      buildSnapshotMessage(world, { tick: 5, events }),
      {
        type: 'input',
        seq: 5,
        tick: 6,
        thrust: true,
        turn: 1,
        fire: false,
        missile: false,
        prev: [],
      },
      { type: 'ping', clientTime: 12.5 },
      { type: 'pong', clientTime: 12.5, serverTick: 77 },
    ];
    for (const message of messages) {
      const decoded = jsonCodec.decode(jsonCodec.encode(message));
      assert.equal(decoded.type, message.type);
      assert.equal(decoded.v, undefined);
      assert.deepEqual(JSON.parse(JSON.stringify(decoded)), decoded);
    }
    const input = messages[1];
    assert.deepEqual(jsonCodec.decode(jsonCodec.encode(input)), input);
  });

  test('відхиляє не JSON, хибну версію й відсутній type', () => {
    assert.throws(() => jsonCodec.decode('{oops'));
    assert.throws(() => jsonCodec.decode('{"v":2,"type":"input"}'));
    assert.throws(() => jsonCodec.decode('{"v":1}'));
    assert.throws(() => jsonCodec.decode('[1,2]'));
  });

  test('getCodec вибирає реалізацію за назвою', () => {
    assert.equal(getCodec('binary'), binaryCodec);
    assert.equal(getCodec('json'), jsonCodec);
    assert.throws(() => getCodec('xml'));
  });
});

describe('валідація вводу (антиcheat)', () => {
  const good = { seq: 5, tick: 10, thrust: true, turn: 1, fire: false, missile: false };

  test('коректна команда проходить', () => {
    assert.deepEqual(validateInput(good), { ok: true, input: good });
  });

  test('читерські й некоректні значення відсікаються', () => {
    const bad = {
      'turn > 1': { ...good, turn: 5 },
      'turn < -1': { ...good, turn: -1.01 },
      'turn NaN': { ...good, turn: Number.NaN },
      'turn Infinity': { ...good, turn: Infinity },
      'turn рядок': { ...good, turn: '1' },
      'thrust число': { ...good, thrust: 100 },
      'fire рядок': { ...good, fire: 'yes' },
      'seq дробовий': { ...good, seq: 1.5 },
      'seq від’ємний': { ...good, seq: -1 },
      'tick надвеликий': { ...good, tick: 2 ** 40 },
      'не об’єкт': null,
    };
    for (const [label, input] of Object.entries(bad)) {
      assert.equal(validateInput(input).ok, false, label);
    }
  });

  test('turn поза діапазоном, закодований у Int8, також відсікається після декодування', () => {
    const buffer = binaryCodec.encode({ type: 'input', ...good, prev: [] });
    new DataView(buffer).setInt8(14, -128); // -128/127 = -1.0079
    const decoded = binaryCodec.decode(buffer);
    assert.equal(validateInput(decoded).ok, false);
  });

  test('історія обмежена INPUT_LIMITS.maxHistory', () => {
    const prev = Array.from({ length: 10 }, () => ({ thrust: false, turn: 0, fire: false }));
    const commands = expandInputMessage({ ...good, seq: 100, prev });
    assert.equal(commands.length, INPUT_LIMITS.maxHistory + 1);
  });
});
