/**
 * Протокол реального часу, спільний для клієнта й сервера: частота тіків, типи повідомлень,
 * межі та валідація вводу. Модуль чистий (без DOM і node:*).
 *
 * Логічні повідомлення (однакові для обох кодеків - бінарного й JSON):
 *
 *   Клієнт -> сервер
 *     input    { type, seq, tick, thrust, turn, fire, missile, prev: [{ thrust, turn, fire, missile }] }
 *              seq   - номер команди (зростає на 1 за кожен тік клієнта, з 1);
 *              tick  - оцінка клієнтом поточного тіка сервера (для діагностики й перевірки на адекватність);
 *              prev  - попередні команди (seq-1, seq-2, ...): надлишковість проти втрати пакетів.
 *     ping     { type, clientTime }
 *   Сервер -> клієнт
 *     snapshot { type, tick, lastProcessedSeq, ships, asteroids, bullets, pickups, events }
 *     pong     { type, clientTime, serverTick }
 *
 * Керувальні повідомлення (join, ready, start, netsim, roster, chat, ...) лишаються текстовим JSON
 * v1 (див. server/src/protocol.js): вони рідкісні, і їм потрібна зручність, а не щільність.
 */

/** Частота авторитативного циклу сервера і дискретизації вводу клієнта, Гц. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const TICK_DT = 1 / TICK_RATE;

/** Розмір авторитативної арени (клієнт масштабує її під вікно). */
export const ARENA_SIZE = Object.freeze({ width: 1280, height: 720 });

export const MsgType = Object.freeze({
  INPUT: 'input',
  SNAPSHOT: 'snapshot',
  PING: 'ping',
  PONG: 'pong',
});

export const CodecName = Object.freeze({ BINARY: 'binary', JSON: 'json' });

export const MAX_U32 = 0xffffffff;

/** Обмеження вводу й черг (захист від спід-хаку й переповнення). */
export const INPUT_LIMITS = Object.freeze({
  maxHistory: 4, // скільки попередніх команд може нести один пакет
  maxQueue: 8, // максимум непрочитаних команд гравця на сервері
  maxTickAhead: 150, // клієнт не може "жити" в майбутньому більше ніж на 5 с
});

/**
 * Перевіряє одну команду вводу. Читерські значення (turn поза [-1, 1], NaN, нечислові прапорці,
 * некоректні seq/tick) відхиляються, а не "підправляються": сервер нічому не довіряє.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, input: { seq: number, tick: number, thrust: boolean, turn: number,
 *   fire: boolean, missile: boolean } } | { ok: false, reason: string }}
 */
export function validateInput(raw) {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'not_object' };
  const { seq, tick, thrust, turn, fire } = raw;
  const missile = raw.missile ?? false;

  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_U32) return { ok: false, reason: 'bad_seq' };
  if (!Number.isInteger(tick) || tick < 0 || tick > MAX_U32)
    return { ok: false, reason: 'bad_tick' };
  if (typeof thrust !== 'boolean' || typeof fire !== 'boolean' || typeof missile !== 'boolean') {
    return { ok: false, reason: 'bad_flags' };
  }
  if (typeof turn !== 'number' || !Number.isFinite(turn)) return { ok: false, reason: 'bad_turn' };
  if (Math.abs(turn) > 1) return { ok: false, reason: 'turn_out_of_range' };
  return { ok: true, input: { seq, tick, thrust, turn, fire, missile } };
}

/**
 * Розгортає пакет вводу в упорядкований (від старішої до новішої) список команд:
 * `prev[i]` має номер `seq - 1 - i`. Команди з від'ємним номером ігноруються.
 *
 * @param {{ seq: number, tick: number, prev?: object[] } & object} message
 * @returns {object[]} необроблені команди (кожну ще треба пропустити через validateInput)
 */
export function expandInputMessage(message) {
  const commands = [];
  const prev = Array.isArray(message.prev) ? message.prev.slice(0, INPUT_LIMITS.maxHistory) : [];
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const seq = message.seq - 1 - i;
    if (seq >= 0) commands.push({ ...prev[i], seq, tick: message.tick });
  }
  commands.push({
    seq: message.seq,
    tick: message.tick,
    thrust: message.thrust,
    turn: message.turn,
    fire: message.fire,
    missile: message.missile,
  });
  return commands;
}
