import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { binaryCodec, CloseCode, MsgType, TICK_MS } from '@dogfight/shared';
import { BotManager } from '../src/bot.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createApp } from '../src/index.ts';
import { createLogger } from '../src/logger.ts';
import { Match, MatchManager, RollingStats } from '../src/match.ts';
import { NetSim, parseNetsimParams } from '../src/netsim.ts';
import { TokenBucket } from '../src/rate_limit.ts';
import { Room, RoomError, RoomManager } from '../src/rooms.ts';

const silent = createLogger({ level: 'silent' });

afterEach(() => {
  vi.useRealTimers();
});

describe('TokenBucket rate limiter', () => {
  it('дозволяє burst до capacity, потім відмовляє і поповнюється з часом', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 2, now: () => now });
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    now = 500; // +1 жетон
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    now = 5000; // стеля = capacity (3)
    expect(bucket.take(3)).toBe(true);
    expect(bucket.tokens).toBeCloseTo(0);
  });

  it('підтримує cost > 1', () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSec: 1, now: () => 0 });
    expect(bucket.take(4)).toBe(true);
    expect(bucket.take(2)).toBe(false);
    expect(bucket.take(1)).toBe(true);
  });
});

describe('Fake timers: Match 30 Гц, NetSim, RoomManager TTL і heartbeat', () => {
  it('Match виконує ~30 тіків за 1 секунду через setTimeout без дрейфу', () => {
    vi.useFakeTimers();
    const room = new Room({ id: 'fake-1', name: 'Fake 1' });
    const match = new Match({ room, logger: silent, now: () => Date.now() });
    const frames: Array<ArrayBuffer | string> = [];
    match.addPlayer('p1', { nickname: 'Ace', send: (f) => frames.push(f) });

    vi.advanceTimersByTime(1000);
    expect(match.tick).toBeGreaterThanOrEqual(29);
    expect(match.tick).toBeLessThanOrEqual(31);
    expect(frames.length).toBe(match.tick);

    const last = frames.at(-1);
    expect(last instanceof ArrayBuffer).toBe(true);
    if (last instanceof ArrayBuffer) {
      const dec = binaryCodec.decode(last);
      expect(dec.type).toBe(MsgType.SNAPSHOT);
    }
    match.stop();
  });

  it('NetSim доставляє пакети із затримкою на фейкових таймерах і губить при drop', () => {
    vi.useFakeTimers();
    const sim = new NetSim({ latency: 100, jitter: 0, drop: 0 }, { now: () => Date.now() });
    let delivered = 0;
    sim.schedule('out', () => {
      delivered += 1;
    });
    vi.advanceTimersByTime(99);
    expect(delivered).toBe(0);
    vi.advanceTimersByTime(2);
    expect(delivered).toBe(1);
    sim.dispose();

    const lossy = new NetSim({ drop: 0.5 }, { random: () => 0.1 });
    expect(lossy.schedule('in', () => {})).toBe('dropped');
    lossy.dispose();
  });

  it('RoomManager автоматично видаляє порожню кімнату за TTL на фейкових таймерах', () => {
    vi.useFakeTimers();
    const mgr = new RoomManager({ maxRooms: 5, maxPlayersPerRoom: 8, emptyRoomTtlMs: 500 });
    const room = mgr.create({ name: 'Ghost Room' });
    expect(mgr.has(room.id)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(mgr.has(room.id)).toBe(false);
    mgr.destroy();
  });

  it('симуляція heartbeat на фейкових таймерах: 2 пропущені pong -> terminate', () => {
    vi.useFakeTimers();
    let terminated = false;
    let awaitingPong = false;
    let missed = 0;
    const timer = setInterval(() => {
      if (awaitingPong) {
        missed += 1;
        if (missed >= 2) {
          terminated = true;
          clearInterval(timer);
          return;
        }
      }
      awaitingPong = true;
    }, 15_000);

    vi.advanceTimersByTime(15_000);
    expect(terminated).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(terminated).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(terminated).toBe(true);
  });
});

describe('BotManager: серверні ШІ-боти через стандартний submitInput', () => {
  it('додає ботів у матч і подає валідні команди вводу на кожному тіку', () => {
    const room = new Room({ id: 'bot-room', name: 'Bot Room' });
    const mgr = new MatchManager({ logger: silent });
    const added = mgr.addBots(room, 3);
    expect(added.length).toBe(3);

    const match = mgr.get(room.id);
    expect(match).toBeDefined();
    if (!match) return;
    match.stop();

    for (let i = 0; i < 30; i += 1) match.stepTick();
    const stats = match.stats();
    expect(stats.players).toBe(3);
    expect(stats.counters.inputsReceived).toBeGreaterThanOrEqual(30);
    expect(stats.counters.inputsRejected).toBe(0);
    mgr.close();
  });

  it('BotManager.count відстежує кількість і очищує при removeRoom', () => {
    const bots = new BotManager();
    const room = new Room({ id: 'r1', name: 'R1' });
    const match = new Match({ room, logger: silent });
    match.stop();
    bots.addBots(match, 2);
    expect(bots.count('r1')).toBe(2);
    bots.removeRoom('r1');
    expect(bots.count('r1')).toBe(0);
  });
});

describe('Config, Rooms, RollingStats, parseNetsimParams', () => {
  it('loadConfig застосовує дефолти та збирає всі помилки в ConfigError', () => {
    const cfg = loadConfig({}, process.cwd());
    expect(cfg.port).toBe(3000);
    expect(cfg.ws.netsimEnabled).toBe(true);
    expect(() => loadConfig({ PORT: 'abc', MAX_ROOMS: '-5', NODE_ENV: 'bad' })).toThrow(
      ConfigError,
    );
  });

  it('Room перевіряє дублікат нікнейму і переповнення', () => {
    const room = new Room({ id: 'r2', name: 'R2', maxPlayers: 2 });
    room.join({ id: '1', nickname: 'Ace' });
    expect(() => room.join({ id: '2', nickname: 'ace' })).toThrow(RoomError);
    room.join({ id: '2', nickname: 'Bravo' });
    expect(() => room.join({ id: '3', nickname: 'Charlie' })).toThrow(RoomError);
  });

  it('RollingStats обчислює avg, p99, max', () => {
    const rs = new RollingStats(5);
    expect(rs.summary().samples).toBe(0);
    for (const v of [1, 2, 3, 4, 5]) rs.push(v);
    expect(rs.summary()).toEqual({ samples: 5, avg: 3, max: 5, p99: 5 });
  });

  it('parseNetsimParams валідує діапазони і відхиляє вихід за межі', () => {
    expect(parseNetsimParams({ latency: 80, jitter: 20, drop: 0.05 }).ok).toBe(true);
    expect(parseNetsimParams({ latency: -1 }).ok).toBe(false);
    expect(parseNetsimParams({ drop: 0.9 }).ok).toBe(false);
    expect(TICK_MS).toBeCloseTo(33.333, 2);
  });

  it('Room емітить chat, leave і empty події з типізованими аргументами', () => {
    const room = new Room({ id: 'ev-1', name: 'Events' });
    const log: string[] = [];
    room.on('join', (p) => log.push(`join:${p.nickname}`));
    room.on('chat', (m) => log.push(`chat:${m.text}`));
    room.on('leave', (p) => log.push(`leave:${p.id}`));
    room.on('empty', (r) => log.push(`empty:${r.id}`));

    room.join({ id: 'p1', nickname: 'Ace' });
    room.chat('p1', 'Hello');
    room.leave('p1');
    expect(log).toEqual(['join:Ace', 'chat:Hello', 'leave:p1', 'empty:ev-1']);
  });

  it('RoomManager дотримується ліміту maxRooms', () => {
    const mgr = new RoomManager({ maxRooms: 1, maxPlayersPerRoom: 4, emptyRoomTtlMs: 60_000 });
    mgr.create({ name: 'One' });
    expect(() => mgr.create({ name: 'Two' })).toThrow(RoomError);
    mgr.destroy();
  });

  it('Match: відхиляє читерський ввід, ігнорує дублікати seq і кодує JSON-режим', () => {
    const room = new Room({ id: 'm1', name: 'M1' });
    const match = new Match({ room, logger: silent });
    const received: Array<ArrayBuffer | string> = [];
    match.addPlayer('p1', { nickname: 'Ace', codec: 'json', send: (f) => received.push(f) });
    match.stop();

    expect(
      match.submitInput('p1', { seq: 1, tick: 0, thrust: true, turn: 5, fire: false }).rejected,
    ).toBe(1);
    expect(
      match.submitInput('p1', { seq: 1, tick: 0, thrust: true, turn: 0, fire: false }).accepted,
    ).toBe(1);
    expect(
      match.submitInput('p1', { seq: 1, tick: 0, thrust: true, turn: 0, fire: false }).accepted,
    ).toBe(0);
    match.stepTick();
    expect(typeof received.at(-1)).toBe('string');
  });

  it('NetSim: update та lossy: false не губить керувальні пакети', () => {
    vi.useFakeTimers();
    const sim = new NetSim({ latency: 0, jitter: 0, drop: 0 });
    expect(sim.active).toBe(false);
    sim.update({ latency: 20, drop: 0.5 });
    expect(sim.toJSON()).toEqual({ latency: 20, jitter: 0, drop: 0.5 });
    let called = 0;
    sim.schedule(
      'out',
      () => {
        called += 1;
      },
      { lossy: false },
    );
    vi.advanceTimersByTime(30);
    expect(called).toBe(1);
    sim.dispose();
  });
});

describe('Production observability & hardening (Lab 8)', () => {
  it('/health, /ready та /metrics повертають коректні статуси, версію і Prometheus-метрики', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dogfight-obs-'));
    const app = createApp(
      loadConfig({
        PORT: '0',
        HOST: '127.0.0.1',
        NODE_ENV: 'development',
        LOG_DIR: tmpDir,
        LOG_LEVEL: 'silent',
        APP_VERSION: '1.0.0-test',
        ALLOWED_ORIGINS: 'https://dogfight.example',
        MAX_CONNECTIONS_PER_IP: '2',
      }),
      { logger: silent },
    );

    try {
      const address = await app.start();
      const port = typeof address === 'object' && address ? address.port : 0;
      const base = `http://127.0.0.1:${port}`;
      const wsUrl = `ws://127.0.0.1:${port}/ws`;

      const healthRes = await fetch(`${base}/health`);
      expect(healthRes.status).toBe(200);
      const health: unknown = await healthRes.json();
      expect(health).toMatchObject({ status: 'ok', version: '1.0.0-test' });

      const readyRes = await fetch(`${base}/ready`);
      expect(readyRes.status).toBe(200);
      const ready: unknown = await readyRes.json();
      expect(ready).toMatchObject({ status: 'ready', version: '1.0.0-test' });

      // Заборонений Origin -> 4008
      const badOriginCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: { origin: 'https://evil.example' } });
        ws.once('close', (code) => resolve(code));
        ws.once('error', reject);
      });
      expect(badOriginCode).toBe(CloseCode.FORBIDDEN_ORIGIN);

      // Перевірка ліміту MAX_CONNECTIONS_PER_IP = 2 (третє з'єднання отримує 1013)
      const openWs = () =>
        new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(wsUrl, { headers: { origin: 'https://dogfight.example' } });
          ws.once('open', () => resolve(ws));
          ws.once('error', reject);
        });
      const c1 = await openWs();
      const c2 = await openWs();
      const thirdCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: { origin: 'https://dogfight.example' } });
        ws.once('close', (code) => resolve(code));
        ws.once('error', reject);
      });
      expect(thirdCode).toBe(CloseCode.TRY_AGAIN_LATER);

      // Prometheus /metrics містить ключові метрики та лічильники відхилень
      const metricsRes = await fetch(`${base}/metrics`);
      expect(metricsRes.status).toBe(200);
      const body = await metricsRes.text();
      expect(body).toContain('dogfight_players_connected 2');
      expect(body).toContain('dogfight_rooms_active 0');
      expect(body).toContain('dogfight_event_loop_utilization');
      expect(body).toContain('dogfight_process_rss_bytes');
      expect(body).toContain('dogfight_ws_rejected_total{reason="origin"} 1');
      expect(body).toContain('dogfight_ws_rejected_total{reason="ip_limit"} 1');

      c1.close();
      c2.close();
    } finally {
      await app.shutdown('test');
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
