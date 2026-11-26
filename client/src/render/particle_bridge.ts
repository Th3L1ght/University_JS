/**
 * Міст до Web Worker візуальних частинок із zero-copy Transferable Float32Array.
 *
 * При запуску по `file://` (де браузер блокує `new Worker` через CORS/null-origin) або без
 * підтримки Worker автоматично перемикається на fallback у головному потоці.
 */

import { createRng, TAU } from '@dogfight/shared';

const STRIDE = 5;
const MAX_PARTICLES = 2048;
const PARTICLE_DRAG = 2;

export interface ParticleSpawnOptions {
  readonly x: number;
  readonly y: number;
  readonly count: number;
  readonly speed: number;
  readonly life: number;
  readonly tint: 'rock' | 'ship';
}

export interface ParticleSystem {
  readonly mode: 'worker' | 'main';
  spawn(options: ParticleSpawnOptions): void;
  step(dt: number): void;
  draw(ctx: CanvasRenderingContext2D): void;
  destroy(): void;
}

interface LocalParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  tintCode: number;
}

function drawPackedBuffer(
  ctx: CanvasRenderingContext2D,
  buffer: Float32Array,
  count: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const o = i * STRIDE;
    const x = buffer[o] ?? 0;
    const y = buffer[o + 1] ?? 0;
    const size = buffer[o + 2] ?? 1;
    const fade = buffer[o + 3] ?? 0;
    const tintCode = buffer[o + 4] ?? 0;
    const rgb =
      tintCode === 1
        ? fade > 0.5
          ? '255, 255, 255'
          : '120, 220, 255'
        : fade > 0.5
          ? '255, 210, 140'
          : '255, 120, 60';
    ctx.fillStyle = `rgba(${rgb}, ${fade.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, size * (0.4 + fade), 0, TAU);
    ctx.fill();
  }
}

function createMainThreadParticles(): ParticleSystem {
  const rng = createRng(0x5a17);
  const particles: LocalParticle[] = [];
  const buffer = new Float32Array(MAX_PARTICLES * STRIDE);
  let activeCount = 0;

  return {
    mode: 'main',
    spawn({ x, y, count, speed, life, tint }) {
      const tintCode = tint === 'ship' ? 1 : 0;
      const toAdd = Math.min(count, Math.max(0, MAX_PARTICLES - particles.length));
      for (let i = 0; i < toAdd; i += 1) {
        const dir = rng() * TAU;
        const v = speed * (0.35 + rng() * 0.65);
        const lifetime = life * (0.6 + rng() * 0.4);
        particles.push({
          x,
          y,
          vx: Math.cos(dir) * v,
          vy: Math.sin(dir) * v,
          life: lifetime,
          maxLife: lifetime,
          size: 1 + rng() * 2.2,
          tintCode,
        });
      }
    },
    step(dt) {
      const clamped = Math.min(dt, 0.05);
      const damping = Math.exp(-PARTICLE_DRAG * clamped);
      activeCount = 0;
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        if (!p) continue;
        p.x += p.vx * clamped;
        p.y += p.vy * clamped;
        p.vx *= damping;
        p.vy *= damping;
        p.life -= clamped;
        if (p.life <= 0) {
          const last = particles.pop();
          if (last && i < particles.length) particles[i] = last;
          continue;
        }
        const o = activeCount * STRIDE;
        buffer[o] = p.x;
        buffer[o + 1] = p.y;
        buffer[o + 2] = p.size;
        buffer[o + 3] = p.life / p.maxLife;
        buffer[o + 4] = p.tintCode;
        activeCount += 1;
      }
    },
    draw(ctx) {
      drawPackedBuffer(ctx, buffer, activeCount);
    },
    destroy() {
      particles.length = 0;
      activeCount = 0;
    },
  };
}

export function createParticleSystem(): ParticleSystem {
  const canUseWorker =
    typeof Worker !== 'undefined' &&
    typeof globalThis.location !== 'undefined' &&
    globalThis.location.protocol !== 'file:';

  if (!canUseWorker) return createMainThreadParticles();

  let worker: Worker;
  try {
    worker = new Worker(new URL('../workers/particle_worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    return createMainThreadParticles();
  }

  // Подвійна буферизація Transferable Float32Array: один у рендері, другий у воркері.
  let renderBuffer = new Float32Array(MAX_PARTICLES * STRIDE);
  let renderCount = 0;
  let spareBuffer: Float32Array | null = new Float32Array(MAX_PARTICLES * STRIDE);

  worker.addEventListener(
    'message',
    (event: MessageEvent<{ type: string; count: number; buffer: Float32Array<ArrayBuffer> }>) => {
      if (event.data.type !== 'frame') return;
      spareBuffer = renderBuffer;
      renderBuffer = event.data.buffer;
      renderCount = event.data.count;
    },
  );

  return {
    mode: 'worker',
    spawn(options) {
      worker.postMessage({ type: 'spawn', ...options });
    },
    step(dt) {
      if (!spareBuffer) return; // воркер ще рахує попередній кадр
      const toSend = spareBuffer;
      spareBuffer = null;
      worker.postMessage({ type: 'step', dt, buffer: toSend }, [toSend.buffer]);
    },
    draw(ctx) {
      drawPackedBuffer(ctx, renderBuffer, renderCount);
    },
    destroy() {
      worker.terminate();
      renderCount = 0;
    },
  };
}
