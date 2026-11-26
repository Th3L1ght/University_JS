/**
 * Обгортка над браузерним WebSocket.
 *
 *  - черга відправки: повідомлення, надіслані до відкриття сокета (CONNECTING) або під час
 *    перепідключення, чекають у черзі й відправляються після відкриття, у тому самому порядку;
 *  - диспетчеризація вхідних повідомлень за полем `type`: кожен тип стає подією EventTarget
 *    (`welcome`, `roster`, `chat`, `pong`, `error`);
 *  - автоматичне перепідключення з експоненційним backoff, окрім випадків, коли сервер явно
 *    відмовив (коди нижче) або з'єднання закрив сам користувач.
 *
 * Події життєвого циклу: connected, disconnected { code, reason, willReconnect },
 * reconnecting { attempt, delayMs }, failed, protocolerror { reason }.
 *
 * Порядок після перепідключення: спочатку подія `connected` (застосунок повторно надсилає join),
 * і лише потім скидається черга, щоб чат не випередив join.
 */

import { backoffDelay } from '../util/backoff.js';

export const PROTOCOL_VERSION = 1;

/** Коди закриття, після яких перепідключатися марно: сервер відмовив свідомо. */
export const NO_RECONNECT_CODES = Object.freeze([
  1000, // нормальне закриття (наприклад, після leave)
  1003, // непідтримувані дані
  1007, // хибний формат
  1008, // порушення політики (ліміти, невідомий тип)
  1009, // надто велике повідомлення
  4001, // таймаут авторизації
  4003, // кімнату не знайдено
  4004, // кімната заповнена
  4005, // повільний клієнт
]);

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export class Connection extends EventTarget {
  #url;
  #WebSocketImpl;
  #backoff;
  #random;
  #maxQueue;
  #socket = null;
  #queue = [];
  #state = 'idle'; // idle | connecting | open | reconnecting | closed
  #attempt = 0;
  #timer = null;
  #closedByUser = false;

  /**
   * @param {object} options
   * @param {string} options.url адреса ws:// або wss://
   * @param {typeof WebSocket} [options.WebSocketImpl] підміна реалізації (тести)
   * @param {{ baseMs?: number, maxMs?: number, maxAttempts?: number }} [options.backoff]
   * @param {() => number} [options.random]
   * @param {number} [options.maxQueue] максимум повідомлень у черзі
   */
  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    backoff = { baseMs: 500, maxMs: 15000, maxAttempts: Infinity },
    random = Math.random,
    maxQueue = 100,
  }) {
    super();
    this.#url = url;
    this.#WebSocketImpl = WebSocketImpl;
    this.#backoff = backoff;
    this.#random = random;
    this.#maxQueue = maxQueue;
  }

  get state() {
    return this.#state;
  }

  get queued() {
    return this.#queue.length;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Відкриває з'єднання. Повторний виклик під час підключення нічого не робить. */
  connect() {
    if (this.#state === 'connecting' || this.#state === 'open') return;
    this.#closedByUser = false;
    this.#open('connecting');
  }

  #open(state) {
    this.#state = state === 'connecting' && this.#attempt > 0 ? 'reconnecting' : state;
    const socket = new this.#WebSocketImpl(this.#url);
    this.#socket = socket;

    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#state = 'open';
      this.#emit('connected', {});
      this.#flush(); // після connected: застосунок міг надіслати join першим
    };

    socket.onmessage = (event) => this.#onMessage(event.data);

    socket.onerror = () => {
      // Деталі помилки браузер приховує; рішення про перепідключення ухвалюється в onclose.
    };

    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#onClosed(event.code, event.reason);
    };
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.#emit('protocolerror', { reason: 'не JSON' });
      return;
    }
    if (
      message === null ||
      typeof message !== 'object' ||
      message.v !== PROTOCOL_VERSION ||
      typeof message.type !== 'string'
    ) {
      this.#emit('protocolerror', { reason: 'хибна схема або версія повідомлення' });
      return;
    }
    // type стає ім'ям події: conn.addEventListener('roster', ...).
    this.#emit(message.type, message);
  }

  #onClosed(code, reason) {
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

  #flush() {
    while (this.#queue.length > 0 && this.#socket?.readyState === WS_OPEN) {
      this.#socket.send(this.#queue.shift());
    }
  }

  /**
   * Надсилає повідомлення { v, type, ...payload }. Якщо сокет ще не відкрито (CONNECTING або
   * перепідключення), повідомлення потрапляє в чергу.
   *
   * @returns {'sent' | 'queued'}
   * @throws {Error} якщо з'єднання закрито остаточно або черга переповнена
   */
  send(type, payload = {}) {
    if (this.#state === 'closed') throw new Error('З’єднання закрито');
    const text = JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload });

    if (this.#state === 'open' && this.#socket?.readyState === WS_OPEN) {
      this.#socket.send(text);
      return 'sent';
    }
    if (this.#state === 'idle') throw new Error('Спершу викличте connect()');
    if (this.#queue.length >= this.#maxQueue) throw new Error('Черга відправки переповнена');
    this.#queue.push(text);
    return 'queued';
  }

  /** Закриває з'єднання остаточно: перепідключення не буде, черга скидається. */
  close(code = 1000, reason = '') {
    this.#closedByUser = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue.length = 0;
    const socket = this.#socket;
    if (socket && (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING)) {
      socket.close(code, reason);
      return; // стан змінить onclose
    }
    this.#socket = null;
    if (this.#state !== 'closed') {
      this.#state = 'closed';
      this.#emit('disconnected', { code, reason, willReconnect: false });
    }
  }
}
