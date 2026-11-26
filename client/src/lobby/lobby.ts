/**
 * Лобі: шар даних (server | static | embedded).
 */

import type { PlayerSummary, RoomSummary } from '@dogfight/shared';
import { DEFAULT_ROOMS, type RawRoomsPayload } from '../assets/defaults.ts';
import {
  anySignal,
  fetchJson,
  HttpError,
  isFileProtocol,
  JsonParseError,
  NetworkError,
  withRetry,
  type RetryOptions,
} from '../assets/loader.ts';
import { Connection } from '../net/connection.ts';
import { log } from '../util/log.ts';

export class LobbyDataError extends Error {
  readonly kind: string;

  constructor(message: string, kind = 'invalid') {
    super(message);
    this.name = 'LobbyDataError';
    this.kind = kind;
  }
}

export type LobbyMode = 'server' | 'static' | 'embedded';

export function parseRooms(data: unknown): RoomSummary[] {
  if (!data || typeof data !== 'object' || !('rooms' in data) || !Array.isArray(data.rooms)) {
    throw new LobbyDataError('Некоректний список кімнат: немає масиву rooms');
  }
  return data.rooms.map((raw, index): RoomSummary => {
    if (!raw || typeof raw !== 'object') {
      throw new LobbyDataError(`Некоректна кімната №${index + 1} у списку`);
    }
    const r: Record<string, unknown> = { ...raw };
    const valid =
      typeof r.id === 'string' &&
      typeof r.name === 'string' &&
      typeof r.players === 'number' &&
      Number.isInteger(r.players) &&
      r.players >= 0 &&
      typeof r.maxPlayers === 'number' &&
      Number.isInteger(r.maxPlayers) &&
      r.maxPlayers > 0;
    if (!valid || typeof r.id !== 'string' || typeof r.name !== 'string') {
      throw new LobbyDataError(`Некоректна кімната №${index + 1} у списку`);
    }
    const arena: Record<string, number> = {};
    if (r.arena && typeof r.arena === 'object') {
      for (const [k, v] of Object.entries(r.arena)) {
        if (typeof v === 'number' && Number.isFinite(v)) arena[k] = v;
      }
    }
    return {
      id: r.id,
      name: r.name,
      map: String(r.map ?? ''),
      mode: String(r.mode ?? ''),
      players: typeof r.players === 'number' ? r.players : 0,
      maxPlayers: typeof r.maxPlayers === 'number' ? r.maxPlayers : 8,
      arena,
      replayId: typeof r.replayId === 'string' ? r.replayId : null,
    };
  });
}

export function classifyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof HttpError) return 'http';
  if (error instanceof JsonParseError) return 'parse';
  if (error instanceof LobbyDataError) return error.kind;
  if (error instanceof NetworkError) return 'network';
  return 'network';
}

export function describeHttpError(error: HttpError): string {
  const body = error.body;
  if (body && typeof body === 'object') {
    const b: Record<string, unknown> = { ...body };
    if (Array.isArray(b.details) && b.details.length > 0) {
      const head =
        typeof b.message === 'string'
          ? b.message
          : typeof b.error === 'string'
            ? b.error
            : 'Помилка';
      return `${head}: ${b.details.map(String).join('; ')}`;
    }
    if (typeof b.message === 'string') return b.message;
  }
  return error.message;
}

export function defaultWsUrl(): string {
  const url = new URL('./ws', globalThis.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

const CLOSE_KINDS: Readonly<Record<number, string>> = {
  1008: 'policy',
  1009: 'too-big',
  4001: 'auth-timeout',
  4003: 'not-found',
  4004: 'full',
  4005: 'slow-consumer',
};

const SERVER_PROBE_INTERVAL_MS = 30_000;

export interface LobbyConnectionLike {
  readonly state: string;
  connect(): void;
  send(type: string, payload?: Record<string, unknown>): unknown;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface LobbyOptions {
  readonly apiUrl?: string;
  readonly staticUrl?: string;
  readonly wsUrl?: string | (() => string);
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly fallbackRooms?: RawRoomsPayload;
  readonly embedded?: boolean;
  readonly retry?: RetryOptions;
  readonly createConnection?: (url: string) => LobbyConnectionLike;
}

interface ActiveSession {
  readonly connection: LobbyConnectionLike;
  readonly roomId: string;
  readonly nickname: string;
  entered: boolean;
  playerId: string | null;
  room: RoomSummary;
  readonly listeners: Array<readonly [string, EventListener]>;
}

export interface JoinedDetail {
  readonly room: RoomSummary;
  readonly nickname: string;
  readonly mode: LobbyMode;
  readonly connection: Connection | null;
  readonly playerId: string | null;
}

export class Lobby extends EventTarget {
  #apiUrl: string;
  #staticUrl: string;
  #wsUrl: string | (() => string);
  #pollMs: number;
  #timeoutMs: number;
  #fallbackRooms: RawRoomsPayload;
  #embedded: boolean;
  #retry: RetryOptions;
  #createConnection: (url: string) => LobbyConnectionLike;
  #controller = new AbortController();
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #rooms: RoomSummary[] = [];
  #sequence = 0;
  #active = 0;
  #closed = false;
  #mode: LobbyMode;
  #nextServerProbe = 0;
  #session: ActiveSession | null = null;

  constructor({
    apiUrl = './api/rooms',
    staticUrl = './api/rooms.json',
    wsUrl = defaultWsUrl,
    pollMs = 5000,
    timeoutMs = 3000,
    fallbackRooms = DEFAULT_ROOMS,
    embedded = isFileProtocol(),
    retry = { attempts: 2, baseMs: 300 },
    createConnection = (url) => new Connection({ url }),
  }: LobbyOptions = {}) {
    super();
    this.#apiUrl = apiUrl;
    this.#staticUrl = staticUrl;
    this.#wsUrl = wsUrl;
    this.#pollMs = pollMs;
    this.#timeoutMs = timeoutMs;
    this.#fallbackRooms = fallbackRooms;
    this.#embedded = embedded;
    this.#retry = retry;
    this.#createConnection = createConnection;
    this.#mode = embedded ? 'embedded' : 'server';
  }

  get rooms(): readonly RoomSummary[] {
    return this.#rooms;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get mode(): LobbyMode {
    return this.#mode;
  }

  get activeRequests(): number {
    return this.#active;
  }

  get inRoom(): boolean {
    return Boolean(this.#session?.entered);
  }

  #emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #fail(message: string, kind: string, error: Error = new LobbyDataError(message, kind)): null {
    this.#emit('error', { error, kind });
    return null;
  }

  #request(
    url: string,
    { json, attempts }: { readonly json?: unknown; readonly attempts?: number } = {},
  ): Promise<unknown> {
    return withRetry(
      () =>
        fetchJson(url, {
          json,
          signal: anySignal([this.#controller.signal, AbortSignal.timeout(this.#timeoutMs)]),
        }),
      { ...this.#retry, ...(attempts ? { attempts } : {}), signal: this.#controller.signal },
    );
  }

  #serverMissing(error: unknown): boolean {
    return (
      error instanceof NetworkError ||
      (error instanceof HttpError && [404, 501, 502, 503, 504].includes(error.status))
    );
  }

  async refresh(): Promise<RoomSummary[] | null> {
    if (this.#closed) return null;
    const sequence = ++this.#sequence;

    if (this.#embedded) {
      this.#rooms = parseRooms(this.#fallbackRooms);
      this.#mode = 'embedded';
      this.#emit('roomsUpdated', { rooms: this.#rooms, source: 'embedded', updatedAt: Date.now() });
      return this.#rooms;
    }

    this.#active += 1;
    try {
      let data: unknown;
      let source: LobbyMode = 'server';
      const probeServer = this.#mode !== 'static' || Date.now() >= this.#nextServerProbe;
      try {
        if (!probeServer) throw new NetworkError(this.#apiUrl, null);
        data = await this.#request(this.#apiUrl);
      } catch (error: unknown) {
        if (!this.#serverMissing(error)) throw error;
        log.info('lobby', 'Сервер недоступний - використовую статичний список кімнат');
        this.#nextServerProbe = Date.now() + SERVER_PROBE_INTERVAL_MS;
        data = await this.#request(this.#staticUrl);
        source = 'static';
      }

      const rooms = parseRooms(data);
      if (this.#closed || sequence !== this.#sequence) return null;
      this.#rooms = rooms;
      this.#mode = source;
      this.#emit('roomsUpdated', { rooms, source, updatedAt: Date.now() });
      return rooms;
    } catch (error: unknown) {
      if (this.#closed || this.#controller.signal.aborted) return null;
      const kind = classifyError(error);
      const message = error instanceof Error ? error.message : String(error);
      log.warn('lobby', `помилка оновлення списку кімнат (${kind}): ${message}`);
      this.#emit('error', { error, kind });
      return null;
    } finally {
      this.#active -= 1;
    }
  }

  startPolling(): void {
    this.stopPolling();
    const tick = async (): Promise<void> => {
      if (this.#closed) return;
      await this.refresh();
      if (!this.#closed) this.#pollTimer = setTimeout(() => void tick(), this.#pollMs);
    };
    this.#pollTimer = setTimeout(() => void tick(), this.#pollMs);
  }

  stopPolling(): void {
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }

  async createRoom(input: {
    readonly name: string;
    readonly map?: string;
    readonly mode?: string;
    readonly maxPlayers?: number;
    readonly arena?: Record<string, number>;
  }): Promise<RoomSummary | null> {
    if (this.#closed) return null;
    if (this.#mode !== 'server') {
      return this.#fail('Створення кімнат доступне лише на запущеному сервері', 'offline');
    }
    this.#active += 1;
    try {
      const data = await this.#request(this.#apiUrl, { json: input, attempts: 1 });
      const [room] = parseRooms({ rooms: [data] });
      if (this.#closed || !room) return null;
      this.#emit('roomCreated', { room });
      await this.refresh();
      return room;
    } catch (error: unknown) {
      if (this.#closed || this.#controller.signal.aborted) return null;
      const kind = classifyError(error);
      const message =
        error instanceof HttpError
          ? describeHttpError(error)
          : error instanceof Error
            ? error.message
            : String(error);
      log.warn('lobby', `не вдалося створити кімнату (${kind}): ${message}`);
      return this.#fail(message, kind);
    } finally {
      this.#active -= 1;
    }
  }

  #validate(
    roomId: string,
    nickname: string,
    { allowOwnSlot = false }: { readonly allowOwnSlot?: boolean } = {},
  ):
    | { readonly failure: readonly [string, string] }
    | { readonly failure?: undefined; readonly name: string; readonly room: RoomSummary } {
    const name = nickname.trim();
    if (name.length < 2 || name.length > 16) {
      return { failure: ['Нікнейм має містити від 2 до 16 символів', 'nickname'] };
    }
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    if (!room) return { failure: ['Кімнату не знайдено - оновіть список', 'not-found'] };
    if (room.players >= room.maxPlayers && !allowOwnSlot) {
      return { failure: ['Кімната заповнена', 'full'] };
    }
    return { name, room };
  }

  async enterRoom(
    roomId: string,
    { nickname = '' }: { readonly nickname?: string } = {},
  ): Promise<RoomSummary | null> {
    if (this.#closed) return null;
    if (this.#mode !== 'server') return this.join(roomId, { nickname });

    const checked = this.#validate(roomId, nickname);
    if (checked.failure) return this.#fail(checked.failure[0], checked.failure[1]);

    this.leaveRoom();
    const connection = this.#createConnection(
      typeof this.#wsUrl === 'function' ? this.#wsUrl() : this.#wsUrl,
    );
    const session: ActiveSession = {
      connection,
      roomId,
      nickname: checked.name,
      entered: false,
      playerId: null,
      room: checked.room,
      listeners: [],
    };
    this.#session = session;

    const listen = (type: string, handler: (detail: Record<string, unknown>) => void): void => {
      const listener: EventListener = (event) => {
        if (event instanceof CustomEvent && event.detail && typeof event.detail === 'object') {
          handler({ ...event.detail });
        }
      };
      connection.addEventListener(type, listener);
      session.listeners.push([type, listener]);
    };

    listen('connected', () => {
      this.#emit('connection', { state: 'connected' });
      connection.send('join', { room: roomId, nickname: session.nickname });
    });
    listen('welcome', (detail) => {
      session.entered = true;
      session.playerId = typeof detail.playerId === 'string' ? detail.playerId : null;
      const [parsedRoom] = parseRooms({ rooms: [detail.room] });
      if (parsedRoom) session.room = parsedRoom;
      const players: PlayerSummary[] = Array.isArray(detail.players) ? detail.players : [];
      this.#emit('entered', {
        room: session.room,
        playerId: session.playerId,
        players,
        nickname: session.nickname,
      });
    });
    listen('roster', (detail) => this.#emit('roster', { players: detail.players }));
    listen('chat', (detail) => this.#emit('chat', detail));
    listen('error', (detail) => {
      const code = typeof detail.code === 'string' ? detail.code : 'error';
      const message = typeof detail.message === 'string' ? detail.message : 'Помилка';
      this.#emit('error', { error: new LobbyDataError(message, code), kind: code });
    });
    listen('reconnecting', (detail) => {
      session.entered = false;
      this.#emit('connection', { state: 'reconnecting', ...detail });
    });
    listen('disconnected', (detail) => {
      const code = typeof detail.code === 'number' ? detail.code : 1006;
      const willReconnect = Boolean(detail.willReconnect);
      if (this.#session !== session) return;
      if (!willReconnect) {
        this.#session = null;
        const kind = CLOSE_KINDS[code];
        if (kind) {
          this.#emit('error', {
            error: new LobbyDataError(`З’єднання закрито сервером (${code})`, kind),
            kind,
          });
        }
        this.#emit('left', { code });
      }
      this.#emit('connection', { state: 'disconnected', code, willReconnect });
    });
    listen('failed', () => this.#emit('connection', { state: 'failed' }));

    connection.connect();
    return checked.room;
  }

  sendChat(text: string): string | null {
    const session = this.#session;
    if (!session) return this.#fail('Ви не в кімнаті', 'not-in-room');
    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      return this.#fail('Повідомлення має містити 1-200 символів', 'chat');
    }
    session.connection.send('chat', { text: trimmed });
    return trimmed;
  }

  leaveRoom(): void {
    const session = this.#session;
    if (!session) return;
    this.#session = null;
    try {
      if (session.connection.state === 'open') session.connection.send('leave');
    } catch {
      /* з'єднання вже закрито */
    }
    session.connection.close();
    this.#emit('left', { code: 1000 });
  }

  async join(
    roomId: string,
    {
      nickname = '',
      keepConnection = false,
    }: { readonly nickname?: string; readonly keepConnection?: boolean } = {},
  ): Promise<RoomSummary | null> {
    if (this.#closed) return null;
    const ownSlot = Boolean(this.#session?.entered && this.#session.roomId === roomId);
    const checked = this.#validate(roomId, nickname, { allowOwnSlot: ownSlot });
    if (checked.failure) return this.#fail(checked.failure[0], checked.failure[1]);

    let connection: Connection | null = null;
    let playerId: string | null = null;
    if (keepConnection && ownSlot && this.#session) {
      if (this.#session.connection instanceof Connection) {
        connection = this.#session.connection;
      }
      playerId = this.#session.playerId;
      for (const [type, handler] of this.#session.listeners) {
        this.#session.connection.removeEventListener(type, handler);
      }
      this.#session = null;
    }

    this.close('joined');
    const detail: JoinedDetail = {
      room: checked.room,
      nickname: checked.name,
      mode: this.#mode,
      connection,
      playerId,
    };
    this.#emit('joined', detail);
    return checked.room;
  }

  close(reason = 'closed'): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stopPolling();
    const aborted = this.#active;
    const session = this.#session;
    this.#session = null;
    session?.connection.close();
    this.#controller.abort(new DOMException('Лобі закрито', 'AbortError'));
    log.info(
      'lobby',
      `лобі закрито (${reason}); скасовано запитів у польоті: ${aborted}${session ? '; WebSocket закрито' : ''}`,
    );
    this.#emit('closed', { reason, aborted });
  }
}
