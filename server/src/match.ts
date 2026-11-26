/**
 * Авторитативна ігрова сесія кімнати (Match) на 30 Гц.
 */

import {
  ARENA_SIZE,
  asSeq,
  asTick,
  binaryCodec,
  buildSnapshotMessage,
  expandInputMessage,
  IDLE_CONTROLS,
  INPUT_LIMITS,
  jsonCodec,
  snapshotForClient,
  TICK_DT,
  TICK_MS,
  TICK_RATE,
  validateInput,
  World,
  type CodecNameValue,
  type Controls,
  type EntityId,
  type InputCommand,
  type NetExplosionEvent,
  type Seq,
  type Tick,
} from '@dogfight/shared';
import { BotManager, type BotInfo } from './bot.ts';
import type { Logger } from './logger.ts';
import type { Room } from './rooms.ts';

const METRICS_WINDOW = 300;
const MAX_CATCH_UP_TICKS = 5;
const MAX_BACKLOG_AFTER_TAKE = 2;

export interface RollingSummary {
  readonly samples: number;
  readonly avg: number;
  readonly max: number;
  readonly p99: number;
}

export class RollingStats {
  #values: Float64Array;
  #next = 0;
  #size = 0;

  constructor(capacity = METRICS_WINDOW) {
    this.#values = new Float64Array(capacity);
  }

  push(value: number): void {
    this.#values[this.#next] = value;
    this.#next = (this.#next + 1) % this.#values.length;
    this.#size = Math.min(this.#size + 1, this.#values.length);
  }

  summary(): RollingSummary {
    if (this.#size === 0) return { samples: 0, avg: 0, max: 0, p99: 0 };
    const sorted = Array.from(this.#values.subarray(0, this.#size)).sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const round = (value: number): number => Math.round(value * 1000) / 1000;
    const maxVal = sorted[this.#size - 1] ?? 0;
    const p99Val = sorted[Math.min(this.#size - 1, Math.floor(this.#size * 0.99))] ?? 0;
    return {
      samples: this.#size,
      avg: round(sum / this.#size),
      max: round(maxVal),
      p99: round(p99Val),
    };
  }
}

function seedFromString(text: string): number {
  let hash = 7;
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return hash >>> 1;
}

interface MatchClient {
  readonly id: string;
  readonly nickname: string;
  readonly send: (frame: ArrayBuffer | string) => void;
  codec: CodecNameValue;
  queue: InputCommand[];
  lastSeq: Seq;
  lastProcessedSeq: Seq;
  lastControls: Controls;
  stats: {
    received: number;
    rejected: number;
    duplicate: number;
    overflow: number;
    skipped: number;
    starved: number;
  };
}

export interface MatchStartInfo {
  readonly shipId: EntityId;
  readonly tickRate: number;
  readonly tick: Tick;
  readonly arena: { readonly width: number; readonly height: number };
  readonly seed: number;
}

export interface MatchStats {
  readonly room: string;
  readonly running: boolean;
  readonly players: number;
  readonly tick: Tick;
  readonly tickRate: number;
  readonly entities: number;
  readonly tickDurationMs: RollingSummary;
  readonly tickJitterMs: RollingSummary;
  readonly counters: Record<string, number>;
  readonly clients: readonly Record<string, unknown>[];
}

export interface MatchManagerSummary {
  readonly matches: number;
  readonly running: number;
  readonly players: number;
  readonly tickRate: number;
  readonly tickDurationMs: { readonly avg: number; readonly max: number };
  readonly tickJitterMs: { readonly avg: number; readonly max: number };
}

export class Match {
  #room: Room;
  #logger: Logger;
  #now: () => number;
  #onBeforeTick?: (match: Match) => void;
  #world: World;
  #clients = new Map<string, MatchClient>();
  #events: NetExplosionEvent[] = [];
  #tick: Tick = asTick(0);
  #timer: ReturnType<typeof setTimeout> | null = null;
  #nextTickAt = 0;
  #lastStartAt: number | null = null;
  #running = false;
  #durationMs = new RollingStats();
  #jitterMs = new RollingStats();
  #counters = {
    ticks: 0,
    resyncs: 0,
    skippedTicks: 0,
    snapshotsSent: 0,
    snapshotBytes: 0,
    inputsReceived: 0,
    inputsRejected: 0,
    inputsDuplicate: 0,
    inputsOverflow: 0,
    inputsSkipped: 0,
    starvedTicks: 0,
    bytesIn: 0,
  };

  readonly seed: number;

  constructor({
    room,
    logger,
    now = () => performance.now(),
    onBeforeTick,
  }: {
    readonly room: Room;
    readonly logger: Logger;
    readonly now?: () => number;
    readonly onBeforeTick?: (match: Match) => void;
  }) {
    this.#room = room;
    this.#logger = logger;
    this.#now = now;
    this.#onBeforeTick = onBeforeTick;
    const arenaSeed = room.arena.seed;
    this.seed =
      typeof arenaSeed === 'number' && Number.isFinite(arenaSeed)
        ? arenaSeed
        : seedFromString(room.id);
    this.#world = new World({
      width: ARENA_SIZE.width,
      height: ARENA_SIZE.height,
      seed: this.seed,
      rules: room.arena,
    });
    this.#world.populate();
    this.#world.addEventListener('exploded', (event) => {
      if (this.#events.length >= 255 || !(event instanceof CustomEvent)) return;
      const d = event.detail;
      if (
        d &&
        (d.kind === 'ship' || d.kind === 'asteroid') &&
        typeof d.size === 'number' &&
        typeof d.x === 'number' &&
        typeof d.y === 'number'
      ) {
        this.#events.push({ type: 'explosion', kind: d.kind, size: d.size, x: d.x, y: d.y });
      }
    });
  }

  get roomId(): string {
    return this.#room.id;
  }

  get world(): World {
    return this.#world;
  }

  get tick(): Tick {
    return this.#tick;
  }

  get playerCount(): number {
    return this.#clients.size;
  }

  get running(): boolean {
    return this.#running;
  }

  has(playerId: string): boolean {
    return this.#clients.has(playerId);
  }

  addPlayer(
    playerId: string,
    {
      nickname,
      send,
      codec = 'binary',
    }: {
      readonly nickname: string;
      readonly send: (frame: ArrayBuffer | string) => void;
      readonly codec?: CodecNameValue;
    },
  ): MatchStartInfo {
    if (this.#clients.has(playerId)) throw new Error(`гравець уже в матчі: ${playerId}`);
    const player = this.#world.addPlayer(playerId);
    this.#clients.set(playerId, {
      id: playerId,
      nickname,
      send,
      codec,
      queue: [],
      lastSeq: asSeq(0),
      lastProcessedSeq: asSeq(0),
      lastControls: IDLE_CONTROLS,
      stats: { received: 0, rejected: 0, duplicate: 0, overflow: 0, skipped: 0, starved: 0 },
    });
    if (!this.#running) this.start();
    return {
      shipId: player.ship.id,
      tickRate: TICK_RATE,
      tick: this.#tick,
      arena: { width: ARENA_SIZE.width, height: ARENA_SIZE.height },
      seed: this.seed,
    };
  }

  removePlayer(playerId: string): boolean {
    if (!this.#clients.delete(playerId)) return false;
    this.#world.removePlayer(playerId);
    if (this.#clients.size === 0) this.stop();
    return true;
  }

  setCodec(playerId: string, codec: CodecNameValue): void {
    const client = this.#clients.get(playerId);
    if (client) client.codec = codec;
  }

  submitInput(
    playerId: string,
    message: {
      readonly seq: number;
      readonly tick: number;
      readonly thrust: boolean;
      readonly turn: number;
      readonly fire: boolean;
      readonly missile?: boolean;
      readonly prev?: readonly {
        readonly thrust?: boolean;
        readonly turn?: number;
        readonly fire?: boolean;
        readonly missile?: boolean;
      }[];
    },
    { bytes = 0 }: { readonly bytes?: number } = {},
  ): { readonly accepted: number; readonly rejected: number; readonly reason?: string } {
    const client = this.#clients.get(playerId);
    if (!client) return { accepted: 0, rejected: 0 };
    this.#counters.bytesIn += bytes;

    let accepted = 0;
    let rejected = 0;
    let reason: string | undefined;
    for (const command of expandInputMessage(message)) {
      const checked = validateInput(command);
      if (!checked.ok) {
        rejected += 1;
        reason = checked.error;
        continue;
      }
      const input = checked.data;
      if (input.seq <= client.lastSeq) {
        client.stats.duplicate += 1;
        this.#counters.inputsDuplicate += 1;
        continue;
      }
      if (input.tick > this.#tick + INPUT_LIMITS.maxTickAhead) {
        rejected += 1;
        reason = 'tick_in_future';
        continue;
      }
      client.lastSeq = input.seq;
      if (client.queue.length >= INPUT_LIMITS.maxQueue) {
        client.queue.shift();
        client.stats.overflow += 1;
        this.#counters.inputsOverflow += 1;
      }
      client.queue.push(input);
      client.stats.received += 1;
      this.#counters.inputsReceived += 1;
      accepted += 1;
    }
    client.stats.rejected += rejected;
    this.#counters.inputsRejected += rejected;
    return { accepted, rejected, reason };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#lastStartAt = null;
    this.#nextTickAt = this.#now() + TICK_MS;
    this.#scheduleNext();
    this.#logger.info('матч запущено', { room: this.#room.id, tickRate: TICK_RATE });
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#logger.info('матч зупинено', { room: this.#room.id, ticks: this.#tick });
  }

  #scheduleNext(): void {
    const delay = Math.max(0, this.#nextTickAt - this.#now());
    this.#timer = setTimeout(this.#onTimer, delay);
    this.#timer.unref?.();
  }

  #onTimer = (): void => {
    if (!this.#running) return;
    const startedAt = this.#now();
    if (this.#lastStartAt !== null) {
      this.#jitterMs.push(Math.abs(startedAt - this.#lastStartAt - TICK_MS));
    }
    this.#lastStartAt = startedAt;

    try {
      this.stepTick();
    } catch (error: unknown) {
      this.#logger.error('помилка тіка матчу', { room: this.#room.id, error });
    }

    const finishedAt = this.#now();
    this.#durationMs.push(finishedAt - startedAt);

    this.#nextTickAt += TICK_MS;
    const behind = finishedAt - this.#nextTickAt;
    if (behind > MAX_CATCH_UP_TICKS * TICK_MS) {
      const skipped = Math.floor(behind / TICK_MS);
      this.#counters.skippedTicks += skipped;
      this.#counters.resyncs += 1;
      this.#nextTickAt = finishedAt + TICK_MS;
      this.#logger.warn('матч відстав: пропускаю тіки', { room: this.#room.id, skipped });
    }
    if (this.#running) this.#scheduleNext();
  };

  stepTick(): void {
    this.#onBeforeTick?.(this);
    for (const client of this.#clients.values()) {
      let command = client.queue.shift();
      while (client.queue.length > MAX_BACKLOG_AFTER_TAKE) {
        command = client.queue.shift();
        client.stats.skipped += 1;
        this.#counters.inputsSkipped += 1;
      }
      if (command) {
        client.lastControls = command;
        client.lastProcessedSeq = command.seq;
      } else {
        client.stats.starved += 1;
        this.#counters.starvedTicks += 1;
      }
      this.#world.setInput(client.id, client.lastControls);
    }

    this.#world.step(TICK_DT);
    this.#tick = asTick(this.#tick + 1);
    this.#counters.ticks += 1;
    this.#broadcast();
  }

  #broadcast(): void {
    const message = buildSnapshotMessage(this.#world, { tick: this.#tick, events: this.#events });
    this.#events = [];
    let binary: ArrayBuffer | null = null;

    for (const client of this.#clients.values()) {
      let frame: ArrayBuffer | string;
      if (client.codec === 'json') {
        frame = jsonCodec.encode({ ...message, lastProcessedSeq: client.lastProcessedSeq });
      } else {
        binary ??= binaryCodec.encode(message);
        frame = snapshotForClient(binary, client.lastProcessedSeq);
      }
      this.#counters.snapshotsSent += 1;
      this.#counters.snapshotBytes +=
        typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength;
      try {
        client.send(frame);
      } catch (error: unknown) {
        this.#logger.warn('помилка відправки знімка', { client: client.id, error });
      }
    }
  }

  stats(): MatchStats {
    const c = this.#counters;
    return {
      room: this.#room.id,
      running: this.#running,
      players: this.#clients.size,
      tick: this.#tick,
      tickRate: TICK_RATE,
      entities: [...this.#world].length,
      tickDurationMs: this.#durationMs.summary(),
      tickJitterMs: this.#jitterMs.summary(),
      counters: {
        ...c,
        avgSnapshotBytes: c.snapshotsSent ? Math.round(c.snapshotBytes / c.snapshotsSent) : 0,
      },
      clients: [...this.#clients.values()].map((client) => ({
        id: client.id,
        nickname: client.nickname,
        codec: client.codec,
        queue: client.queue.length,
        lastProcessedSeq: client.lastProcessedSeq,
        ...client.stats,
      })),
    };
  }
}

export class MatchManager {
  #matches = new Map<string, Match>();
  #bots = new BotManager();
  #logger: Logger;
  #now?: () => number;

  constructor({ logger, now }: { readonly logger: Logger; readonly now?: () => number }) {
    this.#logger = logger;
    this.#now = now;
  }

  get size(): number {
    return this.#matches.size;
  }

  get(roomId: string): Match | undefined {
    return this.#matches.get(roomId);
  }

  getOrCreate(room: Room): Match {
    let match = this.#matches.get(room.id);
    if (!match) {
      match = new Match({
        room,
        logger: this.#logger,
        now: this.#now,
        onBeforeTick: (m) => this.#bots.stepBots(m),
      });
      this.#matches.set(room.id, match);
    }
    return match;
  }

  addBots(room: Room, count: number): BotInfo[] {
    const match = this.getOrCreate(room);
    return this.#bots.addBots(match, count);
  }

  remove(roomId: string): boolean {
    this.#bots.removeRoom(roomId);
    const match = this.#matches.get(roomId);
    if (!match) return false;
    match.stop();
    return this.#matches.delete(roomId);
  }

  stats(): { readonly matches: MatchStats[]; readonly summary: MatchManagerSummary } {
    const matches = [...this.#matches.values()].map((match) => match.stats());
    const active = matches.filter((m) => m.running);
    const worst = (key: 'tickDurationMs' | 'tickJitterMs', field: 'avg' | 'max'): number =>
      active.reduce((max, m) => Math.max(max, m[key][field]), 0);
    const mean = (key: 'tickDurationMs' | 'tickJitterMs', field: 'avg' | 'max'): number =>
      active.length ? active.reduce((sum, m) => sum + m[key][field], 0) / active.length : 0;
    const round = (value: number): number => Math.round(value * 1000) / 1000;
    return {
      matches,
      summary: {
        matches: matches.length,
        running: active.length,
        players: matches.reduce((sum, m) => sum + m.players, 0),
        tickRate: TICK_RATE,
        tickDurationMs: {
          avg: round(mean('tickDurationMs', 'avg')),
          max: worst('tickDurationMs', 'max'),
        },
        tickJitterMs: {
          avg: round(mean('tickJitterMs', 'avg')),
          max: worst('tickJitterMs', 'max'),
        },
      },
    };
  }

  close(): void {
    for (const match of this.#matches.values()) match.stop();
    this.#matches.clear();
  }
}
