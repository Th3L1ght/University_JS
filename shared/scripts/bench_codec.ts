/**
 * Бенчмарк кодеків: JSON vs Binary (ArrayBuffer + DataView) на 30 Гц для 4 гравців.
 */

import { performance } from 'node:perf_hooks';
import {
  ARENA_SIZE,
  asSeq,
  asTick,
  binaryCodec,
  buildSnapshotMessage,
  createRng,
  jsonCodec,
  MsgType,
  TICK_DT,
  TICK_RATE,
  World,
  type InputMessage,
  type NetExplosionEvent,
  type SnapshotMessage,
} from '../src/index.ts';

const ITERATIONS = 10_000;
const encoder = new TextEncoder();

const world = new World({ width: ARENA_SIZE.width, height: ARENA_SIZE.height, seed: 42 });
for (const id of ['p1', 'p2', 'p3', 'p4']) world.addPlayer(id);
world.populate();
const rng = createRng(99);
let events: NetExplosionEvent[] = [];
world.addEventListener('exploded', (e) => {
  if (!(e instanceof CustomEvent)) return;
  const d = e.detail;
  if (d && (d.kind === 'ship' || d.kind === 'asteroid')) {
    events.push({ type: 'explosion', kind: d.kind, size: d.size, x: d.x, y: d.y });
  }
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

const snapshot: SnapshotMessage = {
  ...buildSnapshotMessage(world, { tick: asTick(300), events }),
  lastProcessedSeq: asSeq(300),
};

const inputMsg: InputMessage = {
  type: MsgType.INPUT,
  seq: asSeq(300),
  tick: asTick(300),
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

function measure<TFrame extends ArrayBuffer | string>(
  name: string,
  codec: {
    encode(m: SnapshotMessage | InputMessage): TFrame;
    decode(f: TFrame): unknown;
  },
) {
  for (let i = 0; i < 500; i += 1) codec.decode(codec.encode(snapshot));
  const t0 = performance.now();
  let lastSnap: TFrame = codec.encode(snapshot);
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
    kbDownPerClient: Number(((snapBytes * TICK_RATE) / 1024).toFixed(2)),
    kbUpPerClient: Number(((inputBytes * TICK_RATE) / 1024).toFixed(2)),
    usPerRoundTrip: Number(((elapsedMs * 1000) / ITERATIONS).toFixed(2)),
  };
}

console.table([
  measure<string>('JSON', jsonCodec),
  measure<ArrayBuffer>('Binary (DataView)', binaryCodec),
]);
