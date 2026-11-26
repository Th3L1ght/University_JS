import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { binaryCodec, Kind, MsgType, TICK_DT } from '@dogfight/shared';
import { NetClient } from '../src/net/net_client.js';

function createFakeConnection() {
  const bus = new EventTarget();
  const sentJson = [];
  const sentBinary = [];
  return Object.assign(bus, {
    state: 'open',
    bytesIn: 0,
    bytesOut: 0,
    sentJson,
    sentBinary,
    send(type, payload = {}) {
      sentJson.push({ type, ...payload });
      this.bytesOut += JSON.stringify({ v: 1, type, ...payload }).length;
      return 'sent';
    },
    sendBinary(buffer) {
      sentBinary.push(buffer);
      this.bytesOut += buffer.byteLength;
      return 'sent';
    },
    emit(type, detail) {
      bus.dispatchEvent(new CustomEvent(type, { detail }));
    },
  });
}

describe('NetClient: prediction, reconciliation, interpolation', () => {
  test('миттєво прогнозує рух і постріл, відкидає підтверджені інпути й згладжує коррекцію', () => {
    let clock = 1000;
    const conn = createFakeConnection();
    const net = new NetClient({ connection: conn, now: () => clock });
    net.start();

    assert.equal(conn.sentJson[0].type, 'ready');
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

    // 3 кроки з тягою й пострілом -> 3 неподтверджених інпути + локальна куля.
    for (let i = 0; i < 3; i += 1) {
      clock += 33.33;
      net.stepInput({ thrust: true, turn: 0, fire: i === 0, missile: false });
    }
    assert.equal(net.pendingCount, 3);
    // 1 ping + 3 input бінарних кадри.
    const inputs = conn.sentBinary
      .map((b) => binaryCodec.decode(b))
      .filter((m) => m.type === MsgType.INPUT);
    assert.equal(inputs.length, 3);
    assert.equal(inputs[2].seq, 3);

    const beforeSnap = net.buildRenderWorld(1, 0, clock);
    assert.ok(beforeSnap.ofKind(Kind.BULLET).length >= 1, 'локальна куля передбачена миттєво');

    // Сервер підтверджує seq = 2, але зміщує позицію на +20 px (імітація зіткнення/розбіжності).
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

    // Згладжування за ~100 мс наближає візуальну позицію до авторитативної.
    const worldA = net.buildRenderWorld(1, 0, clock);
    const worldB = net.buildRenderWorld(1, 0.12, clock + 120);
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

    const makeRemote = (x) => ({
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

    // Знімок 1 о t = 2000 (x = 100), знімок 2 о t = 2100 (x = 200).
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

    // О t = 2150 з interpolationDelay = 100 -> renderTime = 2050 -> рівно посередині (x = 150).
    clock = 2150;
    const world = net.buildRenderWorld(0, TICK_DT, clock);
    const remote = world.ofKind(Kind.SHIP).find((s) => s.id === 2);
    assert.ok(remote);
    assert.ok(Math.abs(remote.pos.x - 150) < 0.01, `expected ~150, got ${remote.pos.x}`);

    net.destroy();
  });
});
