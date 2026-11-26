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
  frameP50Ms: number;
  frameP95Ms: number;
  frameP99Ms: number;
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
  const metrics: LoopMetrics = {
    stepsPerSec: 0,
    fps: 0,
    frameTimeMs: 0,
    frameP50Ms: 0,
    frameP95Ms: 0,
    frameP99Ms: 0,
  };
  const frameWindow = new Float64Array(120);
  let frameIdx = 0;
  let frameCount = 0;

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
    if (accumulator >= step) {
      performance.mark?.('dogfight:sim-start');
      while (accumulator >= step) {
        simulate(step);
        accumulator -= step;
        windowSteps += 1;
      }
      performance.mark?.('dogfight:sim-end');
      performance.measure?.('dogfight:simulate', 'dogfight:sim-start', 'dogfight:sim-end');
    }

    performance.mark?.('dogfight:render-start');
    render(accumulator / step, metrics);
    performance.mark?.('dogfight:render-end');
    performance.measure?.('dogfight:render', 'dogfight:render-start', 'dogfight:render-end');
    windowFrames += 1;

    const frameMs = performance.now() - workStart;
    metrics.frameTimeMs = frameMs;
    frameWindow[frameIdx] = frameMs;
    frameIdx = (frameIdx + 1) % frameWindow.length;
    frameCount = Math.min(frameCount + 1, frameWindow.length);

    const elapsed = time - windowStart;
    if (elapsed >= METRICS_WINDOW_MS) {
      metrics.stepsPerSec = (windowSteps * 1000) / elapsed;
      metrics.fps = (windowFrames * 1000) / elapsed;
      const sorted = Array.from(frameWindow.subarray(0, frameCount)).sort((a, b) => a - b);
      const pick = (p: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      metrics.frameP50Ms = pick(0.5);
      metrics.frameP95Ms = pick(0.95);
      metrics.frameP99Ms = pick(0.99);
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
