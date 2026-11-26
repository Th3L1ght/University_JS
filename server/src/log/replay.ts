/**
 * Читання журналу матчу: асинхронний генератор поверх createReadStream.
 */

import { createReadStream } from 'node:fs';

export class ReplayParseError extends Error {
  readonly lineNumber: number;

  constructor(lineNumber: number, cause: unknown) {
    super(`Журнал пошкоджено: рядок ${lineNumber} не є коректним JSON`, { cause });
    this.name = 'ReplayParseError';
    this.lineNumber = lineNumber;
  }
}

export async function* parseNdjson(
  chunks: AsyncIterable<string>,
  { skipInvalid = false }: { readonly skipInvalid?: boolean } = {},
): AsyncGenerator<Record<string, unknown>> {
  let buffer = '';
  let lineNumber = 0;

  const parseLine = (
    line: string,
  ):
    { readonly skip: true } | { readonly skip: false; readonly value: Record<string, unknown> } => {
    lineNumber += 1;
    if (line.trim() === '') return { skip: true };
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (skipInvalid) return { skip: true };
        throw new ReplayParseError(lineNumber, new Error('not object'));
      }
      return { skip: false, value: { ...parsed } };
    } catch (error: unknown) {
      if (skipInvalid) return { skip: true };
      if (error instanceof ReplayParseError) throw error;
      throw new ReplayParseError(lineNumber, error);
    }
  };

  for await (const chunk of chunks) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const parsed = parseLine(line);
      if (!parsed.skip) yield parsed.value;
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer !== '') {
    const parsed = parseLine(buffer);
    if (!parsed.skip) yield parsed.value;
  }
}

export async function* readReplay(
  file: string,
  {
    skipInvalid = false,
    signal,
    highWaterMark,
  }: {
    readonly skipInvalid?: boolean;
    readonly signal?: AbortSignal;
    readonly highWaterMark?: number;
  } = {},
): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(file, { encoding: 'utf8', signal, highWaterMark });
  try {
    yield* parseNdjson(stream, { skipInvalid });
  } finally {
    stream.destroy();
  }
}
