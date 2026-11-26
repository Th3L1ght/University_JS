/**
 * JSON-кодек: ті самі логічні повідомлення, що й у бінарного, але текстом `{ "v": 1, "type": ..., ... }`.
 * Потрібен для налагодження (зрозумілий у DevTools) і порівняння трафіку з бінарним форматом.
 *
 * Для чесного порівняння дробові числа округлюються до 3 знаків (це не гірша точність, ніж
 * квантування бінарного кодека); цілі й булеві значення лишаються як є.
 */

export const JSON_PROTOCOL_VERSION = 1;

export class JsonFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonFormatError';
  }
}

const roundReplacer = (_key, value) =>
  typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 1000) / 1000 : value;

/** @returns {string} */
export function encode(message) {
  return JSON.stringify({ v: JSON_PROTOCOL_VERSION, ...message }, roundReplacer);
}

/**
 * @param {string} text
 * @returns {object} логічне повідомлення (без поля v)
 * @throws {JsonFormatError}
 */
export function decode(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new JsonFormatError('не JSON');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new JsonFormatError('очікується JSON-об’єкт');
  }
  if (data.v !== JSON_PROTOCOL_VERSION) {
    throw new JsonFormatError(`непідтримувана версія протоколу: ${String(data.v)}`);
  }
  if (typeof data.type !== 'string') throw new JsonFormatError('поле type має бути рядком');
  const message = { ...data };
  delete message.v;
  return message;
}

export const jsonCodec = Object.freeze({ name: 'json', binary: false, encode, decode });
