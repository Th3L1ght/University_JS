import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  asEntityId,
  asSeq,
  asTick,
  binaryCodec,
  BinaryFormatError,
  CloseCode,
  encodeServerMessage,
  expandInputMessage,
  getCodec,
  HEADER_BYTES,
  INPUT_LIMITS,
  isCodecName,
  jsonCodec,
  makeRoomId,
  MsgType,
  parseClientMessage,
  PROTOCOL_VERSION,
  RECORD_BYTES,
  shipStateFromNet,
  snapshotForClient,
  TICK_DT,
  validateInput,
  validateRoomInput,
  World,
  type InputMessage,
  type SnapshotMessage,
} from '@dogfight/shared';

const ANGLE_TOLERANCE = 0.0005 + 1e-6;
const VEL_TOLERANCE = 0.05 + 1e-6;

const arbPrevCmd = fc.record({
  thrust: fc.boolean(),
  turn: fc.constantFrom(-1, 0, 1),
  fire: fc.boolean(),
  missile: fc.boolean(),
});

const arbInputMessage: fc.Arbitrary<InputMessage> = fc.record({
  type: fc.constant(MsgType.INPUT),
  seq: fc.integer({ min: 0, max: 0xffffffff }).map(asSeq),
  tick: fc.integer({ min: 0, max: 0xffffffff }).map(asTick),
  thrust: fc.boolean(),
  turn: fc.constantFrom(-1, 0, 1),
  fire: fc.boolean(),
  missile: fc.boolean(),
  prev: fc.array(arbPrevCmd, { minLength: 0, maxLength: INPUT_LIMITS.maxHistory }),
});

const arbNetShip = fc.record({
  id: fc.integer({ min: 1, max: 100000 }).map(asEntityId),
  x: fc.double({ min: 0, max: 1280, noNaN: true }).map(Math.fround),
  y: fc.double({ min: 0, max: 720, noNaN: true }).map(Math.fround),
  vx: fc.double({ min: -500, max: 500, noNaN: true }).map(Math.fround),
  vy: fc.double({ min: -500, max: 500, noNaN: true }).map(Math.fround),
  angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  hp: fc.integer({ min: 0, max: 100 }),
  alive: fc.boolean(),
  thrust: fc.boolean(),
  rapid: fc.boolean(),
  invulnerable: fc.integer({ min: 0, max: 100 }).map((n) => n / 10),
  fireCooldown: fc.integer({ min: 0, max: 250 }).map((n) => n / 1000),
  rapidLeft: fc.integer({ min: 0, max: 100 }).map((n) => n / 10),
  respawnIn: fc.integer({ min: 0, max: 100 }).map((n) => n / 10),
  score: fc.integer({ min: 0, max: 1000000 }),
});

const arbNetAsteroid = fc.record({
  id: fc.integer({ min: 1, max: 100000 }).map(asEntityId),
  x: fc.double({ min: 0, max: 1280, noNaN: true }).map(Math.fround),
  y: fc.double({ min: 0, max: 720, noNaN: true }).map(Math.fround),
  vx: fc.double({ min: -500, max: 500, noNaN: true }),
  vy: fc.double({ min: -500, max: 500, noNaN: true }),
  angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  size: fc.constantFrom<1 | 2 | 3>(1, 2, 3),
  hunter: fc.boolean(),
});

const arbNetBullet = fc.record({
  id: fc.integer({ min: 1, max: 100000 }).map(asEntityId),
  x: fc.double({ min: 0, max: 1280, noNaN: true }).map(Math.fround),
  y: fc.double({ min: 0, max: 720, noNaN: true }).map(Math.fround),
  vx: fc.double({ min: -1000, max: 1000, noNaN: true }),
  vy: fc.double({ min: -1000, max: 1000, noNaN: true }),
  owner: fc.integer({ min: 1, max: 100000 }).map(asEntityId),
  missile: fc.boolean(),
});

const arbNetPickup = fc.record({
  id: fc.integer({ min: 1, max: 100000 }).map(asEntityId),
  x: fc.double({ min: 0, max: 1280, noNaN: true }).map(Math.fround),
  y: fc.double({ min: 0, max: 720, noNaN: true }).map(Math.fround),
  effect: fc.constantFrom<'heal' | 'rapid'>('heal', 'rapid'),
  remaining: fc.integer({ min: 0, max: 30 }),
});

const arbSnapshotMessage: fc.Arbitrary<SnapshotMessage> = fc.record({
  type: fc.constant(MsgType.SNAPSHOT),
  tick: fc.integer({ min: 0, max: 0xffffffff }).map(asTick),
  lastProcessedSeq: fc.integer({ min: 0, max: 0xffffffff }).map(asSeq),
  ships: fc.array(arbNetShip, { maxLength: 8 }),
  asteroids: fc.array(arbNetAsteroid, { maxLength: 12 }),
  bullets: fc.array(arbNetBullet, { maxLength: 16 }),
  pickups: fc.array(arbNetPickup, { maxLength: 4 }),
  events: fc.array(
    fc.record({
      type: fc.constant<'explosion'>('explosion'),
      kind: fc.constantFrom<'ship' | 'asteroid'>('ship', 'asteroid'),
      size: fc.integer({ min: 0, max: 3 }),
      x: fc.double({ min: 0, max: 1280, noNaN: true }).map(Math.fround),
      y: fc.double({ min: 0, max: 720, noNaN: true }).map(Math.fround),
    }),
    { maxLength: 4 },
  ),
});

describe('Property-based тести (fast-check)', () => {
  it('Властивість 1: round-trip бінарного кодека в межах точності квантування Int16', () => {
    fc.assert(
      fc.property(arbInputMessage, (msg) => {
        const decoded = binaryCodec.decode(binaryCodec.encode(msg));
        expect(decoded).toEqual(msg);
      }),
      { numRuns: 100 },
    );

    fc.assert(
      fc.property(arbSnapshotMessage, (snap) => {
        const decoded = binaryCodec.decode(binaryCodec.encode(snap));
        expect(decoded.type).toBe(MsgType.SNAPSHOT);
        if (decoded.type !== MsgType.SNAPSHOT) return;
        expect(decoded.tick).toBe(snap.tick);
        expect(decoded.lastProcessedSeq).toBe(snap.lastProcessedSeq);
        expect(decoded.ships.length).toBe(snap.ships.length);
        for (let i = 0; i < snap.ships.length; i += 1) {
          const a = snap.ships[i];
          const b = decoded.ships[i];
          if (!a || !b) continue;
          expect(b.id).toBe(a.id);
          expect(Math.abs(b.angle - a.angle)).toBeLessThanOrEqual(ANGLE_TOLERANCE);
          expect(b.hp).toBe(a.hp);
        }
        for (let i = 0; i < snap.asteroids.length; i += 1) {
          const a = snap.asteroids[i];
          const b = decoded.asteroids[i];
          if (!a || !b) continue;
          expect(Math.abs(b.vx - a.vx)).toBeLessThanOrEqual(VEL_TOLERANCE);
          expect(Math.abs(b.angle - a.angle)).toBeLessThanOrEqual(ANGLE_TOLERANCE);
        }
      }),
      { numRuns: 80 },
    );
  });

  it('Властивість 2: довжина закодованого буфера строго відповідає специфікації', () => {
    fc.assert(
      fc.property(arbInputMessage, (msg) => {
        const buf = binaryCodec.encode(msg);
        expect(buf.byteLength).toBe(15 + 2 * msg.prev.length);
        expect(buf.byteLength).toBeGreaterThanOrEqual(HEADER_BYTES);
      }),
      { numRuns: 100 },
    );

    fc.assert(
      fc.property(arbSnapshotMessage, (snap) => {
        const expected =
          19 +
          snap.ships.length * RECORD_BYTES.ship +
          snap.asteroids.length * RECORD_BYTES.asteroid +
          snap.bullets.length * RECORD_BYTES.bullet +
          snap.pickups.length * RECORD_BYTES.pickup +
          snap.events.length * RECORD_BYTES.event;
        expect(binaryCodec.encode(snap).byteLength).toBe(expected);
      }),
      { numRuns: 80 },
    );
  });

  it('Властивість 3: довільні биті буфери викликають лише BinaryFormatError без падіння процесу', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 128 }), (bytes) => {
        try {
          const decoded = binaryCodec.decode(bytes);
          expect(typeof decoded.type).toBe('string');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(BinaryFormatError);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('Властивість 4: корабель ніколи не покидає межі арени за 1000 випадкових кроків', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.array(
          fc.record({
            thrust: fc.boolean(),
            turn: fc.double({ min: -1, max: 1, noNaN: true }),
            fire: fc.boolean(),
          }),
          { minLength: 20, maxLength: 20 },
        ),
        (seed, pattern) => {
          const world = new World({
            width: 1280,
            height: 720,
            seed,
            rules: { initialAsteroids: 0, minAsteroids: 0 },
          });
          const p = world.addPlayer('hero');
          for (let step = 0; step < 1000; step += 1) {
            const cmd = pattern[step % pattern.length];
            if (cmd) world.setInput('hero', cmd);
            world.step(TICK_DT);
            if (p.ship.alive) {
              expect(p.ship.pos.x).toBeGreaterThanOrEqual(0);
              expect(p.ship.pos.x).toBeLessThan(1280);
              expect(p.ship.pos.y).toBeGreaterThanOrEqual(0);
              expect(p.ship.pos.y).toBeLessThan(720);
            }
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it('Властивість 5: parseClientMessage приймає згенеровані валідні повідомлення й відхиляє невалідні мутації', () => {
    const arbRoomId = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{2,20}$/);
    const arbNick = fc.stringMatching(/^[A-Za-z0-9]{2,14}$/);
    const arbChat = fc.stringMatching(/^[A-Za-z0-9 ]{2,40}$/).filter((s) => s.trim().length >= 1);

    const arbValidClient = fc.oneof(
      fc.record({
        v: fc.constant(PROTOCOL_VERSION),
        type: fc.constant('join'),
        room: arbRoomId,
        nickname: arbNick,
      }),
      fc.record({ v: fc.constant(PROTOCOL_VERSION), type: fc.constant('chat'), text: arbChat }),
      fc.constant({ v: PROTOCOL_VERSION, type: 'leave' }),
      fc.record({
        v: fc.constant(PROTOCOL_VERSION),
        type: fc.constant('ping'),
        t: fc.integer({ min: 0, max: 10000 }),
      }),
      fc.record({
        v: fc.constant(PROTOCOL_VERSION),
        type: fc.constant('ready'),
        codec: fc.constantFrom('binary', 'json'),
      }),
    );

    fc.assert(
      fc.property(arbValidClient, (msg) => {
        const res = parseClientMessage(JSON.stringify(msg));
        expect(res.ok).toBe(true);

        // Мутація 1: хибна версія.
        const badVer = parseClientMessage(JSON.stringify({ ...msg, v: 99 }));
        expect(badVer.ok).toBe(false);

        // Мутація 2: зайве поле.
        const extraField = parseClientMessage(JSON.stringify({ ...msg, __cheat: 1 }));
        expect(extraField.ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Кодеки, протокол і допоміжні утиліти', () => {
  it('jsonCodec, getCodec, isCodecName, snapshotForClient, shipStateFromNet', () => {
    expect(isCodecName('binary')).toBe(true);
    expect(isCodecName('json')).toBe(true);
    expect(isCodecName('xml')).toBe(false);
    expect(getCodec('binary')).toBe(binaryCodec);
    expect(getCodec('json')).toBe(jsonCodec);

    const ping = { type: MsgType.PING, clientTime: 42.25 } as const;
    expect(jsonCodec.decode(jsonCodec.encode(ping))).toEqual(ping);

    const snap: SnapshotMessage = {
      type: MsgType.SNAPSHOT,
      tick: asTick(10),
      lastProcessedSeq: asSeq(0),
      ships: [
        {
          id: asEntityId(1),
          x: 10,
          y: 20,
          vx: 1,
          vy: 2,
          angle: 0,
          hp: 100,
          alive: true,
          thrust: true,
          rapid: true,
          invulnerable: 0,
          fireCooldown: 0,
          rapidLeft: 4,
          respawnIn: 0,
          score: 10,
        },
      ],
      asteroids: [],
      bullets: [],
      pickups: [],
      events: [],
    };
    const patched = snapshotForClient(binaryCodec.encode(snap), asSeq(77));
    const dec = binaryCodec.decode(patched);
    expect(dec.type === MsgType.SNAPSHOT && dec.lastProcessedSeq).toBe(77);
    const firstShip = snap.ships[0];
    expect(firstShip && shipStateFromNet(firstShip).buffs?.length).toBe(1);
  });

  it('validateInput, expandInputMessage, validateRoomInput, encodeServerMessage, makeRoomId', () => {
    expect(validateInput({ seq: 1, tick: 1, thrust: true, turn: 0, fire: false }).ok).toBe(true);
    expect(validateInput({ seq: 1, tick: 1, thrust: true, turn: 2, fire: false }).ok).toBe(false);
    expect(
      expandInputMessage({
        seq: 5,
        tick: 10,
        thrust: true,
        turn: 0,
        fire: false,
        prev: [{ thrust: false }],
      }).length,
    ).toBe(2);
    expect(validateRoomInput({ name: 'Room A' }).ok).toBe(true);
    expect(validateRoomInput(null).ok).toBe(false);
    expect(JSON.parse(encodeServerMessage({ type: 'pong', t: 1 })).v).toBe(1);
    expect(makeRoomId('Alpha', () => 0)).toBe('alpha-0000');
    expect(CloseCode.MESSAGE_TOO_BIG).toBe(1009);
  });

  it('binaryCodec: PING і PONG round-trip і хибні довжини', () => {
    const ping = { type: MsgType.PING, clientTime: 123.456 } as const;
    const pong = { type: MsgType.PONG, clientTime: 123.456, serverTick: asTick(999) } as const;
    expect(binaryCodec.decode(binaryCodec.encode(ping))).toEqual(ping);
    expect(binaryCodec.decode(binaryCodec.encode(pong))).toEqual(pong);
    expect(() => binaryCodec.decode(binaryCodec.encode(ping).slice(0, 8))).toThrow(
      BinaryFormatError,
    );
    expect(() => binaryCodec.decode(binaryCodec.encode(pong).slice(0, 8))).toThrow(
      BinaryFormatError,
    );
  });

  it('jsonCodec: відхиляє не-JSON, масив, чужу версію і відсутній type', () => {
    expect(() => jsonCodec.decode('{bad')).toThrow();
    expect(() => jsonCodec.decode('[]')).toThrow();
    expect(() => jsonCodec.decode('{"v":9,"type":"ping"}')).toThrow();
    expect(() => jsonCodec.decode('{"v":1}')).toThrow();
  });

  it('parseClientMessage: ArrayBuffer, maxBytes, керуючі символи, невідомий type', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, type: 'leave' }));
    expect(parseClientMessage(bytes.buffer).ok).toBe(true);
    expect(parseClientMessage(bytes).ok).toBe(true);

    const tooBig = parseClientMessage(
      JSON.stringify({ v: 1, type: 'chat', text: 'a'.repeat(100) }),
      {
        maxBytes: 20,
      },
    );
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error.closeCode).toBe(CloseCode.MESSAGE_TOO_BIG);

    const ctrl = parseClientMessage(JSON.stringify({ v: 1, type: 'chat', text: 'hi\u0007' }));
    expect(ctrl.ok).toBe(false);

    const unknown = parseClientMessage(JSON.stringify({ v: 1, type: 'unknown_cmd' }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.closeCode).toBe(CloseCode.POLICY_VIOLATION);
  });

  it('validateRoomInput: межі параметрів арени, зайві поля і maxPlayers', () => {
    const ok = validateRoomInput({
      name: 'Belt',
      maxPlayers: 4,
      arena: { initialAsteroids: 10, hunterChance: 0.5, seed: 42 },
    });
    expect(ok.ok).toBe(true);
    expect(validateRoomInput({ name: 'Belt', arena: { hunterChance: 2 } }).ok).toBe(false);
    expect(validateRoomInput({ name: 'Belt', maxPlayers: 1 }).ok).toBe(false);
    expect(validateRoomInput({ name: 'Belt', extra: true }).ok).toBe(false);
  });
});
