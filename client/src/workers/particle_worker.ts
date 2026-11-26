/**
 * Web Worker для симуляції візуальних частинок вибухів із передачею Transferable Float32Array.
 *
 * Формат буфера (5 float32 на частинку): [x, y, size, fade, tintCode], де tintCode: 0 = rock, 1 = ship.
 * Буфер передається туди-сюди через Transferable (`[buffer.buffer]`) без копіювання пам'яті.
 */

import { createRng, TAU } from '@dogfight/shared';

const PARTICLE_DRAG = 2;
const STRIDE = 5;
const MAX_PARTICLES = 2048;

interface WorkerParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  tintCode: number;
}

type WorkerInMessage =
  | {
      readonly type: 'spawn';
      readonly x: number;
      readonly y: number;
      readonly count: number;
      readonly speed: number;
      readonly life: number;
      readonly tint: 'rock' | 'ship';
    }
  | {
      readonly type: 'step';
      readonly dt: number;
      readonly buffer: Float32Array<ArrayBuffer>;
    };

const rng = createRng(0x5a17);
const particles: WorkerParticle[] = [];

function workerPost(message: unknown, transfer: Transferable[]): void {
  // Виклик DedicatedWorkerGlobalScope.postMessage(msg, transfer) без перемикання lib на WebWorker.
  Reflect.apply(self.postMessage, self, [message, transfer]);
}

self.addEventListener('message', (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  if (msg.type === 'spawn') {
    const tintCode = msg.tint === 'ship' ? 1 : 0;
    const room = Math.max(0, MAX_PARTICLES - particles.length);
    const toAdd = Math.min(msg.count, room);
    for (let i = 0; i < toAdd; i += 1) {
      const dir = rng() * TAU;
      const v = msg.speed * (0.35 + rng() * 0.65);
      const lifetime = msg.life * (0.6 + rng() * 0.4);
      particles.push({
        x: msg.x,
        y: msg.y,
        vx: Math.cos(dir) * v,
        vy: Math.sin(dir) * v,
        life: lifetime,
        maxLife: lifetime,
        size: 1 + rng() * 2.2,
        tintCode,
      });
    }
    return;
  }

  if (msg.type === 'step') {
    const dt = Math.min(msg.dt, 0.05);
    const damping = Math.exp(-PARTICLE_DRAG * dt);
    const out = msg.buffer;
    const maxSlots = Math.floor(out.length / STRIDE);
    let count = 0;

    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      if (!p) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= damping;
      p.vy *= damping;
      p.life -= dt;
      if (p.life <= 0) {
        const last = particles.pop();
        if (last && i < particles.length) particles[i] = last;
        continue;
      }
      if (count < maxSlots) {
        const o = count * STRIDE;
        out[o] = p.x;
        out[o + 1] = p.y;
        out[o + 2] = p.size;
        out[o + 3] = p.life / p.maxLife;
        out[o + 4] = p.tintCode;
        count += 1;
      }
    }

    workerPost({ type: 'frame', count, buffer: out }, [out.buffer]);
  }
});
