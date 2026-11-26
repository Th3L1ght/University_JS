/**
 * JSON-кодек: ті самі логічні повідомлення, що й у бінарного, але текстом `{ "v": 1, "type": ..., ... }`.
 */

import { z } from 'zod';
import { MsgType, PROTOCOL_VERSION, ServerSnapshotSchema, type GameMessage } from '../protocol.ts';
import { asSeq, asTick } from '../types.ts';
import type { Codec } from './binary_codec.ts';

export const JSON_PROTOCOL_VERSION = PROTOCOL_VERSION;

export class JsonFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonFormatError';
  }
}

const GameJsonSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(MsgType.INPUT),
    seq: z.number().int().nonnegative().transform(asSeq),
    tick: z.number().int().nonnegative().transform(asTick),
    thrust: z.boolean(),
    turn: z.number().finite(),
    fire: z.boolean(),
    missile: z.boolean().default(false),
    prev: z
      .array(
        z.object({
          thrust: z.boolean(),
          turn: z.number().finite(),
          fire: z.boolean(),
          missile: z.boolean().default(false),
        }),
      )
      .default([]),
  }),
  ServerSnapshotSchema,
  z.object({
    type: z.literal(MsgType.PING),
    clientTime: z.number().finite(),
  }),
  z.object({
    type: z.literal(MsgType.PONG),
    clientTime: z.number().finite(),
    serverTick: z.number().int().nonnegative().transform(asTick),
  }),
]);

const roundReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 1000) / 1000 : value;

export function encode(message: GameMessage): string {
  return JSON.stringify({ v: JSON_PROTOCOL_VERSION, ...message }, roundReplacer);
}

export function decode(text: string): GameMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new JsonFormatError('не JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new JsonFormatError('очікується JSON-об’єкт');
  }
  const obj: Record<string, unknown> = { ...raw };
  if (obj.v !== JSON_PROTOCOL_VERSION) {
    throw new JsonFormatError(`непідтримувана версія протоколу: ${String(obj.v)}`);
  }
  if (typeof obj.type !== 'string') throw new JsonFormatError('поле type має бути рядком');
  delete obj.v;

  const parsed = GameJsonSchema.safeParse(obj);
  if (!parsed.success) {
    throw new JsonFormatError(parsed.error.issues[0]?.message ?? 'некоректна схема');
  }
  return parsed.data;
}

export const jsonCodec: Codec<string> = Object.freeze({
  name: 'json' as const,
  binary: false,
  encode,
  decode,
});
