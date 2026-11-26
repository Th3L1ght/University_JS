/**
 * Бінарний кодек ігрового трафіку на ArrayBuffer + DataView.
 *
 * ВСІ багатобайтові числа - little-endian (третій аргумент DataView: `true`). Кадр самоописовий:
 * версіонований заголовок, далі тіло за типом. Невідома версія чи биті довжини -> BinaryFormatError.
 *
 * ┌──────────────────────────── Заголовок кадру (4 байти) ─────────────────────────────┐
 * │ off size тип  поле                                                                 │
 * │  0   1   u8   magic   = 0xD6                                                       │
 * │  1   1   u8   version = 1  (зміна розкладки => нова версія)                        │
 * │  2   1   u8   type    1 = INPUT, 2 = SNAPSHOT, 3 = PING, 4 = PONG                  │
 * │  3   1   u8   reserved = 0                                                         │
 * └────────────────────────────────────────────────────────────────────────────────────┘
 *
 * INPUT (клієнт -> сервер), 15 + 2·count байт (count ≤ 4; з count = 3 - 21 байт):
 *   4   u32  seq        номер найновішої команди
 *   8   u32  tick       оцінка клієнтом поточного тіка сервера
 *   12  u8   count      скільки попередніх команд додано (надлишковість проти втрат)
 *   13  u8   flags      біт0 thrust, біт1 fire, біт2 missile (решта біт - 0)
 *   14  i8   turn       повертання [-1, 1] -> [-127, 127] (turn = value / 127)
 *   15+ count × { u8 flags, i8 turn }   команди seq-1, seq-2, ..., seq-count
 *
 * PING (клієнт -> сервер), 12 байт:   4  f64  clientTime  (performance.now() клієнта)
 * PONG (сервер -> клієнт), 16 байт:   4  f64  clientTime  (ехо)
 *                                     12 u32  serverTick
 *
 * SNAPSHOT (сервер -> клієнт), 19 + записи:
 *   4   u32  tick               номер тіка сервера
 *   8   u32  lastProcessedSeq   остання команда ЦЬОГО клієнта, врахована в знімку
 *                               (поле на фіксованому зсуві: сервер кодує знімок один раз і
 *                               лише підміняє ці 4 байти для кожного одержувача)
 *   12  u8   nShips
 *   13  u16  nAsteroids
 *   15  u16  nBullets
 *   17  u8   nPickups
 *   18  u8   nEvents
 *   19  записи підряд: судна, астероїди, кулі, бонуси, події
 *
 *   Судно, 32 байти:
 *     +0  u32 id            +4  f32 x      +8  f32 y      +12 f32 vx     +16 f32 vy
 *     +20 i16 angle         кут у 1/1000 рад (діапазон (-π, π] -> ±3142), квантування ≈ 0.0005 рад
 *     +22 u8  hp            +23 u8 flags: біт0 alive, біт1 thrust, біт2 rapid
 *     +24 u8  invulnerable  у 0.1 с         +25 u8 fireCooldown у мс
 *     +26 u8  rapidLeft     у 0.1 с         +27 u8 respawnIn   у 0.1 с (для знищеного судна)
 *     +28 u32 score
 *   Астероїд, 19 байт:
 *     +0 u32 id  +4 f32 x  +8 f32 y  +12 i16 vx  +14 i16 vy (у 0.1 пкс/с)  +16 i16 angle (1/1000 рад)
 *     +18 u8 flags: біти0-1 size (1..3), біт2 hunter
 *   Куля, 21 байт:
 *     +0 u32 id  +4 f32 x  +8 f32 y  +12 i16 vx  +14 i16 vy (у 0.1 пкс/с)  +16 u32 owner
 *     +20 u8 flags: біт0 missile
 *   Бонус, 14 байт:
 *     +0 u32 id  +4 f32 x  +8 f32 y  +12 u8 effect (0 heal, 1 rapid)  +13 u8 remaining (с)
 *   Подія, 11 байт:
 *     +0 u8 type (1 = вибух)  +1 u8 kind (0 судно, 1 астероїд)  +2 u8 size  +3 f32 x  +7 f32 y
 *
 * Квантування: координати судна/астероїдів/куль - float32 (≈1e-4 пкс на 1280 пкс), кут - Int16,
 * швидкості астероїдів і куль - Int16 у кроці 0.1 пкс/с (достатньо для екстраполяції), таймери - u8.
 * Власне судно клієнт відновлює з float32-значень: помилка квантування << помилки мережі.
 */

import { codeToEffect, effectToCode } from '../net_snapshot.js';
import { INPUT_LIMITS, MsgType } from '../protocol.js';

export const FRAME_MAGIC = 0xd6;
export const FRAME_VERSION = 1;

export const FrameType = Object.freeze({ INPUT: 1, SNAPSHOT: 2, PING: 3, PONG: 4 });

export const HEADER_BYTES = 4;
/** Зсув поля lastProcessedSeq у кадрі SNAPSHOT. */
export const SNAPSHOT_SEQ_OFFSET = 8;
const SNAPSHOT_FIXED_BYTES = 19;

export const RECORD_BYTES = Object.freeze({
  ship: 32,
  asteroid: 19,
  bullet: 21,
  pickup: 14,
  event: 11,
});

const LE = true; // little-endian скрізь
const ANGLE_SCALE = 1000; // 1/1000 рад
const VEL_SCALE = 10; // 0.1 пкс/с

const FLAG_THRUST = 1;
const FLAG_FIRE = 2;
const FLAG_MISSILE = 4;
const INPUT_FLAGS_MASK = FLAG_THRUST | FLAG_FIRE | FLAG_MISSILE;

const EVENT_KINDS = ['ship', 'asteroid'];

export class BinaryFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BinaryFormatError';
  }
}

const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));
const toI16 = (value, scale) => clampInt(value * scale, -32768, 32767);
const toU8 = (value, scale = 1) => clampInt(value * scale, 0, 255);

function writeHeader(view, type) {
  view.setUint8(0, FRAME_MAGIC);
  view.setUint8(1, FRAME_VERSION);
  view.setUint8(2, type);
  view.setUint8(3, 0);
}

function readHeader(view) {
  if (view.byteLength < HEADER_BYTES) throw new BinaryFormatError('кадр коротший за заголовок');
  if (view.getUint8(0) !== FRAME_MAGIC) throw new BinaryFormatError('хибний magic');
  const version = view.getUint8(1);
  if (version !== FRAME_VERSION) {
    throw new BinaryFormatError(`непідтримувана версія бінарного протоколу: ${version}`);
  }
  return view.getUint8(2);
}

// --- INPUT ---

function inputFlags(command) {
  return (
    (command.thrust ? FLAG_THRUST : 0) |
    (command.fire ? FLAG_FIRE : 0) |
    (command.missile ? FLAG_MISSILE : 0)
  );
}

function encodeInput(message) {
  const prev = (message.prev ?? []).slice(0, INPUT_LIMITS.maxHistory);
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

function readCommand(view, offset) {
  const flags = view.getUint8(offset);
  if ((flags & ~INPUT_FLAGS_MASK) !== 0) throw new BinaryFormatError('зайві біти прапорців вводу');
  return {
    thrust: (flags & FLAG_THRUST) !== 0,
    turn: view.getInt8(offset + 1) / 127,
    fire: (flags & FLAG_FIRE) !== 0,
    missile: (flags & FLAG_MISSILE) !== 0,
  };
}

function decodeInput(view) {
  if (view.byteLength < 15) throw new BinaryFormatError('INPUT: кадр закороткий');
  const count = view.getUint8(12);
  if (count > INPUT_LIMITS.maxHistory)
    throw new BinaryFormatError('INPUT: забагато команд історії');
  if (view.byteLength !== 15 + 2 * count) throw new BinaryFormatError('INPUT: хибна довжина');
  const prev = [];
  for (let i = 0; i < count; i += 1) prev.push(readCommand(view, 15 + 2 * i));
  return {
    type: MsgType.INPUT,
    seq: view.getUint32(4, LE),
    tick: view.getUint32(8, LE),
    ...readCommand(view, 13),
    prev,
  };
}

// --- PING / PONG ---

function encodePing(message) {
  const buffer = new ArrayBuffer(12);
  const view = new DataView(buffer);
  writeHeader(view, FrameType.PING);
  view.setFloat64(4, message.clientTime, LE);
  return buffer;
}

function encodePong(message) {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  writeHeader(view, FrameType.PONG);
  view.setFloat64(4, message.clientTime, LE);
  view.setUint32(12, message.serverTick >>> 0, LE);
  return buffer;
}

// --- SNAPSHOT ---

function encodeSnapshot(message) {
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

function decodeSnapshot(view) {
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
  const ships = [];
  for (let i = 0; i < nShips; i += 1) {
    const flags = view.getUint8(o + 23);
    ships.push({
      id: view.getUint32(o, LE),
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
  const asteroids = [];
  for (let i = 0; i < nAsteroids; i += 1) {
    const flags = view.getUint8(o + 18);
    asteroids.push({
      id: view.getUint32(o, LE),
      x: view.getFloat32(o + 4, LE),
      y: view.getFloat32(o + 8, LE),
      vx: view.getInt16(o + 12, LE) / VEL_SCALE,
      vy: view.getInt16(o + 14, LE) / VEL_SCALE,
      angle: view.getInt16(o + 16, LE) / ANGLE_SCALE,
      size: flags & 3,
      hunter: (flags & 4) !== 0,
    });
    o += RECORD_BYTES.asteroid;
  }
  const bullets = [];
  for (let i = 0; i < nBullets; i += 1) {
    bullets.push({
      id: view.getUint32(o, LE),
      x: view.getFloat32(o + 4, LE),
      y: view.getFloat32(o + 8, LE),
      vx: view.getInt16(o + 12, LE) / VEL_SCALE,
      vy: view.getInt16(o + 14, LE) / VEL_SCALE,
      owner: view.getUint32(o + 16, LE),
      missile: (view.getUint8(o + 20) & 1) !== 0,
    });
    o += RECORD_BYTES.bullet;
  }
  const pickups = [];
  for (let i = 0; i < nPickups; i += 1) {
    pickups.push({
      id: view.getUint32(o, LE),
      x: view.getFloat32(o + 4, LE),
      y: view.getFloat32(o + 8, LE),
      effect: codeToEffect(view.getUint8(o + 12)),
      remaining: view.getUint8(o + 13),
    });
    o += RECORD_BYTES.pickup;
  }
  const events = [];
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
    tick: view.getUint32(4, LE),
    lastProcessedSeq: view.getUint32(SNAPSHOT_SEQ_OFFSET, LE),
    ships,
    asteroids,
    bullets,
    pickups,
    events,
  };
}

// --- Публічний API ---

/**
 * @param {{ type: string }} message логічне повідомлення (див. protocol.js)
 * @returns {ArrayBuffer}
 */
export function encode(message) {
  switch (message.type) {
    case MsgType.INPUT:
      return encodeInput(message);
    case MsgType.SNAPSHOT:
      return encodeSnapshot(message);
    case MsgType.PING:
      return encodePing(message);
    case MsgType.PONG:
      return encodePong(message);
    default:
      throw new BinaryFormatError(`невідомий тип повідомлення: ${message.type}`);
  }
}

/**
 * @param {ArrayBuffer | ArrayBufferView} data
 * @returns {object} логічне повідомлення
 * @throws {BinaryFormatError}
 */
export function decode(data) {
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
        serverTick: view.getUint32(12, LE),
      };
    default:
      throw new BinaryFormatError(`невідомий тип кадру: ${type}`);
  }
}

/**
 * Копія закодованого знімка з підставленим lastProcessedSeq. Сервер кодує знімок один раз і
 * видає кожному клієнту власну копію (спільний буфер не можна змінювати: ws відправляє асинхронно).
 */
export function snapshotForClient(buffer, lastProcessedSeq) {
  const copy = buffer.slice(0);
  new DataView(copy).setUint32(SNAPSHOT_SEQ_OFFSET, lastProcessedSeq >>> 0, LE);
  return copy;
}

export const binaryCodec = Object.freeze({ name: 'binary', binary: true, encode, decode });
