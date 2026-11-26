import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { asSeq, asTick, binaryCodec, MsgType, TICK_RATE } from '@dogfight/shared';
import { Match, RollingStats } from '../src/match.ts';
import { NetSim, parseNetsimParams } from '../src/netsim.ts';
import { Room } from '../src/rooms.ts';
import { createLogger } from '../src/logger.ts';
import { join, makeRoom, openClient, sleep, startTestApp, type TestEnv } from './helpers.ts';

describe('Match: авторитативна симуляція і черги вводу', () => {
  const silent = createLogger({ level: 'silent' });

  test('обробляє по одній команді за тік і повертає індивідуальний lastProcessedSeq', () => {
    const room = new Room({ id: 'arena-1', name: 'Arena 1' });
    const match = new Match({ room, logger: silent });
    const framesA: Array<ArrayBuffer | string> = [];
    const framesB: Array<ArrayBuffer | string> = [];

    const infoA = match.addPlayer('a', { nickname: 'Alpha', send: (f) => framesA.push(f) });
    const infoB = match.addPlayer('b', { nickname: 'Bravo', send: (f) => framesB.push(f) });
    match.stop();

    assert.equal(infoA.tickRate, TICK_RATE);
    assert.notEqual(infoA.shipId, infoB.shipId);

    match.submitInput('a', {
      seq: 1,
      tick: 0,
      thrust: true,
      turn: 0,
      fire: false,
      missile: false,
      prev: [],
    });
    match.submitInput('b', {
      seq: 5,
      tick: 0,
      thrust: false,
      turn: 1,
      fire: true,
      missile: false,
      prev: [],
    });
    match.stepTick();

    const rawA = framesA.at(-1);
    const rawB = framesB.at(-1);
    if (!(rawA instanceof ArrayBuffer) || !(rawB instanceof ArrayBuffer)) {
      assert.fail('очікуються бінарні кадри');
    }
    const snapA = binaryCodec.decode(rawA);
    const snapB = binaryCodec.decode(rawB);
    if (snapA.type !== MsgType.SNAPSHOT || snapB.type !== MsgType.SNAPSHOT) {
      assert.fail('очікуються SNAPSHOT');
    }
    assert.equal(snapA.tick, 1);
    assert.equal(snapA.lastProcessedSeq, 1);
    assert.equal(snapB.lastProcessedSeq, 5);
    assert.equal(snapA.ships.length, 2);
  });

  test('відхиляє читерські значення вводу й рахує статистику', () => {
    const room = new Room({ id: 'arena-2', name: 'Arena 2' });
    const match = new Match({ room, logger: silent });
    match.addPlayer('a', { nickname: 'Alpha', send: () => {} });
    match.stop();

    const badTurn = match.submitInput('a', {
      seq: 1,
      tick: 0,
      thrust: true,
      turn: 9.9,
      fire: false,
      prev: [],
    });
    assert.equal(badTurn.accepted, 0);
    assert.equal(badTurn.rejected, 1);

    const futureTick = match.submitInput('a', {
      seq: 2,
      tick: 99999,
      thrust: false,
      turn: 0,
      fire: false,
      prev: [],
    });
    assert.equal(futureTick.rejected, 1);
    assert.equal(futureTick.reason, 'tick_in_future');
  });

  test('RollingStats обчислює avg, max, p99', () => {
    const stats = new RollingStats(10);
    for (let i = 1; i <= 10; i += 1) stats.push(i);
    const summary = stats.summary();
    assert.equal(summary.samples, 10);
    assert.equal(summary.avg, 5.5);
    assert.equal(summary.max, 10);
    assert.equal(summary.p99, 10);
  });
});

describe('NetSim: затримка, джиттер і втрата пакетів', () => {
  test('parseNetsimParams перевіряє діапазони', () => {
    assert.deepEqual(parseNetsimParams({ latency: '100', jitter: '30', drop: '0.05' }), {
      ok: true,
      data: { latency: 100, jitter: 30, drop: 0.05 },
    });
    assert.equal(parseNetsimParams({ latency: 5000 }).ok, false);
    assert.equal(parseNetsimParams({ drop: 0.9 }).ok, false);
  });

  test('drop видаляє lossy-пакети, але не lossy: false', () => {
    const sim = new NetSim({ drop: 0.5 }, { random: () => 0.1 });
    let delivered = 0;
    assert.equal(
      sim.schedule('out', () => {
        delivered += 1;
      }),
      'dropped',
    );
    assert.equal(delivered, 0);
    assert.equal(
      sim.schedule(
        'out',
        () => {
          delivered += 1;
        },
        { lossy: false },
      ),
      'delayed',
    );
    sim.dispose();
  });
});

describe('Інтеграція WS + Match + /api/stats + NetSim', () => {
  let env: TestEnv;
  before(async () => {
    env = await startTestApp();
  });
  after(() => env.stop());

  test('ready -> start -> бінарні INPUT/SNAPSHOT/PING/PONG, перемикання codec, /api/stats і /health', async () => {
    const room = makeRoom(env.app, { name: 'Dogfight Live' });
    const client = await openClient(`${env.wsUrl}?latency=10&jitter=0&drop=0`);

    join(client, room.id, 'Maverick');
    await client.next('welcome');

    client.send({ v: 1, type: 'ready', codec: 'binary' });
    const start = await client.next('start');
    assert.equal(start.tickRate, TICK_RATE);
    assert.equal(start.codec, 'binary');
    const startTick = typeof start.tick === 'number' ? start.tick : 0;

    client.raw(
      binaryCodec.encode({
        type: MsgType.INPUT,
        seq: asSeq(42),
        tick: asTick(startTick),
        thrust: true,
        turn: 0,
        fire: true,
        missile: false,
        prev: [],
      }),
      { binary: true },
    );

    const snap = await client.next((m) => m.type === 'snapshot' && m.lastProcessedSeq === 42);
    assert.equal(snap.lastProcessedSeq, 42);

    client.raw(binaryCodec.encode({ type: MsgType.PING, clientTime: 123.5 }), { binary: true });
    const pong = await client.next('pong');
    assert.equal(pong.clientTime, 123.5);
    assert.ok(typeof pong.serverTick === 'number' && pong.serverTick >= 0);

    client.send({ v: 1, type: 'netsim', latency: 25, jitter: 5, drop: 0.01 });
    const ns = await client.next('netsim');
    assert.deepEqual(
      { latency: ns.latency, jitter: ns.jitter, drop: ns.drop },
      { latency: 25, jitter: 5, drop: 0.01 },
    );

    const statsRes = await fetch(`${env.url}/api/stats`);
    assert.equal(statsRes.status, 200);
    const stats = JSON.parse(await statsRes.text());
    assert.equal(stats.summary.matches, 1);
    assert.equal(stats.summary.tickRate, TICK_RATE);
    assert.equal(stats.matches[0].room, room.id);

    const health = JSON.parse(await (await fetch(`${env.url}/health`)).text());
    assert.equal(health.tick.matches, 1);
    assert.equal(health.tick.tickRate, TICK_RATE);

    client.send({ v: 1, type: 'codec', codec: 'json' });
    await sleep(60);
    const jsonSnap = await client.next((m) => m.type === 'snapshot' && m.v === 1);
    assert.equal(jsonSnap.type, 'snapshot');

    client.socket.close();
    await client.closed;
  });
});
