import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { binaryCodec, Kind, MsgType, TICK_DT } from '@dogfight/shared';
import { NetClient, type NetConnectionLike } from '../src/net/net_client.ts';
import { Bus, type GameEvents } from '../src/util/bus.ts';

interface FakeConnection extends NetConnectionLike {
  sentJson: Array<Record<string, unknown>>;
  sentBinary: ArrayBuffer[];
  emit(type: string, detail: unknown): void;
}

function createFakeConnection(): FakeConnection {
  const bus = new EventTarget();
  const sentJson: Array<Record<string, unknown>> = [];
  const sentBinary: ArrayBuffer[] = [];
  let bytesOut = 0;
  return {
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
}

describe('Bus<GameEvents>: типізована шина подій', () => {
  test('доставляє типізовані події й відписує через повернену функцію', () => {
    const bus = new Bus<GameEvents>();
    const fired: boolean[] = [];
    const unsub = bus.on('fired', ({ missile }) => fired.push(missile));
    bus.emit('fired', { missile: false });
    bus.emit('fired', { missile: true });
    unsub();
    bus.emit('fired', { missile: false });
    assert.deepEqual(fired, [false, true]);
  });
});

describe('NetClient: prediction, reconciliation, interpolation', () => {
  test('миттєво прогнозує рух і постріл, відкидає підтверджені інпути й згладжує коррекцію', () => {
    let clock = 1000;
    const conn = createFakeConnection();
    const net = new NetClient({ connection: conn, now: () => clock });
    net.start();

    assert.equal(conn.sentJson[0]?.type, 'ready');
    conn.emit('start', {
      shipId: 10,
      tickRate: 30,
      tick: 0,
      arena: { width: 1280, height: 720 },
      seed: 1,
      codec: 'binary',
      netsimEnabled: true,
      netsim: { latency: 0, jitter: 0, drop: 0 },
    });

    for (let i = 0; i < 3; i += 1) {
      clock += 33.33;
      net.stepInput({ thrust: true, turn: 0, fire: i === 0, missile: false });
    }
    assert.equal(net.pendingCount, 3);
    const inputs = conn.sentBinary
      .map((b) => binaryCodec.decode(b))
      .filter((m) => m.type === MsgType.INPUT);
    assert.equal(inputs.length, 3);
    assert.equal(inputs[2]?.seq, 3);

    const beforeSnap = net.buildRenderWorld(1, 0, clock);
    assert.ok([...beforeSnap.ofKind(Kind.BULLET)].length >= 1, 'локальна куля передбачена миттєво');

    clock += 33.33;
    conn.emit('snapshot', {
      type: 'snapshot',
      tick: 2,
      lastProcessedSeq: 2,
      ships: [
        {
          id: 10,
          x: 660,
          y: 360,
          vx: 0,
          vy: -20,
          angle: -Math.PI / 2,
          hp: 100,
          alive: true,
          thrust: true,
          rapid: false,
          invulnerable: 0,
          fireCooldown: 0.1,
          rapidLeft: 0,
          respawnIn: 0,
          score: 50,
        },
      ],
      asteroids: [],
      bullets: [],
      pickups: [],
      events: [],
    });

    assert.equal(net.pendingCount, 1, 'залишився лише неподтверджений seq=3');
    const metrics = net.getMetrics(clock);
    assert.ok(metrics.correctionMag > 5, 'похибка коррекції зафіксована');

    const worldA = net.buildRenderWorld(1, 0, clock);
    const worldB = net.buildRenderWorld(1, 0.12, clock + 120);
    assert.ok(worldA.player && worldB.player);
    assert.notEqual(worldA.player.pos.x, worldB.player.pos.x);
    assert.equal(worldB.score, 50);

    net.destroy();
  });

  test('інтерполює чуже судно між двома сусідніми знімками в минулому (now - interpolationDelay)', () => {
    let clock = 2000;
    const conn = createFakeConnection();
    const net = new NetClient({ connection: conn, interpolationDelayMs: 100, now: () => clock });
    net.start();
    conn.emit('start', {
      shipId: 1,
      tickRate: 30,
      tick: 0,
      arena: { width: 1280, height: 720 },
      seed: 1,
      codec: 'binary',
    });

    const makeRemote = (x: number) => ({
      id: 2,
      x,
      y: 200,
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
      ships: [makeRemote(100)],
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
      ships: [makeRemote(200)],
      asteroids: [],
      bullets: [],
      pickups: [],
      events: [],
    });

    clock = 2150;
    const world = net.buildRenderWorld(0, TICK_DT, clock);
    const remote = [...world.ofKind(Kind.SHIP)].find((s) => s.id === 2);
    if (!remote) assert.fail('віддалене судно не знайдено');
    assert.ok(Math.abs(remote.pos.x - 150) < 0.01, `expected ~150, got ${remote.pos.x}`);

    net.destroy();
  });
});
