import { afterEach, describe, expect, it, vi } from 'vitest';
import { binaryCodec, Kind, MsgType, TICK_DT } from '@dogfight/shared';
import { createLoop } from '../src/loop.ts';
import { NetClient, type NetConnectionLike } from '../src/net/net_client.ts';
import { createParticleSystem } from '../src/render/particle_bridge.ts';
import { backoffDelay } from '../src/util/backoff.ts';
import { Bus, type GameEvents } from '../src/util/bus.ts';

function createFakeConnection() {
  const bus = new EventTarget();
  const sentJson: Array<Record<string, unknown>> = [];
  const sentBinary: ArrayBuffer[] = [];
  let bytesOut = 0;
  const conn: NetConnectionLike & {
    sentJson: Array<Record<string, unknown>>;
    sentBinary: ArrayBuffer[];
    emit(type: string, detail: unknown): void;
  } = {
    state: 'open',
    bytesIn: 0,
    get bytesOut() {
      return bytesOut;
    },
    sentJson,
    sentBinary,
    send(type, payload = {}) {
      sentJson.push({ type, ...payload });
      bytesOut += JSON.stringify({ v: 1, type, ...payload }).length;
      return 'sent';
    },
    sendBinary(buffer) {
      if (buffer instanceof ArrayBuffer) sentBinary.push(buffer);
      bytesOut += buffer.byteLength;
      return 'sent';
    },
    addEventListener(type, listener) {
      bus.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      bus.removeEventListener(type, listener);
    },
    emit(type, detail) {
      bus.dispatchEvent(new CustomEvent(type, { detail }));
    },
  };
  return conn;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createLoop: фіксований крок і акумулятор на фейкових таймерах', () => {
  it('виконує рівно N кроків за N*step і клампить спіраль смерті (MAX_FRAME_DT)', () => {
    vi.useFakeTimers();
    let rafCb: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      rafCb = null;
    });

    let steps = 0;
    let lastAlpha = 0;
    let lastP99 = 0;
    const loop = createLoop({
      step: 1 / 60,
      simulate: () => {
        steps += 1;
      },
      render: (alpha, m) => {
        lastAlpha = alpha;
        lastP99 = m.frameP99Ms;
      },
    });

    loop.start();
    const fire = (t: number) => {
      const cb = rafCb;
      rafCb = null;
      cb?.(t);
    };

    fire(0); // перший кадр: 0 кроків
    expect(steps).toBe(0);

    fire(50); // 50 мс = 3 кроки по 16.67 мс
    expect(steps).toBe(3);
    expect(lastAlpha).toBeGreaterThanOrEqual(0);
    expect(lastAlpha).toBeLessThan(1);

    // Спіраль смерті: 5 секунд простою клампиться до 0.25 с = 15 кроків, а не 300.
    const beforeStall = steps;
    fire(5050);
    expect(steps - beforeStall).toBe(15);
    expect(lastP99).toBeGreaterThanOrEqual(0);

    loop.stop();
  });
});

describe('NetClient: prediction, reconciliation, smoothing та interpolation', () => {
  it('відкидає підтверджені інпути, програє залишок і згладжує похибку за ~100 мс', () => {
    let clock = 1000;
    const conn = createFakeConnection();
    const net = new NetClient({ connection: conn, now: () => clock });
    net.start();
    conn.emit('start', {
      shipId: 10,
      tickRate: 30,
      tick: 0,
      arena: { width: 1280, height: 720 },
      seed: 1,
      codec: 'binary',
    });

    for (let i = 0; i < 4; i += 1) {
      clock += 33.33;
      net.stepInput({ thrust: true, turn: 0, fire: i === 0, missile: false });
    }
    expect(net.pendingCount).toBe(4);
    const sentInputs = conn.sentBinary
      .map((b) => binaryCodec.decode(b))
      .filter((m) => m.type === MsgType.INPUT);
    expect(sentInputs.length).toBe(4);

    conn.emit('snapshot', {
      type: 'snapshot',
      tick: 3,
      lastProcessedSeq: 3,
      ships: [
        {
          id: 10,
          x: 680,
          y: 360,
          vx: 0,
          vy: -30,
          angle: -Math.PI / 2,
          hp: 100,
          alive: true,
          thrust: true,
          rapid: false,
          invulnerable: 0,
          fireCooldown: 0.1,
          rapidLeft: 0,
          respawnIn: 0,
          score: 120,
        },
      ],
      asteroids: [],
      bullets: [],
      pickups: [],
      events: [],
    });

    expect(net.pendingCount).toBe(1);
    expect(net.getMetrics(clock).correctionMag).toBeGreaterThan(10);

    const w0 = net.buildRenderWorld(1, 0, clock);
    const w1 = net.buildRenderWorld(1, 0.1, clock + 100);
    expect(w0.player?.pos.x).not.toBe(w1.player?.pos.x);
    expect(w1.score).toBe(120);
    net.destroy();
  });

  it('інтерполює віддалені кораблі в минулому (now - interpolationDelayMs)', () => {
    let clock = 2000;
    const conn = createFakeConnection();
    const net = new NetClient({ connection: conn, interpolationDelayMs: 100, now: () => clock });
    net.start();
    conn.emit('start', { shipId: 1, tickRate: 30, tick: 0, arena: { width: 1280, height: 720 } });

    const remoteShip = (x: number) => ({
      id: 2,
      x,
      y: 300,
      vx: 100,
      vy: 0,
      angle: 0,
      hp: 100,
      alive: true,
      thrust: false,
      rapid: false,
      invulnerable: 0,
      fireCooldown: 0,
      rapidLeft: 0,
      respawnIn: 0,
      score: 0,
    });

    conn.emit('snapshot', {
      type: 'snapshot',
      tick: 1,
      lastProcessedSeq: 0,
      ships: [remoteShip(100)],
      asteroids: [],
      bullets: [],
      pickups: [],
      events: [],
    });
    clock = 2100;
    conn.emit('snapshot', {
      type: 'snapshot',
      tick: 4,
      lastProcessedSeq: 0,
      ships: [remoteShip(200)],
      asteroids: [],
      bullets: [],
      pickups: [],
      events: [],
    });

    clock = 2150;
    const world = net.buildRenderWorld(0, TICK_DT, clock);
    const found = [...world.ofKind(Kind.SHIP)].find((s) => s.id === 2);
    expect(found?.pos.x).toBeCloseTo(150, 1);
    net.destroy();
  });
});

describe('Bus<GameEvents>, ParticleSystem fallback і backoffDelay', () => {
  it('Bus підписує, доставляє й відписує події', () => {
    const bus = new Bus<GameEvents>();
    const log: number[] = [];
    const off = bus.on('scoreChanged', ({ score }) => log.push(score));
    bus.emit('scoreChanged', { score: 10, delta: 10 });
    off();
    bus.emit('scoreChanged', { score: 20, delta: 10 });
    expect(log).toEqual([10]);
  });

  it('createParticleSystem використовує main-thread fallback без Worker', () => {
    const ps = createParticleSystem();
    expect(ps.mode).toBe('main');
    ps.spawn({ x: 100, y: 100, count: 10, speed: 50, life: 0.5, tint: 'rock' });
    ps.step(0.016);
    ps.destroy();
  });

  it('backoffDelay повертає затримку в межах [ceiling/2, ceiling]', () => {
    expect(backoffDelay(1, { baseMs: 100, maxMs: 1000 }, () => 0)).toBe(50);
    expect(backoffDelay(1, { baseMs: 100, maxMs: 1000 }, () => 1)).toBe(100);
    expect(backoffDelay(5, { baseMs: 100, maxMs: 500 }, () => 1)).toBe(500);
  });

  it('NetClient: перемикання codec, оновлення netsim і вимірювання RTT через pong', () => {
    let clock = 500;
    const conn = createFakeConnection();
    const net = new NetClient({ connection: conn, now: () => clock });
    net.start();
    conn.emit('start', { shipId: 1, tickRate: 30, tick: 5, arena: { width: 1280, height: 720 } });

    net.setCodec('json');
    expect(net.codec).toBe('json');
    net.setNetsim({ latency: 60, jitter: 10, drop: 0.02 });
    expect(net.netsim.latency).toBe(60);

    clock = 540;
    conn.emit('pong', { clientTime: 500, serverTick: 6 });
    expect(net.getMetrics(clock).rttMs).toBeCloseTo(40);
    net.destroy();
  });

  it('NetClient: великий стрибок (>160 px, респаун) робить миттєвий snap без згладжування', () => {
    const clock = 1000;
    const conn = createFakeConnection();
    const net = new NetClient({ connection: conn, now: () => clock });
    net.start();
    conn.emit('start', { shipId: 1, tickRate: 30, tick: 0, arena: { width: 1280, height: 720 } });
    net.stepInput({ thrust: false, turn: 0, fire: false });

    conn.emit('snapshot', {
      type: 'snapshot',
      tick: 1,
      lastProcessedSeq: 1,
      ships: [
        {
          id: 1,
          x: 100,
          y: 100,
          vx: 0,
          vy: 0,
          angle: 0,
          hp: 100,
          alive: true,
          thrust: false,
          rapid: false,
          invulnerable: 2,
          fireCooldown: 0,
          rapidLeft: 0,
          respawnIn: 0,
          score: 0,
        },
      ],
      asteroids: [],
      bullets: [],
      pickups: [],
      events: [],
    });

    const w = net.buildRenderWorld(1, 0, clock);
    expect(w.player?.pos.x).toBeCloseTo(100);
    expect(w.player?.pos.y).toBeCloseTo(100);
    net.destroy();
  });

  it('Bus.clear очищує всіх слухачів', () => {
    const bus = new Bus<GameEvents>();
    let called = 0;
    bus.on('pickup', () => {
      called += 1;
    });
    bus.clear();
    bus.emit('pickup', { effect: { type: 'heal' } });
    expect(called).toBe(0);
  });
});
