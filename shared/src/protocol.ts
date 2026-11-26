/**
 * Єдиний контракт протоколу для клієнта й сервера на базі Zod.
 *
 * Усі JSON-повідомлення (Client -> Server і Server -> Client) описані через
 * `z.discriminatedUnion('type', [...])`, а TypeScript-типи виводяться через `z.infer`.
 * Це замінює ручний валідатор із Лаби №4 і гарантує, що схеми й типи ніколи не розійдуться.
 */

import { z } from 'zod';
import {
  asEntityId,
  asSeq,
  asTick,
  type EntityId,
  type Result,
  type Seq,
  type Tick,
} from './types.ts';

export const PROTOCOL_VERSION = 1;

/** Частота авторитативного циклу сервера і дискретизації вводу клієнта, Гц. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const TICK_DT = 1 / TICK_RATE;

/** Розмір авторитативної арени (клієнт масштабує її під вікно). */
export const ARENA_SIZE = Object.freeze({ width: 1280, height: 720 });

export const MAX_U32 = 0xffffffff;

/** Коди закриття WebSocket: стандартні (RFC 6455) і прикладні (4000-4999). */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNSUPPORTED_DATA: 1003,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
  TRY_AGAIN_LATER: 1013,
  AUTH_TIMEOUT: 4001,
  HEARTBEAT_TIMEOUT: 4002,
  ROOM_NOT_FOUND: 4003,
  ROOM_FULL: 4004,
  SLOW_CONSUMER: 4005,
  FORBIDDEN_ORIGIN: 4008,
} as const;

export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

export const MsgType = {
  INPUT: 'input',
  SNAPSHOT: 'snapshot',
  PING: 'ping',
  PONG: 'pong',
} as const;

export const CodecName = { BINARY: 'binary', JSON: 'json' } as const;
export type CodecNameValue = (typeof CodecName)[keyof typeof CodecName];

export const INPUT_LIMITS = Object.freeze({
  maxHistory: 4,
  maxQueue: 8,
  maxTickAhead: 150,
});

export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/;
// Керівні символи заборонені в нікнеймах і тексті: перевірка навмисно шукає саме їх.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const noControlString = (min: number, max: number, field: string) =>
  z
    .string({ error: `${field} має бути рядком` })
    .transform((s) => s.trim())
    .refine((s) => s.length >= min && s.length <= max, {
      error: `${field} має містити ${min}-${max} символів`,
    })
    .refine((s) => !CONTROL_CHARS.test(s), {
      error: `${field} містить керівні символи`,
    });

export const CodecNameSchema = z.enum(['binary', 'json']);

export const PrevInputSchema = z.object({
  thrust: z.boolean().optional(),
  turn: z.number().finite().optional(),
  fire: z.boolean().optional(),
  missile: z.boolean().optional(),
});

// --- Схеми Client -> Server ---

const ClientJoinSchema = z
  .object({
    type: z.literal('join'),
    room: z
      .string({ error: 'room має бути рядком' })
      .regex(ROOM_ID_PATTERN, 'room має бути ідентифікатором a-z, 0-9, "-", "_" (2-40 символів)'),
    nickname: noControlString(2, 16, 'nickname'),
  })
  .strict();

const ClientChatSchema = z
  .object({
    type: z.literal('chat'),
    text: noControlString(1, 200, 'text'),
  })
  .strict();

const ClientLeaveSchema = z.object({ type: z.literal('leave') }).strict();

const ClientPingSchema = z
  .object({
    type: z.literal('ping'),
    t: z.number().finite().optional(),
  })
  .strict();

const ClientReadySchema = z
  .object({
    type: z.literal('ready'),
    codec: CodecNameSchema.optional(),
  })
  .strict();

const ClientCodecSchema = z
  .object({
    type: z.literal('codec'),
    codec: CodecNameSchema.optional(),
  })
  .strict();

const ClientNetsimSchema = z
  .object({
    type: z.literal('netsim'),
    latency: z.number().finite().optional(),
    jitter: z.number().finite().optional(),
    drop: z.number().finite().optional(),
  })
  .strict();

const ClientInputSchema = z
  .object({
    type: z.literal('input'),
    seq: z.number().finite(),
    tick: z.number().finite(),
    thrust: z.boolean(),
    turn: z.number().finite(),
    fire: z.boolean(),
    missile: z.boolean().optional(),
    prev: z.array(PrevInputSchema).max(INPUT_LIMITS.maxHistory).optional(),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  ClientJoinSchema,
  ClientChatSchema,
  ClientLeaveSchema,
  ClientPingSchema,
  ClientReadySchema,
  ClientCodecSchema,
  ClientNetsimSchema,
  ClientInputSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const CLIENT_MESSAGE_TYPES = Object.freeze([
  'join',
  'chat',
  'leave',
  'ping',
  'ready',
  'codec',
  'netsim',
  'input',
] as const);

// --- Схеми Server -> Client ---

export const PlayerSummarySchema = z.object({
  id: z.string(),
  nickname: z.string(),
});
export type PlayerSummary = z.infer<typeof PlayerSummarySchema>;

export const RoomSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  map: z.string(),
  mode: z.string(),
  players: z.number().int().nonnegative(),
  maxPlayers: z.number().int().positive(),
  arena: z.record(z.string(), z.number()),
  replayId: z.string().nullable(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

export const NetsimStateSchema = z.object({
  latency: z.number(),
  jitter: z.number(),
  drop: z.number(),
});
export type NetsimState = z.infer<typeof NetsimStateSchema>;

export const NetShipSchema = z.object({
  id: z.number().int().nonnegative().transform(asEntityId),
  x: z.number(),
  y: z.number(),
  vx: z.number(),
  vy: z.number(),
  angle: z.number(),
  hp: z.number(),
  alive: z.boolean(),
  thrust: z.boolean(),
  rapid: z.boolean(),
  invulnerable: z.number(),
  fireCooldown: z.number(),
  rapidLeft: z.number(),
  respawnIn: z.number(),
  score: z.number(),
});
export type NetShip = z.infer<typeof NetShipSchema>;

export const NetAsteroidSchema = z.object({
  id: z.number().int().nonnegative().transform(asEntityId),
  x: z.number(),
  y: z.number(),
  vx: z.number(),
  vy: z.number(),
  angle: z.number(),
  size: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  hunter: z.boolean(),
});
export type NetAsteroid = z.infer<typeof NetAsteroidSchema>;

export const NetBulletSchema = z.object({
  id: z.number().int().nonnegative().transform(asEntityId),
  x: z.number(),
  y: z.number(),
  vx: z.number(),
  vy: z.number(),
  owner: z.number().int().nonnegative().transform(asEntityId),
  missile: z.boolean(),
});
export type NetBullet = z.infer<typeof NetBulletSchema>;

export const NetPickupSchema = z.object({
  id: z.number().int().nonnegative().transform(asEntityId),
  x: z.number(),
  y: z.number(),
  effect: z.enum(['heal', 'rapid']),
  remaining: z.number(),
});
export type NetPickup = z.infer<typeof NetPickupSchema>;

export const NetExplosionEventSchema = z.object({
  type: z.literal('explosion'),
  kind: z.enum(['ship', 'asteroid']),
  size: z.number().int().nonnegative(),
  x: z.number(),
  y: z.number(),
});
export type NetExplosionEvent = z.infer<typeof NetExplosionEventSchema>;

export const ServerSnapshotSchema = z.object({
  type: z.literal('snapshot'),
  tick: z.number().int().nonnegative().transform(asTick),
  lastProcessedSeq: z.number().int().nonnegative().transform(asSeq),
  ships: z.array(NetShipSchema),
  asteroids: z.array(NetAsteroidSchema),
  bullets: z.array(NetBulletSchema),
  pickups: z.array(NetPickupSchema),
  events: z.array(NetExplosionEventSchema),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    playerId: z.string(),
    room: RoomSummarySchema,
    players: z.array(PlayerSummarySchema),
  }),
  z.object({
    type: z.literal('roster'),
    room: z.string(),
    players: z.array(PlayerSummarySchema),
  }),
  z.object({
    type: z.literal('chat'),
    room: z.string(),
    playerId: z.string(),
    nickname: z.string(),
    text: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('pong'),
    t: z.number().nullable().optional(),
    serverTime: z.number().optional(),
    clientTime: z.number().optional(),
    serverTick: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('start'),
    shipId: z.number().int().nonnegative().transform(asEntityId),
    tickRate: z.number(),
    tick: z.number().int().nonnegative().transform(asTick),
    arena: z.object({ width: z.number(), height: z.number() }),
    seed: z.number(),
    codec: CodecNameSchema,
    netsimEnabled: z.boolean(),
    netsim: NetsimStateSchema,
  }),
  z.object({
    type: z.literal('netsim'),
    latency: z.number(),
    jitter: z.number(),
    drop: z.number(),
  }),
  z.object({
    type: z.literal('shutdown'),
    reason: z.string().optional(),
  }),
  ServerSnapshotSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type SnapshotMessage = z.infer<typeof ServerSnapshotSchema>;

export const SERVER_MESSAGE_TYPES = Object.freeze([
  'welcome',
  'roster',
  'chat',
  'pong',
  'error',
  'start',
  'netsim',
  'shutdown',
  'snapshot',
] as const);

// --- Типи ігрових повідомлень (спільні для BinaryCodec і JsonCodec) ---

export interface InputCommand {
  readonly seq: Seq;
  readonly tick: Tick;
  readonly thrust: boolean;
  readonly turn: number;
  readonly fire: boolean;
  readonly missile: boolean;
}

export interface PrevInputCommand {
  readonly thrust: boolean;
  readonly turn: number;
  readonly fire: boolean;
  readonly missile: boolean;
}

export interface InputMessage {
  readonly type: typeof MsgType.INPUT;
  readonly seq: Seq;
  readonly tick: Tick;
  readonly thrust: boolean;
  readonly turn: number;
  readonly fire: boolean;
  readonly missile: boolean;
  readonly prev: readonly PrevInputCommand[];
}

export interface PingMessage {
  readonly type: typeof MsgType.PING;
  readonly clientTime: number;
}

export interface PongMessage {
  readonly type: typeof MsgType.PONG;
  readonly clientTime: number;
  readonly serverTick: Tick;
}

export type GameMessage = InputMessage | SnapshotMessage | PingMessage | PongMessage;

// --- Валідація вводу (антиcheat) через Zod ---

const InputCommandSchema = z.object({
  seq: z.number().int().min(0).max(MAX_U32),
  tick: z.number().int().min(0).max(MAX_U32),
  thrust: z.boolean(),
  turn: z.number().finite().min(-1).max(1),
  fire: z.boolean(),
  missile: z.boolean().default(false),
});

export function validateInput(raw: unknown): Result<InputCommand, string> {
  const parsed = InputCommandSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || 'input';
    return { ok: false, error: `${path}: ${issue?.message ?? 'invalid'}` };
  }
  const d = parsed.data;
  return {
    ok: true,
    data: {
      seq: asSeq(d.seq),
      tick: asTick(d.tick),
      thrust: d.thrust,
      turn: d.turn,
      fire: d.fire,
      missile: d.missile,
    },
  };
}

/**
 * Розгортає пакет вводу в упорядкований (від старішої до новішої) список необроблених команд.
 */
export function expandInputMessage(message: {
  readonly seq: number;
  readonly tick: number;
  readonly thrust: boolean;
  readonly turn: number;
  readonly fire: boolean;
  readonly missile?: boolean;
  readonly prev?: readonly {
    readonly thrust?: boolean;
    readonly turn?: number;
    readonly fire?: boolean;
    readonly missile?: boolean;
  }[];
}): unknown[] {
  const commands: unknown[] = [];
  const prev = Array.isArray(message.prev) ? message.prev.slice(0, INPUT_LIMITS.maxHistory) : [];
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const item = prev[i];
    const seq = message.seq - 1 - i;
    if (item && seq >= 0) commands.push({ ...item, seq, tick: message.tick });
  }
  commands.push({
    seq: message.seq,
    tick: message.tick,
    thrust: message.thrust,
    turn: message.turn,
    fire: message.fire,
    missile: message.missile ?? false,
  });
  return commands;
}

// --- Парсинг вхідних JSON-повідомлень клієнта через Zod safeParse ---

export interface ProtocolError {
  readonly code: string;
  readonly closeCode: CloseCodeValue;
  readonly reason: string;
}

const UTF8_DECODER = new TextDecoder();
const UTF8_ENCODER = new TextEncoder();

function rawToTextAndBytes(raw: unknown): { text: string; bytes: number } | null {
  if (typeof raw === 'string') {
    return { text: raw, bytes: UTF8_ENCODER.encode(raw).byteLength };
  }
  if (raw instanceof ArrayBuffer) {
    return { text: UTF8_DECODER.decode(raw), bytes: raw.byteLength };
  }
  if (ArrayBuffer.isView(raw)) {
    const bytesView = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return { text: UTF8_DECODER.decode(bytesView), bytes: raw.byteLength };
  }
  return null;
}

const KNOWN_CLIENT_TYPES = new Set<string>(CLIENT_MESSAGE_TYPES);

/**
 * Розбирає й перевіряє вхідне повідомлення клієнта через Zod `safeParse`.
 */
export function parseClientMessage(
  raw: unknown,
  { maxBytes = 16 * 1024 }: { readonly maxBytes?: number } = {},
): Result<ClientMessage, ProtocolError> {
  let obj: unknown;
  const decoded = rawToTextAndBytes(raw);
  if (decoded !== null) {
    if (decoded.bytes > maxBytes) {
      return {
        ok: false,
        error: {
          code: 'too_large',
          closeCode: CloseCode.MESSAGE_TOO_BIG,
          reason: `повідомлення ${decoded.bytes} B перевищує ліміт ${maxBytes} B`,
        },
      };
    }
    try {
      obj = JSON.parse(decoded.text);
    } catch {
      return {
        ok: false,
        error: {
          code: 'bad_json',
          closeCode: CloseCode.INVALID_PAYLOAD,
          reason: 'тіло не є коректним JSON',
        },
      };
    }
  } else {
    obj = raw;
  }

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      ok: false,
      error: {
        code: 'bad_schema',
        closeCode: CloseCode.INVALID_PAYLOAD,
        reason: 'повідомлення має бути JSON-об’єктом',
      },
    };
  }

  const record: Record<string, unknown> = { ...obj };
  if (record.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: {
        code: 'bad_version',
        closeCode: CloseCode.INVALID_PAYLOAD,
        reason: `непідтримувана версія протоколу: ${String(record.v)}`,
      },
    };
  }
  if (typeof record.type !== 'string') {
    return {
      ok: false,
      error: {
        code: 'bad_schema',
        closeCode: CloseCode.INVALID_PAYLOAD,
        reason: 'поле type має бути рядком',
      },
    };
  }
  if (!KNOWN_CLIENT_TYPES.has(record.type)) {
    return {
      ok: false,
      error: {
        code: 'unknown_type',
        closeCode: CloseCode.POLICY_VIOLATION,
        reason: `невідомий тип повідомлення: ${record.type.slice(0, 32)}`,
      },
    };
  }

  delete record.v;
  const parsed = ClientMessageSchema.safeParse(record);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: {
        code: 'bad_schema',
        closeCode: CloseCode.INVALID_PAYLOAD,
        reason: `${record.type}: ${first?.message ?? 'некоректна схема'}`,
      },
    };
  }
  return { ok: true, data: parsed.data };
}

/** Серіалізує повідомлення сервера в JSON `{ v: 1, ...message }`. */
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}

// --- Валідація створення кімнат через REST (Zod) ---

const ArenaOverrideSchema = z
  .object({
    initialAsteroids: z.number().finite().min(0).max(40).optional(),
    minAsteroids: z.number().finite().min(0).max(40).optional(),
    hunterChance: z.number().finite().min(0).max(1).optional(),
    pickupInterval: z.number().finite().min(1).max(120).optional(),
    seed: z
      .number()
      .finite()
      .min(0)
      .max(2 ** 31 - 1)
      .optional(),
  })
  .strict();

export interface RoomInput {
  readonly name: string;
  readonly map: string;
  readonly mode: string;
  readonly maxPlayers: number;
  readonly arena: Record<string, number>;
}

export function validateRoomInput(
  body: unknown,
  { maxPlayersLimit = 8 }: { readonly maxPlayersLimit?: number } = {},
): Result<RoomInput, readonly string[]> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: ['тіло має бути JSON-об’єктом'] };
  }
  const schema = z
    .object({
      name: noControlString(2, 40, 'name'),
      map: noControlString(1, 32, 'map').default('Open Space'),
      mode: noControlString(1, 32, 'mode').default('Sandbox'),
      maxPlayers: z
        .number({ error: `maxPlayers має бути цілим від 2 до ${maxPlayersLimit}` })
        .int(`maxPlayers має бути цілим від 2 до ${maxPlayersLimit}`)
        .min(2, `maxPlayers має бути цілим від 2 до ${maxPlayersLimit}`)
        .max(maxPlayersLimit, `maxPlayers має бути цілим від 2 до ${maxPlayersLimit}`)
        .default(Math.min(8, maxPlayersLimit)),
      arena: ArenaOverrideSchema.default({}),
    })
    .strict();

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message),
    };
  }
  const arena: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed.data.arena)) {
    if (typeof v === 'number') arena[k] = v;
  }
  return {
    ok: true,
    data: {
      name: parsed.data.name,
      map: parsed.data.map,
      mode: parsed.data.mode,
      maxPlayers: parsed.data.maxPlayers,
      arena,
    },
  };
}

/** Ідентифікатор кімнати з назви: латинський slug + короткий суфікс. */
export function makeRoomId(name: string, random: () => number): string {
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

export type { EntityId, Seq, Tick };
