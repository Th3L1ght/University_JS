/**
 * Версіонований JSON-протокол WebSocket (v: 1) з явною перевіркою схеми кожного вхідного
 * повідомлення. Модуль чистий: без мережі й без залежностей, тому тестується напряму.
 *
 * Клієнт -> сервер:  join { room, nickname } | chat { text } | leave {} | ping { t? }
 * Сервер -> клієнт:  welcome { playerId, room } | roster { players } | chat { ... } |
 *                    pong { t } | error { code, message }
 */

export const PROTOCOL_VERSION = 1;

/** Коди закриття WebSocket: стандартні (RFC 6455) і прикладні (4000-4999). */
export const CloseCode = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // сервер зупиняється
  UNSUPPORTED_DATA: 1003, // бінарний кадр
  INVALID_PAYLOAD: 1007, // не JSON або хибна структура
  POLICY_VIOLATION: 1008, // невідомий тип, перевищено rate limit, chat до join
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011, // неочікувана помилка обробника
  TRY_AGAIN_LATER: 1013, // сервер переповнений
  AUTH_TIMEOUT: 4001, // немає валідного join за відведений час
  HEARTBEAT_TIMEOUT: 4002, // клієнт не відповідає на ping
  ROOM_NOT_FOUND: 4003,
  ROOM_FULL: 4004,
  SLOW_CONSUMER: 4005, // клієнт не встигає читати
});

export const CLIENT_MESSAGE_TYPES = Object.freeze(['join', 'chat', 'leave', 'ping']);
export const SERVER_MESSAGE_TYPES = Object.freeze(['welcome', 'roster', 'chat', 'pong', 'error']);

export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/;
// Керівні символи заборонені в нікнеймах і тексті: перевірка навмисно шукає саме їх.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// --- Перевірка окремих полів: повертають { value } або { error } ---

const fieldValidators = {
  roomId(value) {
    if (typeof value !== 'string' || !ROOM_ID_PATTERN.test(value)) {
      return { error: 'room має бути ідентифікатором a-z, 0-9, "-", "_" (2-40 символів)' };
    }
    return { value };
  },
  nickname(value) {
    if (typeof value !== 'string') return { error: 'nickname має бути рядком' };
    const trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 16)
      return { error: 'nickname має містити 2-16 символів' };
    if (CONTROL_CHARS.test(trimmed)) return { error: 'nickname містить керівні символи' };
    return { value: trimmed };
  },
  chatText(value) {
    if (typeof value !== 'string') return { error: 'text має бути рядком' };
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 200)
      return { error: 'text має містити 1-200 символів' };
    if (CONTROL_CHARS.test(trimmed)) return { error: 'text містить керівні символи' };
    return { value: trimmed };
  },
  optionalNumber(value) {
    if (value === undefined) return { value };
    if (typeof value !== 'number' || !Number.isFinite(value))
      return { error: 't має бути скінченним числом' };
    return { value };
  },
};

/** Схема: тип повідомлення -> { поле: ім'я валідатора }. Інші поля заборонені. */
const CLIENT_SCHEMA = Object.freeze({
  join: { room: 'roomId', nickname: 'nickname' },
  chat: { text: 'chatText' },
  leave: {},
  ping: { t: 'optionalNumber' },
});

const bad = (code, closeCode, reason) => ({ ok: false, code, closeCode, reason });

/**
 * Розбирає й перевіряє вхідне повідомлення клієнта.
 *
 * @param {string | Buffer | ArrayBuffer} raw текстовий кадр WebSocket
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ ok: true, message: object } | { ok: false, code: string, closeCode: number, reason: string }}
 */
export function parseClientMessage(raw, { maxBytes = 16 * 1024 } = {}) {
  const byteLength = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
  if (byteLength > maxBytes) {
    return bad(
      'too_large',
      CloseCode.MESSAGE_TOO_BIG,
      `повідомлення ${byteLength} B перевищує ліміт ${maxBytes} B`,
    );
  }

  let data;
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch {
    return bad('bad_json', CloseCode.INVALID_PAYLOAD, 'тіло не є коректним JSON');
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return bad('bad_schema', CloseCode.INVALID_PAYLOAD, 'повідомлення має бути JSON-об’єктом');
  }
  if (data.v !== PROTOCOL_VERSION) {
    return bad(
      'bad_version',
      CloseCode.INVALID_PAYLOAD,
      `непідтримувана версія протоколу: ${String(data.v)}`,
    );
  }
  if (typeof data.type !== 'string') {
    return bad('bad_schema', CloseCode.INVALID_PAYLOAD, 'поле type має бути рядком');
  }

  const fields = CLIENT_SCHEMA[data.type];
  if (!Object.hasOwn(CLIENT_SCHEMA, data.type)) {
    return bad(
      'unknown_type',
      CloseCode.POLICY_VIOLATION,
      `невідомий тип повідомлення: ${data.type.slice(0, 32)}`,
    );
  }

  const message = { type: data.type };
  for (const key of Object.keys(data)) {
    if (key !== 'v' && key !== 'type' && !Object.hasOwn(fields, key)) {
      return bad(
        'bad_schema',
        CloseCode.INVALID_PAYLOAD,
        `неочікуване поле ${key.slice(0, 32)} у ${data.type}`,
      );
    }
  }
  for (const [key, validatorName] of Object.entries(fields)) {
    const result = fieldValidators[validatorName](data[key]);
    if (result.error)
      return bad('bad_schema', CloseCode.INVALID_PAYLOAD, `${data.type}: ${result.error}`);
    if (result.value !== undefined) message[key] = result.value;
  }
  return { ok: true, message };
}

/** Серіалізує повідомлення сервера: { v, type, ...payload }. */
export function encodeServerMessage(type, payload = {}) {
  if (!SERVER_MESSAGE_TYPES.includes(type))
    throw new Error(`Невідомий тип повідомлення сервера: ${type}`);
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload });
}

// --- Створення кімнат через REST ---

const ARENA_LIMITS = Object.freeze({
  initialAsteroids: [0, 40],
  minAsteroids: [0, 40],
  hunterChance: [0, 1],
  pickupInterval: [1, 120],
  seed: [0, 2 ** 31 - 1],
});

/**
 * Перевіряє тіло POST /api/rooms.
 * @param {unknown} body
 * @param {{ maxPlayersLimit?: number }} [options]
 */
export function validateRoomInput(body, { maxPlayersLimit = 8 } = {}) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['тіло має бути JSON-об’єктом'] };
  }

  const allowed = ['name', 'map', 'mode', 'maxPlayers', 'arena'];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors.push(`неочікуване поле ${key.slice(0, 32)}`);
  }

  const text = (key, fallback, min, max) => {
    const raw = body[key];
    if (raw === undefined && fallback !== undefined) return fallback;
    if (typeof raw !== 'string') {
      errors.push(`${key} має бути рядком`);
      return fallback;
    }
    const value = raw.trim();
    if (value.length < min || value.length > max || CONTROL_CHARS.test(value)) {
      errors.push(`${key} має містити ${min}-${max} символів без керівних`);
    }
    return value;
  };

  const name = text('name', undefined, 2, 40);
  const map = text('map', 'Open Space', 1, 32);
  const mode = text('mode', 'Sandbox', 1, 32);

  let maxPlayers = Math.min(8, maxPlayersLimit);
  if (body.maxPlayers !== undefined) {
    if (
      !Number.isInteger(body.maxPlayers) ||
      body.maxPlayers < 2 ||
      body.maxPlayers > maxPlayersLimit
    ) {
      errors.push(`maxPlayers має бути цілим від 2 до ${maxPlayersLimit}`);
    } else {
      maxPlayers = body.maxPlayers;
    }
  }

  const arena = {};
  if (body.arena !== undefined) {
    if (body.arena === null || typeof body.arena !== 'object' || Array.isArray(body.arena)) {
      errors.push('arena має бути об’єктом');
    } else {
      for (const [key, value] of Object.entries(body.arena)) {
        const limits = ARENA_LIMITS[key];
        if (!limits) errors.push(`невідомий параметр арени: ${key.slice(0, 32)}`);
        else if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < limits[0] ||
          value > limits[1]
        ) {
          errors.push(`arena.${key} має бути числом від ${limits[0]} до ${limits[1]}`);
        } else arena[key] = value;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { name, map, mode, maxPlayers, arena } };
}

/** Ідентифікатор кімнати з назви: латинський slug + короткий випадковий суфікс. */
export function makeRoomId(name, random = Math.random) {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${slug || 'room'}-${suffix}`;
}
