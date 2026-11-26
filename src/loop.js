/**
 * Ігровий цикл із фіксованим кроком симуляції (fixed timestep + accumulator).
 *
 * Час кадру накопичується в акумуляторі, симуляція виконується строго кроками по `step`
 * секунд, а render отримує коефіцієнт alpha = залишок / step для інтерполяції.
 * Дельта клампиться значенням MAX_FRAME_DT, щоб після довгого простою (фонова вкладка,
 * пауза у відлагоджувачі) не сталася «спіраль смерті»: сотні кроків поспіль усередині одного кадру.
 */

const MAX_FRAME_DT = 0.25; // секунди: максимум часу, що додається за один кадр
const METRICS_WINDOW_MS = 500; // вікно усереднення stepsPerSec і fps
const STALL_RESET_MS = 1000; // пауза довша за це скидає вікно метрик

/**
 * @param {object} options
 * @param {number} [options.step] довжина кроку симуляції, секунди (за замовчуванням 1/60)
 * @param {(dt: number) => void} options.simulate крок симуляції
 * @param {(alpha: number, metrics: object) => void} options.render відмальовування кадру
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createLoop({ step = 1 / 60, simulate, render }) {
  const metrics = { stepsPerSec: 0, fps: 0, frameTimeMs: 0 };

  let rafId = 0;
  let running = false;
  let firstFrame = true;
  let lastTime = 0;
  let accumulator = 0;
  let windowStart = 0;
  let windowSteps = 0;
  let windowFrames = 0;

  function resetWindow(time) {
    windowStart = time;
    windowSteps = 0;
    windowFrames = 0;
  }

  function frame(time) {
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

    // frameTimeMs: скільки CPU-часу забрали simulate + render останнього кадру.
    metrics.frameTimeMs = performance.now() - workStart;

    const elapsed = time - windowStart;
    if (elapsed >= METRICS_WINDOW_MS) {
      metrics.stepsPerSec = (windowSteps * 1000) / elapsed;
      metrics.fps = (windowFrames * 1000) / elapsed;
      resetWindow(time);
    }
  }

  function start() {
    if (running) return;
    running = true;
    firstFrame = true;
    accumulator = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  return { start, stop };
}
