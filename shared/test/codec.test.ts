import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  asSeq,
  asTick,
  binaryCodec,
  BinaryFormatError,
  buildSnapshotMessage,
  createRng,
  expandInputMessage,
  getCodec,
  INPUT_LIMITS,
  jsonCodec,
  MsgType,
  parseClientMessage,
  RECORD_BYTES,
  snapshotForClient,
  TICK_DT,
  validateInput,
  World,
  type GameMessage,
  type InputMessage,
  type NetExplosionEvent,
  type SnapshotMessage,
} from '@dogfight/shared';

const ANGLE_TOLERANCE = 0.0005 + 1e-9;
const F32 = (value: number): number => Math.fround(value);

function livingWorld(steps = 400): { world: World; events: NetExplosionEvent[] } {
  const world = new World({ width: 1280, height: 720, seed: 42 });
  for (const id of ['a', 'b', 'c', 'd']) world.addPlayer(id);
  world.populate();
  const rng = createRng(5);
  const events: NetExplosionEvent[] = [];
  world.addEventListener('exploded', (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail;
    if (detail && (detail.kind === 'ship' || detail.kind === 'asteroid')) {
      events.push({
        type: 'explosion',
        kind: detail.kind,
        size: detail.size,
        x: detail.x,
        y: detail.y,
      });
    }
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
  const message: InputMessage = {
    type: MsgType.INPUT,
    seq: asSeq(1234567),
    tick: asTick(98765),
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
    if (decoded.type !== MsgType.INPUT) assert.fail('очікується INPUT');
    assert.ok(Math.abs(decoded.turn - 0.5) <= 0.5 / 127 + 1e-9);
  });

  test('порядок байтів - little-endian', () => {
    const view = new DataView(binaryCodec.encode({ ...message, seq: asSeq(0x01020304), prev: [] }));
    assert.equal(view.getUint8(0), 0xd6);
    assert.equal(view.getUint8(1), 1);
    assert.equal(view.getUint8(4), 0x04);
    assert.equal(view.getUint8(7), 0x01);
  });

  test('expandInputMessage розгортає історію від старішої до новішої', () => {
    const commands = expandInputMessage(message);
    assert.equal(commands.length, 4);
  });

  test('биті кадри відхиляються з BinaryFormatError', () => {
    const good = binaryCodec.encode(message);
    const cases: Record<string, ArrayBuffer> = {
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
    const message: SnapshotMessage = {
      ...buildSnapshotMessage(world, { tick: asTick(4242), events }),
      lastProcessedSeq: asSeq(777),
    };
    assert.equal(message.ships.length, 4);
    assert.ok(message.asteroids.length > 0);

    const decoded = binaryCodec.decode(binaryCodec.encode(message));
    if (decoded.type !== MsgType.SNAPSHOT) assert.fail('очікується SNAPSHOT');
    assert.equal(decoded.tick, 4242);
    assert.equal(decoded.lastProcessedSeq, 777);
    assert.equal(decoded.ships.length, message.ships.length);
    assert.equal(decoded.asteroids.length, message.asteroids.length);
    assert.equal(decoded.bullets.length, message.bullets.length);

    message.ships.forEach((ship, i) => {
      const out = decoded.ships[i];
      if (!out) assert.fail('відсутній запис судна');
      assert.equal(out.id, ship.id);
      assert.equal(out.x, F32(ship.x));
      assert.equal(out.y, F32(ship.y));
      assert.ok(Math.abs(out.angle - ship.angle) <= ANGLE_TOLERANCE);
      assert.equal(out.hp, Math.round(ship.hp));
      assert.equal(out.score, ship.score);
    });
  });

  test('кут на межах (-π, π] кодується Int16 без переповнення', () => {
    const { world } = livingWorld(10);
    const base = buildSnapshotMessage(world, { tick: asTick(1) });
    const first = base.ships[0];
    if (!first) assert.fail('відсутнє судно');
    for (const angle of [Math.PI, -Math.PI + 1e-6, 0, 1.2345678, -2.7182818]) {
      const msg: SnapshotMessage = {
        ...base,
        ships: [{ ...first, angle }, ...base.ships.slice(1)],
      };
      const decoded = binaryCodec.decode(binaryCodec.encode(msg));
      if (decoded.type !== MsgType.SNAPSHOT) assert.fail('очікується SNAPSHOT');
      const out = decoded.ships[0];
      if (!out) assert.fail('відсутній запис судна');
      assert.ok(Math.abs(out.angle - angle) <= ANGLE_TOLERANCE, `angle=${angle}`);
    }
  });

  test('розмір відповідає специфікації розкладки', () => {
    const { world, events } = livingWorld();
    const m = buildSnapshotMessage(world, { tick: asTick(1), events });
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
    const base = binaryCodec.encode(buildSnapshotMessage(world, { tick: asTick(9) }));
    const a = snapshotForClient(base, asSeq(11));
    const b = snapshotForClient(base, asSeq(22));
    const decA = binaryCodec.decode(a);
    const decB = binaryCodec.decode(b);
    const decBase = binaryCodec.decode(base);
    if (
      decA.type !== MsgType.SNAPSHOT ||
      decB.type !== MsgType.SNAPSHOT ||
      decBase.type !== MsgType.SNAPSHOT
    ) {
      assert.fail('очікується SNAPSHOT');
    }
    assert.equal(decA.lastProcessedSeq, 11);
    assert.equal(decB.lastProcessedSeq, 22);
    assert.equal(decBase.lastProcessedSeq, 0);
  });

  test('бінарний знімок істотно менший за JSON (4 гравці)', () => {
    const { world, events } = livingWorld();
    const message = buildSnapshotMessage(world, { tick: asTick(1), events });
    const binary = binaryCodec.encode(message).byteLength;
    const json = new TextEncoder().encode(jsonCodec.encode(message)).byteLength;
    assert.ok(binary * 2 < json, `binary=${binary}, json=${json}`);
  });
});

describe('PING / PONG та JSON-кодек', () => {
  test('round-trip f64 clientTime і u32 serverTick', () => {
    const ping: GameMessage = { type: MsgType.PING, clientTime: 123456.789012 };
    assert.deepEqual(binaryCodec.decode(binaryCodec.encode(ping)), ping);
    const pong: GameMessage = {
      type: MsgType.PONG,
      clientTime: 99.5,
      serverTick: asTick(3_000_000_000),
    };
    assert.deepEqual(binaryCodec.decode(binaryCodec.encode(pong)), pong);
  });

  test('JSON-кодек: round-trip і відхилення хибних кадрів', () => {
    const { world, events } = livingWorld(60);
    const messages: GameMessage[] = [
      buildSnapshotMessage(world, { tick: asTick(5), events }),
      {
        type: MsgType.INPUT,
        seq: asSeq(5),
        tick: asTick(6),
        thrust: true,
        turn: 1,
        fire: false,
        missile: false,
        prev: [],
      },
      { type: MsgType.PING, clientTime: 12.5 },
      { type: MsgType.PONG, clientTime: 12.5, serverTick: asTick(77) },
    ];
    for (const message of messages) {
      const decoded = jsonCodec.decode(jsonCodec.encode(message));
      assert.equal(decoded.type, message.type);
    }
    assert.throws(() => jsonCodec.decode('{oops'));
    assert.throws(() => jsonCodec.decode('{"v":2,"type":"input"}'));
    assert.equal(getCodec('binary'), binaryCodec);
    assert.equal(getCodec('json'), jsonCodec);
  });
});

describe('валідація вводу і Zod parseClientMessage', () => {
  const good = { seq: 5, tick: 10, thrust: true, turn: 1, fire: false, missile: false };

  test('коректна команда проходить, читерські відсікаються', () => {
    const ok = validateInput(good);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.data.seq, 5);
      assert.equal(ok.data.tick, 10);
    }
    for (const bad of [
      { ...good, turn: 5 },
      { ...good, turn: -1.01 },
      { ...good, turn: Number.NaN },
      { ...good, thrust: 100 },
      { ...good, seq: -1 },
      null,
    ]) {
      assert.equal(validateInput(bad).ok, false);
    }
  });

  test('turn поза діапазоном у Int8 відсікається після декодування', () => {
    const buffer = binaryCodec.encode({
      type: MsgType.INPUT,
      seq: asSeq(5),
      tick: asTick(10),
      thrust: true,
      turn: 1,
      fire: false,
      missile: false,
      prev: [],
    });
    new DataView(buffer).setInt8(14, -128);
    const decoded = binaryCodec.decode(buffer);
    assert.equal(validateInput(decoded).ok, false);
  });

  test('parseClientMessage через Zod валідує join/chat і відхиляє зайві поля', () => {
    const ok = parseClientMessage(
      JSON.stringify({ v: 1, type: 'join', room: 'alpha-1', nickname: '  Ace  ' }),
    );
    assert.equal(ok.ok, true);
    if (ok.ok && ok.data.type === 'join') {
      assert.equal(ok.data.nickname, 'Ace');
    }
    const extra = parseClientMessage(
      JSON.stringify({ v: 1, type: 'join', room: 'alpha-1', nickname: 'Ace', admin: true }),
    );
    assert.equal(extra.ok, false);
  });

  test('історія обмежена INPUT_LIMITS.maxHistory', () => {
    const prev = Array.from({ length: 10 }, () => ({ thrust: false, turn: 0, fire: false }));
    const commands = expandInputMessage({ ...good, seq: 100, prev });
    assert.equal(commands.length, INPUT_LIMITS.maxHistory + 1);
  });
});
