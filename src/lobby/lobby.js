/**
 * Лобі: шар даних. Читає список кімнат по HTTP, опитує його за таймером і повідомляє підписників
 * подіями EventTarget:
 *   roomsUpdated { rooms, source, updatedAt }   - список оновлено ('network' або 'embedded')
 *   error        { error, kind }                - збій запиту (timeout | http | network | parse | invalid)
 *   joined       { room, nickname }             - гравець приєднався до кімнати
 *   closed       { reason, aborted }            - лобі закрито, активні запити скасовано
 *
 * Кожен запит має власний таймаут AbortSignal.timeout(3000). Єдиний AbortController лобі
 * скасовує ВСІ запити, що летять, у момент виходу з лобі в гру: «осиротілих» запитів не лишається.
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
import { log } from '../util/log.js';

export class LobbyDataError extends Error {
  constructor(message, kind = 'invalid') {
    super(message);
    this.name = 'LobbyDataError';
    this.kind = kind;
  }
}

/** Перевіряє форму rooms.json і повертає масив кімнат. */
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

export class Lobby extends EventTarget {
  #roomsUrl;
  #pollMs;
  #timeoutMs;
  #fallbackRooms;
  #embedded;
  #retry;
  #controller = new AbortController();
  #pollTimer = null;
  #rooms = [];
  #sequence = 0;
  #active = 0;
  #closed = false;

  /**
   * @param {object} [options]
   * @param {string} [options.roomsUrl]
   * @param {number} [options.pollMs] період опитування, мс
   * @param {number} [options.timeoutMs] таймаут одного запиту, мс
   * @param {object} [options.fallbackRooms] вбудований список для режиму file://
   * @param {boolean} [options.embedded] примусово брати вбудований список (за замовчуванням - у file://)
   * @param {object} [options.retry] параметри withRetry
   */
  constructor({
    roomsUrl = './api/rooms.json',
    pollMs = 5000,
    timeoutMs = 3000,
    fallbackRooms = DEFAULT_ROOMS,
    embedded = isFileProtocol(),
    retry = { attempts: 2, baseMs: 300 },
  } = {}) {
    super();
    this.#roomsUrl = roomsUrl;
    this.#pollMs = pollMs;
    this.#timeoutMs = timeoutMs;
    this.#fallbackRooms = fallbackRooms;
    this.#embedded = embedded;
    this.#retry = retry;
  }

  get rooms() {
    return this.#rooms;
  }

  get closed() {
    return this.#closed;
  }

  /** Скільки запитів зараз летить. */
  get activeRequests() {
    return this.#active;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Оновлює список кімнат. Повертає кімнати або null (збій, скасування, застарілу відповідь). */
  async refresh() {
    if (this.#closed) return null;
    const sequence = ++this.#sequence;

    if (this.#embedded) {
      this.#rooms = parseRooms(this.#fallbackRooms);
      this.#emit('roomsUpdated', { rooms: this.#rooms, source: 'embedded', updatedAt: Date.now() });
      return this.#rooms;
    }

    this.#active += 1;
    try {
      const data = await withRetry(
        () =>
          fetchJson(this.#roomsUrl, {
            // Таймаут на кожну спробу + глобальна відміна лобі.
            signal: anySignal([this.#controller.signal, AbortSignal.timeout(this.#timeoutMs)]),
          }),
        { ...this.#retry, signal: this.#controller.signal },
      );
      const rooms = parseRooms(data);
      if (this.#closed || sequence !== this.#sequence) return null; // застаріла відповідь
      this.#rooms = rooms;
      this.#emit('roomsUpdated', { rooms, source: 'network', updatedAt: Date.now() });
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
   * Приєднує гравця до кімнати за останнім отриманим списком. Статичний хостинг не має
   * ендпоінта join, тому перевірка локальна. Після успіху лобі закривається, а всі активні
   * запити скасовуються ще до того, як підписники отримають 'joined'.
   *
   * @returns {Promise<object | null>} кімната або null, якщо приєднатися не вдалося
   */
  async join(roomId, { nickname = '' } = {}) {
    if (this.#closed) return null;
    const name = nickname.trim();
    const fail = (message, kind) => {
      this.#emit('error', { error: new LobbyDataError(message, kind), kind });
      return null;
    };

    if (name.length < 2 || name.length > 16)
      return fail('Нікнейм має містити від 2 до 16 символів', 'nickname');
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    if (!room) return fail('Кімнату не знайдено - оновіть список', 'not-found');
    if (room.players >= room.maxPlayers) return fail('Кімната заповнена', 'full');

    this.close('joined');
    this.#emit('joined', { room, nickname: name });
    return room;
  }

  /** Закриває лобі: зупиняє опитування й негайно скасовує всі активні запити. */
  close(reason = 'closed') {
    if (this.#closed) return;
    this.#closed = true;
    this.stopPolling();
    const aborted = this.#active;
    this.#controller.abort(new DOMException('Лобі закрито', 'AbortError'));
    log.info('lobby', `лобі закрито (${reason}); скасовано запитів у польоті: ${aborted}`);
    this.#emit('closed', { reason, aborted });
  }
}
