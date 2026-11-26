/**
 * Бінарний кодек ігрового трафіку на ArrayBuffer + DataView.
 *
 * ВСІ багатобайтові числа - little-endian (третій аргумент DataView: `true`).
 * Заголовок 4 байти: [0] magic 0xD6, [1] version 1, [2] type (1..4), [3] reserved 0.
 * Кут квантується в Int16 у кроці 1/1000 рад (похибка ≤ 0.0005 рад).
 */

import { codeToEffect, effectToCode } from '../net_snapshot.ts';
import {
  INPUT_LIMITS,
  MsgType,
  type GameMessage,
  type InputMessage,
  type NetAsteroid,
  type NetBullet,
  type NetExplosionEvent,
  type NetPickup,
  type NetShip,
  type PingMessage,
  type PongMessage,
  type PrevInputCommand,
  type SnapshotMessage,
} from '../protocol.ts';
import { isAsteroidSize, type AsteroidSize } from '../sim/asteroid.ts';
import { asEntityId, asSeq, asTick, assertNever, type Seq } from '../types.ts';

export const FRAME_MAGIC = 0xd6;
export const FRAME_VERSION = 1;

export const FrameType = { INPUT: 1, SNAPSHOT: 2, PING: 3, PONG: 4 } as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export const HEADER_BYTES = 4;
export const SNAPSHOT_SEQ_OFFSET = 8;
const SNAPSHOT_FIXED_BYTES = 19;

export const RECORD_BYTES = Object.freeze({
  ship: 32,
  asteroid: 19,
  bullet: 21,
  pickup: 14,
  event: 11,
});

const LE = true;
const ANGLE_SCALE = 1000;
const VEL_SCALE = 10;

const FLAG_THRUST = 1;
const FLAG_FIRE = 2;
const FLAG_MISSILE = 4;
const INPUT_FLAGS_MASK = FLAG_THRUST | FLAG_FIRE | FLAG_MISSILE;

const EVENT_KINDS = ['ship', 'asteroid'] as const;

export class BinaryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinaryFormatError';
  }
}

export interface Codec<TEncoded, TDecoded = TEncoded> {
  readonly name: 'binary' | 'json';
  readonly binary: boolean;
  encode(message: GameMessage): TEncoded;
  decode(frame: TDecoded): GameMessage;
}

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));
const toI16 = (value: number, scale: number): number => clampInt(value * scale, -32768, 32767);
const toU8 = (value: number, scale = 1): number => clampInt(value * scale, 0, 255);

function writeHeader(view: DataView, type: FrameTypeValue): void {
  view.setUint8(0, FRAME_MAGIC);
  view.setUint8(1, FRAME_VERSION);
  view.setUint8(2, type);
  view.setUint8(3, 0);
}

function readHeader(view: DataView): number {
  if (view.byteLength < HEADER_BYTES) throw new BinaryFormatError('кадр коротший за заголовок');
  if (view.getUint8(0) !== FRAME_MAGIC) throw new BinaryFormatError('хибний magic');
  const version = view.getUint8(1);
  if (version !== FRAME_VERSION) {
    throw new BinaryFormatError(`непідтримувана версія бінарного протоколу: ${version}`);
  }
  return view.getUint8(2);
}

function inputFlags(command: PrevInputCommand): number {
  return (
    (command.thrust ? FLAG_THRUST : 0) |
    (command.fire ? FLAG_FIRE : 0) |
    (command.missile ? FLAG_MISSILE : 0)
  );
}

function encodeInput(message: InputMessage): ArrayBuffer {
  const prev = message.prev.slice(0, INPUT_LIMITS.maxHistory);
  const buffer = new ArrayBuffer(15 + 2 * prev.length);
  const view = new DataView(buffer);
  writeHeader(view, FrameType.INPUT);
  view.setUint32(4, message.seq >>> 0, LE);
  view.setUint32(8, message.tick >>> 0, LE);
  view.setUint8(12, prev.length);
  view.setUint8(13, inputFlags(message));
  view.setInt8(14, clampInt(message.turn * 127, -128, 127));
  prev.forEach((command, i) => {
    view.setUint8(15 + 2 * i, inputFlags(command));
    view.setInt8(16 + 2 * i, clampInt(command.turn * 127, -128, 127));
  });
  return buffer;
}

function readCommand(view: DataView, offset: number): PrevInputCommand {
  const flags = view.getUint8(offset);
  if ((flags & ~INPUT_FLAGS_MASK) !== 0) throw new BinaryFormatError('зайві біти прапорців вводу');
  return {
    thrust: (flags & FLAG_THRUST) !== 0,
    turn: view.getInt8(offset + 1) / 127,
    fire: (flags & FLAG_FIRE) !== 0,
    missile: (flags & FLAG_MISSILE) !== 0,
  };
}

function decodeInput(view: DataView): InputMessage {
  if (view.byteLength < 15) throw new BinaryFormatError('INPUT: кадр закороткий');
  const count = view.getUint8(12);
  if (count > INPUT_LIMITS.maxHistory)
    throw new BinaryFormatError('INPUT: забагато команд історії');
  if (view.byteLength !== 15 + 2 * count) throw new BinaryFormatError('INPUT: хибна довжина');
  const prev: PrevInputCommand[] = [];
  for (let i = 0; i < count; i += 1) prev.push(readCommand(view, 15 + 2 * i));
  return {
    type: MsgType.INPUT,
    seq: asSeq(view.getUint32(4, LE)),
    tick: asTick(view.getUint32(8, LE)),
    ...readCommand(view, 13),
    prev,
  };
}

function encodePing(message: PingMessage): ArrayBuffer {
  const buffer = new ArrayBuffer(12);
  const view = new DataView(buffer);
  writeHeader(view, FrameType.PING);
  view.setFloat64(4, message.clientTime, LE);
  return buffer;
}

function encodePong(message: PongMessage): ArrayBuffer {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  writeHeader(view, FrameType.PONG);
  view.setFloat64(4, message.clientTime, LE);
  view.setUint32(12, message.serverTick >>> 0, LE);
  return buffer;
}

function encodeSnapshot(message: SnapshotMessage): ArrayBuffer {
  const { ships, asteroids, bullets, pickups, events } = message;
  if (ships.length > 255 || pickups.length > 255 || events.length > 255) {
    throw new BinaryFormatError('SNAPSHOT: занадто багато записів ships/pickups/events');
  }
  if (asteroids.length > 65535 || bullets.length > 65535) {
    throw new BinaryFormatError('SNAPSHOT: занадто багато записів asteroids/bullets');
  }
  const size =
    SNAPSHOT_FIXED_BYTES +
    ships.length * RECORD_BYTES.ship +
    asteroids.length * RECORD_BYTES.asteroid +
    bullets.length * RECORD_BYTES.bullet +
    pickups.length * RECORD_BYTES.pickup +
    events.length * RECORD_BYTES.event;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  writeHeader(view, FrameType.SNAPSHOT);
  view.setUint32(4, message.tick >>> 0, LE);
  view.setUint32(SNAPSHOT_SEQ_OFFSET, message.lastProcessedSeq >>> 0, LE);
  view.setUint8(12, ships.length);
  view.setUint16(13, asteroids.length, LE);
  view.setUint16(15, bullets.length, LE);
  view.setUint8(17, pickups.length);
  view.setUint8(18, events.length);

  let o = SNAPSHOT_FIXED_BYTES;
  for (const s of ships) {
    view.setUint32(o, s.id >>> 0, LE);
    view.setFloat32(o + 4, s.x, LE);
    view.setFloat32(o + 8, s.y, LE);
    view.setFloat32(o + 12, s.vx, LE);
    view.setFloat32(o + 16, s.vy, LE);
    view.setInt16(o + 20, toI16(s.angle, ANGLE_SCALE), LE);
    view.setUint8(o + 22, toU8(s.hp));
    view.setUint8(o + 23, (s.alive ? 1 : 0) | (s.thrust ? 2 : 0) | (s.rapid ? 4 : 0));
    view.setUint8(o + 24, toU8(s.invulnerable, 10));
    view.setUint8(o + 25, toU8(s.fireCooldown, 1000));
    view.setUint8(o + 26, toU8(s.rapidLeft, 10));
    view.setUint8(o + 27, toU8(s.respawnIn, 10));
    view.setUint32(o + 28, s.score >>> 0, LE);
    o += RECORD_BYTES.ship;
  }
  for (const a of asteroids) {
    view.setUint32(o, a.id >>> 0, LE);
    view.setFloat32(o + 4, a.x, LE);
    view.setFloat32(o + 8, a.y, LE);
    view.setInt16(o + 12, toI16(a.vx, VEL_SCALE), LE);
    view.setInt16(o + 14, toI16(a.vy, VEL_SCALE), LE);
    view.setInt16(o + 16, toI16(a.angle, ANGLE_SCALE), LE);
    view.setUint8(o + 18, (a.size & 3) | (a.hunter ? 4 : 0));
    o += RECORD_BYTES.asteroid;
  }
  for (const b of bullets) {
    view.setUint32(o, b.id >>> 0, LE);
    view.setFloat32(o + 4, b.x, LE);
    view.setFloat32(o + 8, b.y, LE);
    view.setInt16(o + 12, toI16(b.vx, VEL_SCALE), LE);
    view.setInt16(o + 14, toI16(b.vy, VEL_SCALE), LE);
    view.setUint32(o + 16, b.owner >>> 0, LE);
    view.setUint8(o + 20, b.missile ? 1 : 0);
    o += RECORD_BYTES.bullet;
  }
  for (const p of pickups) {
    view.setUint32(o, p.id >>> 0, LE);
    view.setFloat32(o + 4, p.x, LE);
    view.setFloat32(o + 8, p.y, LE);
    view.setUint8(o + 12, effectToCode(p.effect));
    view.setUint8(o + 13, clampInt(Math.ceil(p.remaining), 0, 255));
    o += RECORD_BYTES.pickup;
  }
  for (const e of events) {
    view.setUint8(o, 1);
    view.setUint8(o + 1, Math.max(0, EVENT_KINDS.indexOf(e.kind)));
    view.setUint8(o + 2, toU8(e.size));
    view.setFloat32(o + 3, e.x, LE);
    view.setFloat32(o + 7, e.y, LE);
    o += RECORD_BYTES.event;
  }
  return buffer;
}

function decodeSnapshot(view: DataView): SnapshotMessage {
  if (view.byteLength < SNAPSHOT_FIXED_BYTES) throw new BinaryFormatError('SNAPSHOT: закороткий');
  const nShips = view.getUint8(12);
  const nAsteroids = view.getUint16(13, LE);
  const nBullets = view.getUint16(15, LE);
  const nPickups = view.getUint8(17);
  const nEvents = view.getUint8(18);
  const expected =
    SNAPSHOT_FIXED_BYTES +
    nShips * RECORD_BYTES.ship +
    nAsteroids * RECORD_BYTES.asteroid +
    nBullets * RECORD_BYTES.bullet +
    nPickups * RECORD_BYTES.pickup +
    nEvents * RECORD_BYTES.event;
  if (view.byteLength !== expected) throw new BinaryFormatError('SNAPSHOT: хибна довжина');

  let o = SNAPSHOT_FIXED_BYTES;
  const ships: NetShip[] = [];
  for (let i = 0; i < nShips; i += 1) {
    const flags = view.getUint8(o + 23);
    ships.push({
      id: asEntityId(view.getUint32(o, LE)),
      x: view.getFloat32(o + 4, LE),
      y: view.getFloat32(o + 8, LE),
      vx: view.getFloat32(o + 12, LE),
      vy: view.getFloat32(o + 16, LE),
      angle: view.getInt16(o + 20, LE) / ANGLE_SCALE,
      hp: view.getUint8(o + 22),
      alive: (flags & 1) !== 0,
      thrust: (flags & 2) !== 0,
      rapid: (flags & 4) !== 0,
      invulnerable: view.getUint8(o + 24) / 10,
      fireCooldown: view.getUint8(o + 25) / 1000,
      rapidLeft: view.getUint8(o + 26) / 10,
      respawnIn: view.getUint8(o + 27) / 10,
      score: view.getUint32(o + 28, LE),
    });
    o += RECORD_BYTES.ship;
  }
  const asteroids: NetAsteroid[] = [];
  for (let i = 0; i < nAsteroids; i += 1) {
    const flags = view.getUint8(o + 18);
    const rawSize = flags & 3;
    const size: AsteroidSize = isAsteroidSize(rawSize) ? rawSize : 1;
    asteroids.push({
      id: asEntityId(view.getUint32(o, LE)),
      x: view.getFloat32(o + 4, LE),
      y: view.getFloat32(o + 8, LE),
      vx: view.getInt16(o + 12, LE) / VEL_SCALE,
      vy: view.getInt16(o + 14, LE) / VEL_SCALE,
      angle: view.getInt16(o + 16, LE) / ANGLE_SCALE,
      size,
      hunter: (flags & 4) !== 0,
    });
    o += RECORD_BYTES.asteroid;
  }
  const bullets: NetBullet[] = [];
  for (let i = 0; i < nBullets; i += 1) {
    bullets.push({
      id: asEntityId(view.getUint32(o, LE)),
      x: view.getFloat32(o + 4, LE),
      y: view.getFloat32(o + 8, LE),
      vx: view.getInt16(o + 12, LE) / VEL_SCALE,
      vy: view.getInt16(o + 14, LE) / VEL_SCALE,
      owner: asEntityId(view.getUint32(o + 16, LE)),
      missile: (view.getUint8(o + 20) & 1) !== 0,
    });
    o += RECORD_BYTES.bullet;
  }
  const pickups: NetPickup[] = [];
  for (let i = 0; i < nPickups; i += 1) {
    pickups.push({
      id: asEntityId(view.getUint32(o, LE)),
      x: view.getFloat32(o + 4, LE),
      y: view.getFloat32(o + 8, LE),
      effect: codeToEffect(view.getUint8(o + 12)),
      remaining: view.getUint8(o + 13),
    });
    o += RECORD_BYTES.pickup;
  }
  const events: NetExplosionEvent[] = [];
  for (let i = 0; i < nEvents; i += 1) {
    events.push({
      type: 'explosion',
      kind: EVENT_KINDS[view.getUint8(o + 1)] ?? 'asteroid',
      size: view.getUint8(o + 2),
      x: view.getFloat32(o + 3, LE),
      y: view.getFloat32(o + 7, LE),
    });
    o += RECORD_BYTES.event;
  }
  return {
    type: MsgType.SNAPSHOT,
    tick: asTick(view.getUint32(4, LE)),
    lastProcessedSeq: asSeq(view.getUint32(SNAPSHOT_SEQ_OFFSET, LE)),
    ships,
    asteroids,
    bullets,
    pickups,
    events,
  };
}

export function encode(message: GameMessage): ArrayBuffer {
  switch (message.type) {
    case MsgType.INPUT:
      return encodeInput(message);
    case MsgType.SNAPSHOT:
      return encodeSnapshot(message);
    case MsgType.PING:
      return encodePing(message);
    case MsgType.PONG:
      return encodePong(message);
    default: {
      const _exhaustive: never = message;
      return assertNever(_exhaustive, 'невідомий тип повідомлення');
    }
  }
}

export function decode(data: ArrayBuffer | ArrayBufferView): GameMessage {
  const view = ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
  const type = readHeader(view);
  switch (type) {
    case FrameType.INPUT:
      return decodeInput(view);
    case FrameType.SNAPSHOT:
      return decodeSnapshot(view);
    case FrameType.PING:
      if (view.byteLength !== 12) throw new BinaryFormatError('PING: хибна довжина');
      return { type: MsgType.PING, clientTime: view.getFloat64(4, LE) };
    case FrameType.PONG:
      if (view.byteLength !== 16) throw new BinaryFormatError('PONG: хибна довжина');
      return {
        type: MsgType.PONG,
        clientTime: view.getFloat64(4, LE),
        serverTick: asTick(view.getUint32(12, LE)),
      };
    default:
      throw new BinaryFormatError(`невідомий тип кадру: ${type}`);
  }
}

export function snapshotForClient(buffer: ArrayBuffer, lastProcessedSeq: Seq): ArrayBuffer {
  const copy = buffer.slice(0);
  new DataView(copy).setUint32(SNAPSHOT_SEQ_OFFSET, lastProcessedSeq >>> 0, LE);
  return copy;
}

export const binaryCodec: Codec<ArrayBuffer, ArrayBuffer | ArrayBufferView> = Object.freeze({
  name: 'binary' as const,
  binary: true,
  encode,
  decode,
});
