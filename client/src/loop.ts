/**
 * Ігровий цикл із фіксованим кроком симуляції (fixed timestep + accumulator).
 */

const MAX_FRAME_DT = 0.25;
const METRICS_WINDOW_MS = 500;
const STALL_RESET_MS = 1000;

export interface LoopMetrics {
  stepsPerSec: number;
  fps: number;
  frameTimeMs: number;
}

export interface LoopOptions {
  readonly step?: number;
  readonly simulate: (dt: number) => void;
  readonly render: (alpha: number, metrics: LoopMetrics) => void;
}

export interface LoopHandle {
  start(): void;
  stop(): void;
}

export function createLoop({ step = 1 / 60, simulate, render }: LoopOptions): LoopHandle {
  const metrics: LoopMetrics = { stepsPerSec: 0, fps: 0, frameTimeMs: 0 };

  let rafId = 0;
  let running = false;
  let firstFrame = true;
  let lastTime = 0;
  let accumulator = 0;
  let windowStart = 0;
  let windowSteps = 0;
  let windowFrames = 0;

  function resetWindow(time: number): void {
    windowStart = time;
    windowSteps = 0;
    windowFrames = 0;
  }

  function frame(time: number): void {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    const workStart = performance.now();
    if (firstFrame) {
      lastTime = time;
      resetWindow(time);
      firstFrame = false;
    }

    const rawDeltaMs = time - lastTime;
    lastTime = time;
    if (rawDeltaMs > STALL_RESET_MS) resetWindow(time);

    accumulator += Math.min(rawDeltaMs / 1000, MAX_FRAME_DT);
    while (accumulator >= step) {
      simulate(step);
      accumulator -= step;
      windowSteps += 1;
    }

    render(accumulator / step, metrics);
    windowFrames += 1;

    metrics.frameTimeMs = performance.now() - workStart;

    const elapsed = time - windowStart;
    if (elapsed >= METRICS_WINDOW_MS) {
      metrics.stepsPerSec = (windowSteps * 1000) / elapsed;
      metrics.fps = (windowFrames * 1000) / elapsed;
      resetWindow(time);
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    firstFrame = true;
    accumulator = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop(): void {
    running = false;
    cancelAnimationFrame(rafId);
  }

  return { start, stop };
}
