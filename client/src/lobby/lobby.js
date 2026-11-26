/**
 * Лобі: шар даних. Три режими джерела кімнат:
 *   server   - реальний Node-сервер: GET/POST ./api/rooms і WebSocket ./ws (roster і чат у реальному часі);
 *   static   - сервера немає, але файл ./api/rooms.json доступний (звичайний статичний хостинг);
 *   embedded - сторінку відкрито як file://: вбудований список кімнат, жодних запитів.
 * У режимах static і embedded створення кімнат і чат недоступні, а Join одразу запускає локальний матч.
 *
 * Події (EventTarget):
 *   roomsUpdated { rooms, source, updatedAt }  - список оновлено
 *   roomCreated  { room }                      - кімнату створено на сервері
 *   entered      { room, playerId, players, nickname } - сервер прийняв join, гравець у кімнаті
 *   roster       { players }                   - склад кімнати змінився
 *   chat         { nickname, text, ts, ... }   - повідомлення чату
 *   connection   { state, attempt?, delayMs?, code? } - стан WebSocket (connected | reconnecting | disconnected | failed)
 *   left         {}                            - гравець покинув кімнату
 *   error        { error, kind }               - збій (timeout | http | network | parse | invalid | nickname | not-found | full | offline | ...)
 *   joined       { room, nickname }            - гравець іде в локальний матч (лобі закрито)
 *   closed       { reason, aborted }           - лобі закрито, активні запити скасовано
 *
 * Кожен запит має власний таймаут AbortSignal.timeout(3000). Єдиний AbortController лобі скасовує
 * ВСІ запити, що летять, і разом із закриттям WebSocket-сесії - у момент виходу з лобі в гру.
 */

import {
  anySignal,
  fetchJson,
  HttpError,
  isFileProtocol,
  JsonParseError,
  NetworkError,
  withRetry,
} from '../assets/loader.js';
import { DEFAULT_ROOMS } from '../assets/defaults.js';
import { Connection } from '../net/connection.js';
import { log } from '../util/log.js';

export class LobbyDataError extends Error {
  constructor(message, kind = 'invalid') {
    super(message);
    this.name = 'LobbyDataError';
    this.kind = kind;
  }
}

/** Перевіряє форму відповіді зі списком кімнат і повертає масив кімнат. */
export function parseRooms(data) {
  if (!data || !Array.isArray(data.rooms)) {
    throw new LobbyDataError('Некоректний список кімнат: немає масиву rooms');
  }
  return data.rooms.map((room, index) => {
    const valid =
      room &&
      typeof room.id === 'string' &&
      typeof room.name === 'string' &&
      Number.isInteger(room.players) &&
      room.players >= 0 &&
      Number.isInteger(room.maxPlayers) &&
      room.maxPlayers > 0;
    if (!valid) throw new LobbyDataError(`Некоректна кімната №${index + 1} у списку`);
    return {
      id: room.id,
      name: room.name,
      map: String(room.map ?? ''),
      mode: String(room.mode ?? ''),
      players: room.players,
      maxPlayers: room.maxPlayers,
      arena: room.arena && typeof room.arena === 'object' ? { ...room.arena } : {},
      replayId: typeof room.replayId === 'string' ? room.replayId : null,
    };
  });
}

/** Класифікація помилки для подій і інтерфейсу. */
export function classifyError(error) {
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error instanceof HttpError) return 'http';
  if (error instanceof JsonParseError) return 'parse';
  if (error instanceof LobbyDataError) return error.kind;
  if (error instanceof NetworkError) return 'network';
  return 'network';
}

/** Людське пояснення відмови сервера (тіло відповіді { error, message, details }). */
export function describeHttpError(error) {
  const body = error.body;
  if (body?.details?.length)
    return `${body.message ?? body.error ?? 'Помилка'}: ${body.details.join('; ')}`;
  if (body?.message) return body.message;
  return error.message;
}

/** Адреса WebSocket відносно поточної сторінки: ./ws із заміною http -> ws, https -> wss. */
export function defaultWsUrl() {
  const url = new URL('./ws', globalThis.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** Коди закриття WebSocket -> вид помилки для інтерфейсу. */
const CLOSE_KINDS = {
  1008: 'policy',
  1009: 'too-big',
  4001: 'auth-timeout',
  4003: 'not-found',
  4004: 'full',
  4005: 'slow-consumer',
};

const SERVER_PROBE_INTERVAL_MS = 30_000;

export class Lobby extends EventTarget {
  #apiUrl;
  #staticUrl;
  #wsUrl;
  #pollMs;
  #timeoutMs;
  #fallbackRooms;
  #embedded;
  #retry;
  #createConnection;
  #controller = new AbortController();
  #pollTimer = null;
  #rooms = [];
  #sequence = 0;
  #active = 0;
  #closed = false;
  #mode;
  #nextServerProbe = 0;
  #session = null; // { connection, roomId, nickname, entered }

  /**
   * @param {object} [options]
   * @param {string} [options.apiUrl] REST-ендпоінт кімнат
   * @param {string} [options.staticUrl] статичний файл зі списком кімнат (запасний варіант)
   * @param {string | (() => string)} [options.wsUrl] адреса WebSocket
   * @param {number} [options.pollMs] період опитування, мс
   * @param {number} [options.timeoutMs] таймаут одного запиту, мс
   * @param {object} [options.fallbackRooms] вбудований список для режиму file://
   * @param {boolean} [options.embedded] примусово брати вбудований список (за замовчуванням - у file://)
   * @param {object} [options.retry] параметри withRetry
   * @param {(url: string) => Connection} [options.createConnection] фабрика з'єднань (тести)
   */
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
  } = {}) {
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

  get rooms() {
    return this.#rooms;
  }

  get closed() {
    return this.#closed;
  }

  /** Поточний режим: 'server' | 'static' | 'embedded'. */
  get mode() {
    return this.#mode;
  }

  /** Скільки запитів зараз летить. */
  get activeRequests() {
    return this.#active;
  }

  /** Чи гравець зараз у кімнаті на сервері. */
  get inRoom() {
    return Boolean(this.#session?.entered);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #fail(message, kind, error = new LobbyDataError(message, kind)) {
    this.#emit('error', { error, kind });
    return null;
  }

  /** Один запит із таймаутом на кожну спробу, повторами й спільним сигналом лобі. */
  #request(url, { json, attempts } = {}) {
    return withRetry(
      () =>
        fetchJson(url, {
          json,
          signal: anySignal([this.#controller.signal, AbortSignal.timeout(this.#timeoutMs)]),
        }),
      { ...this.#retry, ...(attempts ? { attempts } : {}), signal: this.#controller.signal },
    );
  }

  /** Сервера немає (а не "сервер відповів помилкою"): можна пробувати статичний файл. */
  #serverMissing(error) {
    return (
      error instanceof NetworkError ||
      (error instanceof HttpError && [404, 501, 502, 503, 504].includes(error.status))
    );
  }

  /** Оновлює список кімнат. Повертає кімнати або null (збій, скасування, застарілу відповідь). */
  async refresh() {
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
      let data;
      let source = 'server';
      const probeServer = this.#mode !== 'static' || Date.now() >= this.#nextServerProbe;
      try {
        if (!probeServer) throw new NetworkError(this.#apiUrl, null);
        data = await this.#request(this.#apiUrl);
      } catch (error) {
        if (!this.#serverMissing(error)) throw error;
        // Немає сервера: запасний варіант - статичний файл. Повторну спробу сервера відкладаємо,
        // щоб не засмічувати мережу й консоль невдалими запитами при кожному опитуванні.
        log.info('lobby', 'Сервер недоступний - використовую статичний список кімнат');
        this.#nextServerProbe = Date.now() + SERVER_PROBE_INTERVAL_MS;
        data = await this.#request(this.#staticUrl);
        source = 'static';
      }

      const rooms = parseRooms(data);
      if (this.#closed || sequence !== this.#sequence) return null; // застаріла відповідь
      this.#rooms = rooms;
      this.#mode = source;
      this.#emit('roomsUpdated', { rooms, source, updatedAt: Date.now() });
      return rooms;
    } catch (error) {
      if (this.#closed || this.#controller.signal.aborted) return null; // скасовано нами
      const kind = classifyError(error);
      log.warn('lobby', `помилка оновлення списку кімнат (${kind}): ${error.message}`);
      this.#emit('error', { error, kind });
      return null;
    } finally {
      this.#active -= 1;
    }
  }

  /** Запускає періодичне опитування (кожен наступний запит - після завершення попереднього). */
  startPolling() {
    this.stopPolling();
    const tick = async () => {
      if (this.#closed) return;
      await this.refresh();
      if (!this.#closed) this.#pollTimer = setTimeout(tick, this.#pollMs);
    };
    this.#pollTimer = setTimeout(tick, this.#pollMs);
  }

  stopPolling() {
    clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }

  /**
   * Створює кімнату на сервері: POST ./api/rooms. Повторів немає: POST не ідемпотентний.
   * @param {{ name: string, map?: string, mode?: string, maxPlayers?: number, arena?: object }} input
   * @returns {Promise<object | null>} створена кімната або null
   */
  async createRoom(input) {
    if (this.#closed) return null;
    if (this.#mode !== 'server') {
      return this.#fail('Створення кімнат доступне лише на запущеному сервері', 'offline');
    }
    this.#active += 1;
    try {
      const data = await this.#request(this.#apiUrl, { json: input, attempts: 1 });
      const [room] = parseRooms({ rooms: [data] });
      if (this.#closed) return null;
      this.#emit('roomCreated', { room });
      await this.refresh();
      return room;
    } catch (error) {
      if (this.#closed || this.#controller.signal.aborted) return null;
      const kind = classifyError(error);
      const message = error instanceof HttpError ? describeHttpError(error) : error.message;
      log.warn('lobby', `не вдалося створити кімнату (${kind}): ${message}`);
      return this.#fail(message, kind);
    } finally {
      this.#active -= 1;
    }
  }

  #validate(roomId, nickname, { allowOwnSlot = false } = {}) {
    const name = nickname.trim();
    if (name.length < 2 || name.length > 16) {
      return { failure: ['Нікнейм має містити від 2 до 16 символів', 'nickname'] };
    }
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    if (!room) return { failure: ['Кімнату не знайдено - оновіть список', 'not-found'] };
    if (room.players >= room.maxPlayers && !allowOwnSlot)
      return { failure: ['Кімната заповнена', 'full'] };
    return { name, room };
  }

  /**
   * Входить у кімнату. На сервері відкриває WebSocket і надсилає join (після welcome приходить
   * подія 'entered'); без сервера одразу запускає локальний матч (як join()).
   */
  async enterRoom(roomId, { nickname = '' } = {}) {
    if (this.#closed) return null;
    if (this.#mode !== 'server') return this.join(roomId, { nickname });

    const checked = this.#validate(roomId, nickname);
    if (checked.failure) return this.#fail(...checked.failure);

    this.leaveRoom();
    const connection = this.#createConnection(
      typeof this.#wsUrl === 'function' ? this.#wsUrl() : this.#wsUrl,
    );
    const session = {
      connection,
      roomId,
      nickname: checked.name,
      entered: false,
      playerId: null,
      room: checked.room,
      listeners: [],
    };
    this.#session = session;

    const listen = (type, handler) => {
      connection.addEventListener(type, handler);
      session.listeners.push([type, handler]);
    };

    // Після кожного (пере)підключення join надсилається заново: сервер нічого не пам'ятає про сокет.
    listen('connected', () => {
      this.#emit('connection', { state: 'connected' });
      connection.send('join', { room: roomId, nickname: session.nickname });
    });
    listen('welcome', (event) => {
      session.entered = true;
      session.playerId = event.detail.playerId;
      session.room = event.detail.room;
      this.#emit('entered', {
        room: event.detail.room,
        playerId: event.detail.playerId,
        players: event.detail.players,
        nickname: session.nickname,
      });
    });
    listen('roster', (event) => this.#emit('roster', { players: event.detail.players }));
    listen('chat', (event) => this.#emit('chat', event.detail));
    listen('error', (event) => {
      const { code, message } = event.detail;
      this.#emit('error', { error: new LobbyDataError(message, code), kind: code });
    });
    listen('reconnecting', (event) => {
      session.entered = false;
      this.#emit('connection', { state: 'reconnecting', ...event.detail });
    });
    listen('disconnected', (event) => {
      const { code, willReconnect } = event.detail;
      if (this.#session !== session) return;
      if (!willReconnect) {
        this.#session = null;
        const kind = CLOSE_KINDS[code];
        if (kind)
          this.#emit('error', {
            error: new LobbyDataError(`З’єднання закрито сервером (${code})`, kind),
            kind,
          });
        this.#emit('left', { code });
      }
      this.#emit('connection', { state: 'disconnected', code, willReconnect });
    });
    listen('failed', () => this.#emit('connection', { state: 'failed' }));

    connection.connect();
    return checked.room;
  }

  /** Надсилає повідомлення чату в поточну кімнату. */
  sendChat(text) {
    const session = this.#session;
    if (!session) return this.#fail('Ви не в кімнаті', 'not-in-room');
    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > 200)
      return this.#fail('Повідомлення має містити 1-200 символів', 'chat');
    session.connection.send('chat', { text: trimmed });
    return trimmed;
  }

  /** Виходить із кімнати: повідомляє сервер і закриває WebSocket. */
  leaveRoom() {
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

  /**
   * Запускає матч у вибраній кімнаті. Якщо `keepConnection: true` і гравець уже в кімнаті на
   * сервері, живий WebSocket передається в гру без перепідключення (лобі лише знімає свої
   * слухачі й закриває HTTP-опитування). Інакше WebSocket закривається ще до події 'joined'.
   *
   * @returns {Promise<object | null>} кімната або null, якщо запустити не вдалося
   */
  async join(roomId, { nickname = '', keepConnection = false } = {}) {
    if (this.#closed) return null;
    const ownSlot = Boolean(this.#session?.entered && this.#session.roomId === roomId);
    const checked = this.#validate(roomId, nickname, { allowOwnSlot: ownSlot });
    if (checked.failure) return this.#fail(...checked.failure);

    let connection = null;
    let playerId = null;
    if (keepConnection && ownSlot && this.#session) {
      connection = this.#session.connection;
      playerId = this.#session.playerId;
      for (const [type, handler] of this.#session.listeners) {
        connection.removeEventListener(type, handler);
      }
      this.#session = null;
    }

    this.close('joined');
    this.#emit('joined', {
      room: checked.room,
      nickname: checked.name,
      mode: this.#mode,
      connection,
      playerId,
    });
    return checked.room;
  }

  /** Закриває лобі: зупиняє опитування, закриває WebSocket і негайно скасовує всі активні запити. */
  close(reason = 'closed') {
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
