/**
 * Обгортка над браузерним WebSocket із підтримкою бінарних кадрів (`binaryType = 'arraybuffer'`),
 * чергою відправки, експоненційним backoff і підрахунком трафіку.
 */

import { binaryCodec, PROTOCOL_VERSION } from '@dogfight/shared';
import { backoffDelay } from '../util/backoff.ts';

export { PROTOCOL_VERSION };

export const NO_RECONNECT_CODES: readonly number[] = Object.freeze([
  1000, 1003, 1007, 1008, 1009, 4001, 4003, 4004, 4005,
]);

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const TEXT_ENCODER = new TextEncoder();

export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionOptions {
  readonly url: string;
  readonly WebSocketImpl?: WebSocketConstructor;
  readonly backoff?: {
    readonly baseMs?: number;
    readonly maxMs?: number;
    readonly maxAttempts?: number;
  };
  readonly random?: () => number;
  readonly maxQueue?: number;
}

function payloadByteLength(data: unknown): number {
  if (typeof data === 'string') return TEXT_ENCODER.encode(data).byteLength;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

export class Connection extends EventTarget {
  #url: string;
  #WebSocketImpl: WebSocketConstructor;
  #backoff: { readonly baseMs?: number; readonly maxMs?: number; readonly maxAttempts?: number };
  #random: () => number;
  #maxQueue: number;
  #socket: WebSocketLike | null = null;
  #queue: Array<string | ArrayBuffer | ArrayBufferView<ArrayBuffer>> = [];
  #state: ConnectionState = 'idle';
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closedByUser = false;
  #bytesIn = 0;
  #bytesOut = 0;

  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    backoff = { baseMs: 500, maxMs: 15000, maxAttempts: Infinity },
    random = Math.random,
    maxQueue = 100,
  }: ConnectionOptions) {
    super();
    this.#url = url;
    this.#WebSocketImpl = WebSocketImpl;
    this.#backoff = backoff;
    this.#random = random;
    this.#maxQueue = maxQueue;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get bytesIn(): number {
    return this.#bytesIn;
  }

  get bytesOut(): number {
    return this.#bytesOut;
  }

  #emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  connect(): void {
    if (this.#state === 'connecting' || this.#state === 'open') return;
    this.#closedByUser = false;
    this.#open('connecting');
  }

  #open(state: 'connecting' | 'reconnecting'): void {
    this.#state = state === 'connecting' && this.#attempt > 0 ? 'reconnecting' : state;
    const socket = new this.#WebSocketImpl(this.#url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#state = 'open';
      this.#emit('connected', {});
      this.#flush();
    };

    socket.onmessage = (event) => this.#onMessage(event.data);
    socket.onerror = () => {};

    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#onClosed(event.code, event.reason);
    };
  }

  #onMessage(data: unknown): void {
    this.#bytesIn += payloadByteLength(data);

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      try {
        const message = binaryCodec.decode(data);
        this.#emit(message.type, message);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#emit('protocolerror', { reason });
      }
      return;
    }

    if (typeof data !== 'string') {
      this.#emit('protocolerror', { reason: 'непідтримуваний тип кадру' });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.#emit('protocolerror', { reason: 'не JSON' });
      return;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      this.#emit('protocolerror', { reason: 'хибна схема або версія повідомлення' });
      return;
    }
    const record: Record<string, unknown> = { ...raw };
    if (record.v !== PROTOCOL_VERSION || typeof record.type !== 'string') {
      this.#emit('protocolerror', { reason: 'хибна схема або версія повідомлення' });
      return;
    }
    this.#emit(record.type, record);
  }

  #onClosed(code: number, reason: string): void {
    const final = this.#closedByUser || NO_RECONNECT_CODES.includes(code);
    if (final) {
      this.#state = 'closed';
      this.#queue.length = 0;
      this.#emit('disconnected', { code, reason, willReconnect: false });
      return;
    }

    this.#attempt += 1;
    const { baseMs = 500, maxMs = 15000, maxAttempts = Infinity } = this.#backoff;
    if (this.#attempt > maxAttempts) {
      this.#state = 'closed';
      this.#emit('disconnected', { code, reason, willReconnect: false });
      this.#emit('failed', { attempts: this.#attempt - 1 });
      return;
    }

    const delayMs = backoffDelay(this.#attempt, { baseMs, maxMs }, this.#random);
    this.#state = 'reconnecting';
    this.#emit('disconnected', { code, reason, willReconnect: true });
    this.#emit('reconnecting', { attempt: this.#attempt, delayMs });
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#closedByUser) this.#open('reconnecting');
    }, delayMs);
  }

  #transmit(frame: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
    if (!this.#socket) return;
    this.#bytesOut += payloadByteLength(frame);
    this.#socket.send(frame);
  }

  #flush(): void {
    while (this.#queue.length > 0 && this.#socket?.readyState === WS_OPEN) {
      const next = this.#queue.shift();
      if (next !== undefined) this.#transmit(next);
    }
  }

  #enqueueOrSend(frame: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): 'sent' | 'queued' {
    if (this.#state === 'closed') throw new Error('З’єднання закрито');
    if (this.#state === 'open' && this.#socket?.readyState === WS_OPEN) {
      this.#transmit(frame);
      return 'sent';
    }
    if (this.#state === 'idle') throw new Error('Спершу викличте connect()');
    if (this.#queue.length >= this.#maxQueue) throw new Error('Черга відправки переповнена');
    this.#queue.push(frame);
    return 'queued';
  }

  send(type: string, payload: Record<string, unknown> = {}): 'sent' | 'queued' {
    if (this.#state === 'closed') throw new Error('З’єднання закрито');
    const text = JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload });
    return this.#enqueueOrSend(text);
  }

  sendBinary(buffer: ArrayBuffer | ArrayBufferView<ArrayBuffer>): 'sent' | 'queued' {
    return this.#enqueueOrSend(buffer);
  }

  close(code = 1000, reason = ''): void {
    this.#closedByUser = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue.length = 0;
    const socket = this.#socket;
    if (socket && (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING)) {
      socket.close(code, reason);
      return;
    }
    this.#socket = null;
    if (this.#state !== 'closed') {
      this.#state = 'closed';
      this.#emit('disconnected', { code, reason, willReconnect: false });
    }
  }
}
