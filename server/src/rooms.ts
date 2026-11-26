/**
 * Кімнати лобі з суворо типізованими подіями EventEmitter<RoomEvents> і EventEmitter<RoomManagerEvents>.
 */

import { EventEmitter } from 'node:events';
import { makeRoomId, type PlayerSummary, type RoomSummary } from '@dogfight/shared';

export class RoomError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

export interface ChatRecord {
  readonly playerId: string;
  readonly nickname: string;
  readonly text: string;
  readonly ts: number;
}

export type RoomLogEvent =
  | { readonly type: 'join'; readonly playerId: string; readonly nickname: string }
  | { readonly type: 'leave'; readonly playerId: string; readonly nickname: string }
  | ({ readonly type: 'chat' } & ChatRecord);

export interface RoomEvents {
  join: [player: PlayerSummary];
  leave: [player: PlayerSummary];
  chat: [message: ChatRecord];
  empty: [room: Room];
  event: [record: RoomLogEvent];
}

export interface RoomOptions {
  readonly id: string;
  readonly name: string;
  readonly map?: string;
  readonly mode?: string;
  readonly maxPlayers?: number;
  readonly arena?: Record<string, number>;
  readonly now?: () => number;
}

export class Room extends EventEmitter<RoomEvents> {
  #players = new Map<string, PlayerSummary>();
  #now: () => number;

  readonly id: string;
  readonly name: string;
  readonly map: string;
  readonly mode: string;
  readonly maxPlayers: number;
  readonly arena: Record<string, number>;
  readonly createdAt: number;
  replayId: string | null = null;

  constructor({
    id,
    name,
    map = 'Open Space',
    mode = 'Sandbox',
    maxPlayers = 8,
    arena = {},
    now = Date.now,
  }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.map = map;
    this.mode = mode;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.createdAt = now();
    this.#now = now;
  }

  get size(): number {
    return this.#players.size;
  }

  get isFull(): boolean {
    return this.#players.size >= this.maxPlayers;
  }

  has(playerId: string): boolean {
    return this.#players.has(playerId);
  }

  join(player: PlayerSummary): PlayerSummary[] {
    if (this.#players.has(player.id)) throw new RoomError('player_exists', 'гравець уже в кімнаті');
    if (this.isFull) throw new RoomError('room_full', 'кімната заповнена');
    const taken = [...this.#players.values()].some(
      (other) => other.nickname.toLowerCase() === player.nickname.toLowerCase(),
    );
    if (taken) throw new RoomError('nickname_taken', 'нікнейм зайнятий у цій кімнаті');

    const entry: PlayerSummary = { id: player.id, nickname: player.nickname };
    this.#players.set(entry.id, entry);
    this.emit('join', entry);
    this.emit('event', { type: 'join', playerId: entry.id, nickname: entry.nickname });
    return this.roster();
  }

  leave(playerId: string): boolean {
    const player = this.#players.get(playerId);
    if (!player) return false;
    this.#players.delete(playerId);
    this.emit('leave', player);
    this.emit('event', { type: 'leave', playerId, nickname: player.nickname });
    if (this.#players.size === 0) this.emit('empty', this);
    return true;
  }

  chat(playerId: string, text: string): ChatRecord {
    const player = this.#players.get(playerId);
    if (!player) throw new RoomError('not_member', 'гравця немає в кімнаті');
    const message: ChatRecord = { playerId, nickname: player.nickname, text, ts: this.#now() };
    this.emit('chat', message);
    this.emit('event', { type: 'chat', ...message });
    return message;
  }

  roster(): PlayerSummary[] {
    return [...this.#players.values()].map(({ id, nickname }) => ({ id, nickname }));
  }

  toJSON(): RoomSummary {
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

export interface RoomManagerEvents {
  created: [room: Room];
  removed: [room: Room];
}

export interface RoomManagerOptions {
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly emptyRoomTtlMs: number;
  readonly now?: () => number;
  readonly makeId?: (name: string) => string;
}

export class RoomManager extends EventEmitter<RoomManagerEvents> {
  #rooms = new Map<string, Room>();
  #emptyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #limits: { maxRooms: number; maxPlayersPerRoom: number; emptyRoomTtlMs: number };
  #now: () => number;
  #makeId: (name: string) => string;

  constructor({
    maxRooms,
    maxPlayersPerRoom,
    emptyRoomTtlMs,
    now = Date.now,
    makeId = (name) => makeRoomId(name, Math.random),
  }: RoomManagerOptions) {
    super();
    this.#limits = { maxRooms, maxPlayersPerRoom, emptyRoomTtlMs };
    this.#now = now;
    this.#makeId = makeId;
  }

  get size(): number {
    return this.#rooms.size;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  has(id: string): boolean {
    return this.#rooms.has(id);
  }

  list(): RoomSummary[] {
    return [...this.#rooms.values()].map((room) => room.toJSON());
  }

  create({
    name,
    map,
    mode,
    maxPlayers,
    arena,
  }: {
    readonly name: string;
    readonly map?: string;
    readonly mode?: string;
    readonly maxPlayers?: number;
    readonly arena?: Record<string, number>;
  }): Room {
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

    const timer = setTimeout(() => this.remove(id), this.#limits.emptyRoomTtlMs);
    timer.unref?.();
    this.#emptyTimers.set(id, timer);
    return room;
  }

  remove(id: string): boolean {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#clearEmptyTimer(id);
    this.#rooms.delete(id);
    room.removeAllListeners('join');
    room.removeAllListeners('empty');
    this.emit('removed', room);
    return true;
  }

  #clearEmptyTimer(id: string): void {
    clearTimeout(this.#emptyTimers.get(id));
    this.#emptyTimers.delete(id);
  }

  destroy(): void {
    for (const timer of this.#emptyTimers.values()) clearTimeout(timer);
    this.#emptyTimers.clear();
  }
}
