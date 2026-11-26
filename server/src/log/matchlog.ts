/**
 * Потоковий журнал матчу: Transform (objectMode) -> NDJSON -> файл через pipeline.
 */

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform, type TransformCallback, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class NdjsonTransform extends Transform {
  skipped = 0;

  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false });
  }

  override _transform(
    record: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      this.skipped += 1;
      callback();
      return;
    }
    callback(null, `${line}\n`);
  }
}

export function timestampForFile(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '').toLowerCase();
}

export interface MatchLogOptions {
  readonly dir: string;
  readonly roomId: string;
  readonly startedAt?: number;
  readonly now?: () => number;
  readonly createDestination?: (file: string) => Writable & { bytesWritten?: number };
  readonly onError?: (error: unknown) => void;
}

export interface MatchLog {
  readonly id: string;
  readonly file: string;
  write(record: Record<string, unknown>): boolean;
  drained(): Promise<void>;
  end(): Promise<void>;
  readonly bytesWritten: number;
  readonly skipped: number;
  readonly queued: number;
}

export function createMatchLog({
  dir,
  roomId,
  startedAt = Date.now(),
  now = Date.now,
  createDestination = (file) => createWriteStream(file, { flags: 'wx' }),
  onError,
}: MatchLogOptions): MatchLog {
  const id = `${roomId}-${timestampForFile(startedAt)}`;
  const file = path.join(dir, `${id}.ndjson`);
  const transform = new NdjsonTransform();
  const destination = createDestination(file);

  const finished = pipeline(transform, destination);
  finished.catch((error: unknown) => onError?.(error));

  let ended = false;
  return {
    id,
    file,

    write(record) {
      if (ended) return false;
      return transform.write({ t: now() - startedAt, ...record });
    },

    async drained() {
      if (transform.writableNeedDrain) await once(transform, 'drain');
    },

    end() {
      if (!ended) {
        ended = true;
        transform.end();
      }
      return finished;
    },

    get bytesWritten() {
      return destination.bytesWritten ?? 0;
    },
    get skipped() {
      return transform.skipped;
    },
    get queued() {
      return transform.writableLength;
    },
  };
}
