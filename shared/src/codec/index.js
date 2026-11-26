/** Вибір кодека за назвою: 'binary' (за замовчуванням) або 'json'. */

import { binaryCodec } from './binary_codec.js';
import { jsonCodec } from './json_codec.js';

export {
  BinaryFormatError,
  FrameType,
  HEADER_BYTES,
  RECORD_BYTES,
  SNAPSHOT_SEQ_OFFSET,
  snapshotForClient,
} from './binary_codec.js';
export { JsonFormatError } from './json_codec.js';
export { binaryCodec, jsonCodec };

const CODECS = Object.freeze({ binary: binaryCodec, json: jsonCodec });

export function isCodecName(name) {
  return typeof name === 'string' && Object.hasOwn(CODECS, name);
}

/** @param {'binary' | 'json'} name */
export function getCodec(name) {
  const codec = CODECS[name];
  if (!codec) throw new Error(`Невідомий кодек: ${String(name)}`);
  return codec;
}
