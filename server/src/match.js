/**
 * Авторитативна ігрова сесія кімнати (Match).
 *
 * Сервер - єдине джерело істини: клієнти надсилають лише ВВІД (seq, tick, thrust, turn, fire),
 * а стан світу рахує тут спільний детермінований World з @dogfight/shared. Кожен тік (30 Гц):
 *   1. кожному гравцеві береться рівно ОДНА команда з черги (більше не можна - захист від
 *      спід-хаку); якщо черга порожня, повторюється попередній ввід;
 *   2. world.step(TICK_DT);
 *   3. знімок світу кодується (бінарно один раз для всіх) і розсилається; кожен клієнт отримує
 *      поле lastProcessedSeq - номер своєї останньої врахованої команди.
 *
 * Цикл тримає ритм без дрейфу: наступний тік планується на АБСОЛЮТНИЙ момент
 * `nextTick += 1000 / 30`, а затримка таймера = max(0, nextTick - now). Звичайний setInterval
 * накопичував би похибку (кожна ітерація запізнюється на кілька мс, і вони складаються).
 * Метрики: тривалість тіка (скільки коштує робота) і джиттер (відхилення реального інтервалу
 * між початками тіків від 33.33 мс) за ковзне вікно останніх ~10 с.
 */

import {
  ARENA_SIZE,
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
} from '@dogfight/shared';

/** Вікно метрик: 300 тіків = 10 с. */
const METRICS_WINDOW = 300;
/** Якщо цикл відстав більш ніж на стільки тіків, пропускаємо їх, а не женемося за часом. */
const MAX_CATCH_UP_TICKS = 5;
/** Скільки команд може лежати в черзі після взяття однієї; зайве відкидається (наздоганяння). */
const MAX_BACKLOG_AFTER_TAKE = 2;

/** Ковзне вікно значень для метрик. */
export class RollingStats {
  #values;
  #next = 0;
  #size = 0;

  constructor(capacity = METRICS_WINDOW) {
    this.#values = new Float64Array(capacity);
  }

  push(value) {
    this.#values[this.#next] = value;
    this.#next = (this.#next + 1) % this.#values.length;
    this.#size = Math.min(this.#size + 1, this.#values.length);
  }

  summary() {
    if (this.#size === 0) return { samples: 0, avg: 0, max: 0, p99: 0 };
    const sorted = Array.from(this.#values.subarray(0, this.#size)).sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const round = (value) => Math.round(value * 1000) / 1000;
    return {
      samples: this.#size,
      avg: round(sum / this.#size),
      max: round(sorted[this.#size - 1]),
      p99: round(sorted[Math.min(this.#size - 1, Math.floor(this.#size * 0.99))]),
    };
  }
}

/** Детермінований seed із рядка (id кімнати), якщо в кімнаті не задано arena.seed. */
function seedFromString(text) {
  let hash = 7;
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return hash >>> 1;
}

export class Match {
  #room;
  #logger;
  #now;
  #world;
  #clients = new Map();
  #events = [];
  #tick = 0;
  #timer = null;
  #nextTickAt = 0;
  #lastStartAt = null;
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

  /**
   * @param {object} options
   * @param {import('./rooms.js').Room} options.room
   * @param {object} options.logger
   * @param {() => number} [options.now] монотонний годинник, мс (тести підміняють)
   */
  constructor({ room, logger, now = () => performance.now() }) {
    this.#room = room;
    this.#logger = logger;
    this.#now = now;
    this.seed = Number.isFinite(room.arena?.seed) ? room.arena.seed : seedFromString(room.id);
    this.#world = new World({
      width: ARENA_SIZE.width,
      height: ARENA_SIZE.height,
      seed: this.seed,
      rules: room.arena,
    });
    this.#world.populate();
    this.#world.addEventListener('exploded', (event) => {
      if (this.#events.length >= 255) return;
      const { kind, size, x, y } = event.detail;
      this.#events.push({ type: 'explosion', kind, size, x, y });
    });
  }

  get roomId() {
    return this.#room.id;
  }

  get world() {
    return this.#world;
  }

  get tick() {
    return this.#tick;
  }

  get playerCount() {
    return this.#clients.size;
  }

  get running() {
    return this.#running;
  }

  has(playerId) {
    return this.#clients.has(playerId);
  }

  // --- Гравці ---

  /**
   * Додає гравця в матч: створює судно й повертає дані для повідомлення `start`.
   * @param {string} playerId
   * @param {{ nickname: string, send: (frame: ArrayBuffer | string) => void, codec?: 'binary' | 'json' }} client
   */
  addPlayer(playerId, { nickname, send, codec = 'binary' }) {
    if (this.#clients.has(playerId)) throw new Error(`гравець уже в матчі: ${playerId}`);
    const player = this.#world.addPlayer(playerId);
    this.#clients.set(playerId, {
      id: playerId,
      nickname,
      send,
      codec,
      queue: [],
      lastSeq: 0,
      lastProcessedSeq: 0,
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

  removePlayer(playerId) {
    if (!this.#clients.delete(playerId)) return false;
    this.#world.removePlayer(playerId);
    if (this.#clients.size === 0) this.stop();
    return true;
  }

  setCodec(playerId, codec) {
    const client = this.#clients.get(playerId);
    if (client) client.codec = codec;
  }

  // --- Ввід ---

  /**
   * Приймає пакет вводу (разом із надлишковою історією). Кожна команда проходить валідацію.
   * @returns {{ accepted: number, rejected: number, reason?: string }}
   */
  submitInput(playerId, message, { bytes = 0 } = {}) {
    const client = this.#clients.get(playerId);
    if (!client) return { accepted: 0, rejected: 0 };
    this.#counters.bytesIn += bytes;

    let accepted = 0;
    let rejected = 0;
    let reason;
    for (const command of expandInputMessage(message)) {
      const checked = validateInput(command);
      if (!checked.ok) {
        rejected += 1;
        reason = checked.reason;
        continue;
      }
      const { input } = checked;
      if (input.seq <= client.lastSeq) {
        client.stats.duplicate += 1; // надлишкова копія з історії або запізнілий пакет
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
        client.queue.shift(); // клієнт шле швидше за 30 Гц: зайві команди не дають переваги
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

  // --- Цикл ---

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#lastStartAt = null;
    this.#nextTickAt = this.#now() + TICK_MS;
    this.#scheduleNext();
    this.#logger.info('матч запущено', { room: this.#room.id, tickRate: TICK_RATE });
  }

  stop() {
    if (!this.#running) return;
    this.#running = false;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#logger.info('матч зупинено', { room: this.#room.id, ticks: this.#tick });
  }

  #scheduleNext() {
    const delay = Math.max(0, this.#nextTickAt - this.#now());
    this.#timer = setTimeout(this.#onTimer, delay);
    this.#timer.unref?.();
  }

  #onTimer = () => {
    if (!this.#running) return;
    const startedAt = this.#now();
    if (this.#lastStartAt !== null) {
      this.#jitterMs.push(Math.abs(startedAt - this.#lastStartAt - TICK_MS));
    }
    this.#lastStartAt = startedAt;

    try {
      this.stepTick();
    } catch (error) {
      this.#logger.error('помилка тіка матчу', { room: this.#room.id, error });
    }

    const finishedAt = this.#now();
    this.#durationMs.push(finishedAt - startedAt);

    this.#nextTickAt += TICK_MS; // абсолютний графік: без накопичення похибки
    const behind = finishedAt - this.#nextTickAt;
    if (behind > MAX_CATCH_UP_TICKS * TICK_MS) {
      // Процес довго "стояв" (пауза, блокування циклу): не ганяємо десятки тіків підряд.
      const skipped = Math.floor(behind / TICK_MS);
      this.#counters.skippedTicks += skipped;
      this.#counters.resyncs += 1;
      this.#nextTickAt = finishedAt + TICK_MS;
      this.#logger.warn('матч відстав: пропускаю тіки', { room: this.#room.id, skipped });
    }
    if (this.#running) this.#scheduleNext();
  };

  /** Один тік: ввід -> крок світу -> розсилка знімків. Відкритий для тестів. */
  stepTick() {
    for (const client of this.#clients.values()) {
      let command = client.queue.shift();
      while (client.queue.length > MAX_BACKLOG_AFTER_TAKE) {
        command = client.queue.shift(); // клієнт відстав у часі: наздоганяємо, відкидаючи старе
        client.stats.skipped += 1;
        this.#counters.inputsSkipped += 1;
      }
      if (command) {
        client.lastControls = command;
        client.lastProcessedSeq = command.seq;
      } else {
        client.stats.starved += 1; // команда не встигла: повторюємо попередній ввід
        this.#counters.starvedTicks += 1;
      }
      this.#world.setInput(client.id, client.lastControls);
    }

    this.#world.step(TICK_DT);
    this.#tick += 1;
    this.#counters.ticks += 1;
    this.#broadcast();
  }

  #broadcast() {
    const message = buildSnapshotMessage(this.#world, { tick: this.#tick, events: this.#events });
    this.#events = [];
    let binary = null; // кодуємо один раз для всіх бінарних клієнтів

    for (const client of this.#clients.values()) {
      let frame;
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
      } catch (error) {
        this.#logger.warn('помилка відправки знімка', { client: client.id, error });
      }
    }
  }

  // --- Метрики ---

  stats() {
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

/** Реєстр матчів: по одному на кімнату, створюється за першим гравцем, видаляється з порожнечею. */
export class MatchManager {
  #matches = new Map();
  #logger;
  #now;

  constructor({ logger, now }) {
    this.#logger = logger;
    this.#now = now;
  }

  get size() {
    return this.#matches.size;
  }

  get(roomId) {
    return this.#matches.get(roomId);
  }

  getOrCreate(room) {
    let match = this.#matches.get(room.id);
    if (!match) {
      match = new Match({ room, logger: this.#logger, now: this.#now });
      this.#matches.set(room.id, match);
    }
    return match;
  }

  /** Зупиняє й забуває матч (кімнату видалено або в ній нікого немає). */
  remove(roomId) {
    const match = this.#matches.get(roomId);
    if (!match) return false;
    match.stop();
    return this.#matches.delete(roomId);
  }

  /** Зведена статистика: окремо кожен матч і агрегат для /health. */
  stats() {
    const matches = [...this.#matches.values()].map((match) => match.stats());
    const active = matches.filter((m) => m.running);
    const worst = (key, field) => active.reduce((max, m) => Math.max(max, m[key][field]), 0);
    const mean = (key, field) =>
      active.length ? active.reduce((sum, m) => sum + m[key][field], 0) / active.length : 0;
    const round = (value) => Math.round(value * 1000) / 1000;
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

  close() {
    for (const match of this.#matches.values()) match.stop();
    this.#matches.clear();
  }
}
