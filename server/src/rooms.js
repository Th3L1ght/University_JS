/**
 * Кімнати лобі. Room та RoomManager не знають про мережу: вони лише тримають стан і
 * повідомляють про зміни подіями EventEmitter. Мережевий шар (ws.js) і журнал матчу
 * (log/matchlog.js) підписуються на ці події.
 */

import { EventEmitter } from 'node:events';
import { makeRoomId } from './protocol.js';

/** Помилка правил кімнат; `code` - машинозчитуваний ідентифікатор. */
export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

/**
 * Кімната з Map гравців.
 *
 * Події:
 *   join   (player)
 *   leave  (player)
 *   chat   ({ playerId, nickname, text, ts })
 *   empty  (room)         - після виходу останнього гравця
 *   event  ({ type, ... }) - універсальний запис для журналу матчу (join/leave/chat)
 */
export class Room extends EventEmitter {
  #players = new Map();
  #now;

  /**
   * @param {object} options
   * @param {string} options.id
   * @param {string} options.name
   * @param {string} [options.map]
   * @param {string} [options.mode]
   * @param {number} [options.maxPlayers]
   * @param {object} [options.arena] параметри арени (клієнт накладає їх на правила світу)
   * @param {() => number} [options.now]
   */
  constructor({
    id,
    name,
    map = 'Open Space',
    mode = 'Sandbox',
    maxPlayers = 8,
    arena = {},
    now = Date.now,
  }) {
    super();
    this.id = id;
    this.name = name;
    this.map = map;
    this.mode = mode;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.createdAt = now();
    /** Ідентифікатор журналу матчу (для GET /api/replays/:id); виставляє застосунок. */
    this.replayId = null;
    this.#now = now;
  }

  get size() {
    return this.#players.size;
  }

  get isFull() {
    return this.#players.size >= this.maxPlayers;
  }

  has(playerId) {
    return this.#players.has(playerId);
  }

  /** @param {{ id: string, nickname: string }} player */
  join(player) {
    if (this.#players.has(player.id)) throw new RoomError('player_exists', 'гравець уже в кімнаті');
    if (this.isFull) throw new RoomError('room_full', 'кімната заповнена');
    const taken = [...this.#players.values()].some(
      (other) => other.nickname.toLowerCase() === player.nickname.toLowerCase(),
    );
    if (taken) throw new RoomError('nickname_taken', 'нікнейм зайнятий у цій кімнаті');

    const entry = { id: player.id, nickname: player.nickname };
    this.#players.set(entry.id, entry);
    this.emit('join', entry);
    this.emit('event', { type: 'join', playerId: entry.id, nickname: entry.nickname });
    return this.roster();
  }

  /** @returns {boolean} true, якщо гравець був у кімнаті */
  leave(playerId) {
    const player = this.#players.get(playerId);
    if (!player) return false;
    this.#players.delete(playerId);
    this.emit('leave', player);
    this.emit('event', { type: 'leave', playerId, nickname: player.nickname });
    if (this.#players.size === 0) this.emit('empty', this);
    return true;
  }

  /** Повідомлення чату від гравця, що перебуває в кімнаті. */
  chat(playerId, text) {
    const player = this.#players.get(playerId);
    if (!player) throw new RoomError('not_member', 'гравця немає в кімнаті');
    const message = { playerId, nickname: player.nickname, text, ts: this.#now() };
    this.emit('chat', message);
    this.emit('event', { type: 'chat', ...message });
    return message;
  }

  roster() {
    return [...this.#players.values()].map(({ id, nickname }) => ({ id, nickname }));
  }

  /** Опис для REST: та сама форма, що й у public/api/rooms.json. */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      map: this.map,
      mode: this.mode,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
      replayId: this.replayId,
    };
  }
}

/**
 * Менеджер кімнат. Порожню кімнату видаляє автоматично: за подією "empty" (останній гравець
 * вийшов) або за таймером, якщо в щойно створену кімнату так ніхто й не зайшов.
 *
 * Події: created (room), removed (room).
 */
export class RoomManager extends EventEmitter {
  #rooms = new Map();
  #emptyTimers = new Map();
  #limits;
  #now;
  #makeId;

  /**
   * @param {object} options
   * @param {number} options.maxRooms
   * @param {number} options.maxPlayersPerRoom верхня межа maxPlayers однієї кімнати
   * @param {number} options.emptyRoomTtlMs
   */
  constructor({
    maxRooms,
    maxPlayersPerRoom,
    emptyRoomTtlMs,
    now = Date.now,
    makeId = makeRoomId,
  }) {
    super();
    this.#limits = { maxRooms, maxPlayersPerRoom, emptyRoomTtlMs };
    this.#now = now;
    this.#makeId = makeId;
  }

  get size() {
    return this.#rooms.size;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  has(id) {
    return this.#rooms.has(id);
  }

  list() {
    return [...this.#rooms.values()].map((room) => room.toJSON());
  }

  /** @returns {Room} */
  create({ name, map, mode, maxPlayers, arena }) {
    if (this.#rooms.size >= this.#limits.maxRooms) {
      throw new RoomError('room_limit', `досягнуто ліміт кімнат (${this.#limits.maxRooms})`);
    }

    let id = this.#makeId(name);
    while (this.#rooms.has(id)) id = this.#makeId(name);

    const room = new Room({
      id,
      name,
      map,
      mode,
      maxPlayers: Math.min(maxPlayers ?? 8, this.#limits.maxPlayersPerRoom),
      arena,
      now: this.#now,
    });
    this.#rooms.set(id, room);

    room.once('join', () => this.#clearEmptyTimer(id));
    room.on('empty', () => this.remove(id));
    this.emit('created', room);

    // Кімната, у яку так ніхто й не зайшов, не має висіти вічно.
    const timer = setTimeout(() => this.remove(id), this.#limits.emptyRoomTtlMs);
    timer.unref?.();
    this.#emptyTimers.set(id, timer);
    return room;
  }

  /** @returns {boolean} true, якщо кімнату було видалено */
  remove(id) {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#clearEmptyTimer(id);
    this.#rooms.delete(id);
    room.removeAllListeners('join');
    room.removeAllListeners('empty');
    this.emit('removed', room);
    return true;
  }

  #clearEmptyTimer(id) {
    clearTimeout(this.#emptyTimers.get(id));
    this.#emptyTimers.delete(id);
  }

  /** Зупиняє всі таймери (під час коректного завершення). */
  destroy() {
    for (const timer of this.#emptyTimers.values()) clearTimeout(timer);
    this.#emptyTimers.clear();
  }
}
