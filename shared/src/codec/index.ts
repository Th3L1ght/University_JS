/** Вибір кодека за назвою: 'binary' (за замовчуванням) або 'json'. */

import type { CodecNameValue } from '../protocol.ts';
import { binaryCodec, type Codec } from './binary_codec.ts';
import { jsonCodec } from './json_codec.ts';

export {
  BinaryFormatError,
  FrameType,
  HEADER_BYTES,
  RECORD_BYTES,
  SNAPSHOT_SEQ_OFFSET,
  snapshotForClient,
  type Codec,
  type FrameTypeValue,
} from './binary_codec.ts';
export { JsonFormatError } from './json_codec.ts';
export { binaryCodec, jsonCodec };

export function isCodecName(name: unknown): name is CodecNameValue {
  return name === 'binary' || name === 'json';
}

export function getCodec(name: 'binary'): typeof binaryCodec;
export function getCodec(name: 'json'): typeof jsonCodec;
export function getCodec(
  name: CodecNameValue,
): Codec<ArrayBuffer, ArrayBuffer | ArrayBufferView> | Codec<string>;
export function getCodec(
  name: string,
): Codec<ArrayBuffer, ArrayBuffer | ArrayBufferView> | Codec<string> {
  if (name === 'binary') return binaryCodec;
  if (name === 'json') return jsonCodec;
  throw new Error(`Невідомий кодек: ${name}`);
}
