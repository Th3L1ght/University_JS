/**
 * Бенчмарк кодеків: JSON vs Binary (ArrayBuffer + DataView) на 30 Гц для 4 гравців.
 * Вимірює розмір кадру, трафік (KB/s down / up) і час encode + decode у мікросекундах.
 */

import { performance } from 'node:perf_hooks';
import {
  ARENA_SIZE,
  binaryCodec,
  buildSnapshotMessage,
  createRng,
  jsonCodec,
  MsgType,
  TICK_DT,
  TICK_RATE,
  World,
} from '../src/index.js';

const ITERATIONS = 10_000;
const encoder = new TextEncoder();

const world = new World({ width: ARENA_SIZE.width, height: ARENA_SIZE.height, seed: 42 });
for (const id of ['p1', 'p2', 'p3', 'p4']) world.addPlayer(id);
world.populate();
const rng = createRng(99);
let events = [];
world.addEventListener('exploded', (e) => {
  events.push({
    type: 'explosion',
    kind: e.detail.kind,
    size: e.detail.size,
    x: e.detail.x,
    y: e.detail.y,
  });
});

for (let i = 0; i < 300; i += 1) {
  events = [];
  for (const id of ['p1', 'p2', 'p3', 'p4']) {
    world.setInput(id, {
      thrust: rng() < 0.7,
      turn: Math.floor(rng() * 3) - 1,
      fire: rng() < 0.5,
      missile: false,
    });
  }
  world.step(TICK_DT);
}

const snapshot = buildSnapshotMessage(world, { tick: 300, events });
snapshot.lastProcessedSeq = 300;

const inputMsg = {
  type: MsgType.INPUT,
  seq: 300,
  tick: 300,
  thrust: true,
  turn: -1,
  fire: true,
  missile: false,
  prev: [
    { thrust: true, turn: -1, fire: false, missile: false },
    { thrust: true, turn: 0, fire: true, missile: false },
    { thrust: false, turn: 1, fire: false, missile: false },
  ],
};

function measure(name, codec) {
  // Прогрів JIT
  for (let i = 0; i < 500; i += 1) codec.decode(codec.encode(snapshot));

  const t0 = performance.now();
  let lastSnap;
  for (let i = 0; i < ITERATIONS; i += 1) {
    lastSnap = codec.encode(snapshot);
    codec.decode(lastSnap);
  }
  const elapsedMs = performance.now() - t0;

  const snapBytes =
    typeof lastSnap === 'string' ? encoder.encode(lastSnap).byteLength : lastSnap.byteLength;
  const rawInput = codec.encode(inputMsg);
  const inputBytes =
    typeof rawInput === 'string' ? encoder.encode(rawInput).byteLength : rawInput.byteLength;

  return {
    name,
    snapBytes,
    inputBytes,
    kbDownPerClient: (snapBytes * TICK_RATE) / 1024,
    kbUpPerClient: (inputBytes * TICK_RATE) / 1024,
    kbDown4Players: (snapBytes * TICK_RATE * 4) / 1024,
    kbUp4Players: (inputBytes * TICK_RATE * 4) / 1024,
    usPerRoundTrip: (elapsedMs * 1000) / ITERATIONS,
  };
}

const json = measure('JSON', jsonCodec);
const bin = measure('Binary (DataView)', binaryCodec);

console.log(
  `Сцена: 4 гравці (${snapshot.ships.length} ships, ${snapshot.asteroids.length} asteroids, ` +
    `${snapshot.bullets.length} bullets, ${snapshot.pickups.length} pickups, ${snapshot.events.length} events)`,
);
console.table([json, bin]);
