/**
 * Екран завантаження на Canvas: справжній прогрес-бар, відсотки, статус ресурсів, що
 * вантажаться, і кнопка Retry (після помилки або таймауту). Після завантаження той самий
 * модуль малює лише тло, поверх якого DOM-лобі.
 */

import { drawBackground } from './draw.js';
import { TAU } from '@dogfight/shared';

const FONT = 'ui-monospace, Menlo, Consolas, monospace';
const BUTTON = { width: 180, height: 44 };

/**
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {{ width: number, height: number }} options.view
 * @param {HTMLCanvasElement} options.canvas
 */
export function createLoadingScreen({ ctx, view, canvas }) {
  const state = {
    mode: 'loading', // 'loading' | 'error' | 'idle' (лише тло)
    ratio: 0,
    shown: 0, // згладжене значення ratio для анімації
    done: 0,
    total: 0,
    failed: 0,
    active: [],
    message: '',
    detail: '',
    retryRect: null,
  };
  let rafId = 0;
  let running = false;
  let retryResolver = null;

  function drawLoading(now) {
    const cx = view.width / 2;
    const cy = view.height / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8f3ff';
    ctx.font = `700 40px ${FONT}`;
    ctx.fillText('DOGFIGHT', cx, cy - 90);
    ctx.fillStyle = 'rgba(190, 215, 255, 0.6)';
    ctx.font = `14px ${FONT}`;
    ctx.fillText('Лабораторна робота №4 · завантаження ресурсів', cx, cy - 56);

    const width = Math.min(420, view.width - 48);
    const x = cx - width / 2;
    const y = cy - 8;

    ctx.fillStyle = 'rgba(190, 215, 255, 0.14)';
    ctx.fillRect(x, y, width, 14);
    ctx.fillStyle = state.failed > 0 ? '#ffb347' : '#5fd7ff';
    ctx.fillRect(x, y, width * state.shown, 14);

    // Бігунок-індикатор активності поверх бару.
    const sweep = ((now / 900) % 1) * (width + 60) - 30;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width * state.shown, 14);
    ctx.clip();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(x + sweep, y, 30, 14);
    ctx.restore();

    ctx.fillStyle = '#e8f3ff';
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText(`${Math.round(state.shown * 100)}%`, cx, y + 38);

    ctx.fillStyle = 'rgba(190, 215, 255, 0.75)';
    ctx.font = `13px ${FONT}`;
    const status = state.active.length
      ? `Завантажую: ${state.active.join(', ')}`
      : state.done >= state.total && state.total > 0
        ? 'Готово'
        : 'Підготовка…';
    ctx.fillText(status, cx, y + 64);
    ctx.fillText(
      `Ресурсів: ${state.done}/${state.total}${state.failed ? ` · пропущено: ${state.failed}` : ''}`,
      cx,
      y + 84,
    );
  }

  function drawError() {
    const cx = view.width / 2;
    const cy = view.height / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff8a7a';
    ctx.font = `700 22px ${FONT}`;
    ctx.fillText('Не вдалося завантажити гру', cx, cy - 70);

    ctx.fillStyle = 'rgba(255, 210, 200, 0.95)';
    ctx.font = `15px ${FONT}`;
    ctx.fillText(state.message, cx, cy - 32);
    if (state.detail) {
      ctx.fillStyle = 'rgba(190, 215, 255, 0.55)';
      ctx.font = `12px ${FONT}`;
      ctx.fillText(state.detail, cx, cy - 8);
    }

    const bx = cx - BUTTON.width / 2;
    const by = cy + 24;
    state.retryRect = { x: bx, y: by, width: BUTTON.width, height: BUTTON.height };
    ctx.fillStyle = '#5fd7ff';
    ctx.beginPath();
    ctx.roundRect(bx, by, BUTTON.width, BUTTON.height, 8);
    ctx.fill();
    ctx.fillStyle = '#05121f';
    ctx.font = `700 17px ${FONT}`;
    ctx.fillText('Retry', cx, by + BUTTON.height / 2);
    ctx.fillStyle = 'rgba(190, 215, 255, 0.5)';
    ctx.font = `12px ${FONT}`;
    ctx.fillText('або натисніть Enter', cx, by + BUTTON.height + 20);
  }

  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    state.shown += (state.ratio - state.shown) * 0.18;
    if (Math.abs(state.ratio - state.shown) < 0.002) state.shown = state.ratio;

    drawBackground(ctx, view);
    if (state.mode === 'loading') drawLoading(now);
    else if (state.mode === 'error') drawError();
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    // Невелике "дихання" тла під час очікування: не дає екрану виглядати зависшим.
    if (state.mode !== 'idle') {
      ctx.fillStyle = `rgba(95, 215, 255, ${0.04 + 0.02 * Math.sin((now / 1200) * TAU)})`;
      ctx.fillRect(0, 0, view.width, 2);
    }
  }

  function triggerRetry() {
    if (state.mode !== 'error' || !retryResolver) return;
    const resolve = retryResolver;
    retryResolver = null;
    resolve();
  }

  function onClick(event) {
    const rect = state.retryRect;
    if (state.mode !== 'error' || !rect) return;
    const canvasRect = canvas.getBoundingClientRect();
    const x = event.clientX - canvasRect.left;
    const y = event.clientY - canvasRect.top;
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      triggerRetry();
    }
  }

  function onKeyDown(event) {
    if (state.mode === 'error' && (event.code === 'Enter' || event.code === 'NumpadEnter')) {
      event.preventDefault();
      triggerRetry();
    }
  }

  canvas.addEventListener('click', onClick);
  window.addEventListener('keydown', onKeyDown);

  return {
    start() {
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
    /** Прогрес від loadAll. */
    onProgress(progress) {
      state.ratio = progress.ratio;
      state.done = progress.done;
      state.total = progress.total;
      state.failed = progress.failed;
      state.active = progress.active;
    },
    /** Скидає стан і показує бар. */
    showLoading() {
      Object.assign(state, {
        mode: 'loading',
        ratio: 0,
        shown: 0,
        done: 0,
        total: 0,
        failed: 0,
        active: [],
      });
    },
    /** Показує помилку з кнопкою Retry; проміс завершується, коли користувач натисне Retry. */
    showError(message, detail = '') {
      Object.assign(state, { mode: 'error', message, detail });
      return new Promise((resolve) => {
        retryResolver = resolve;
      });
    },
    /** Лише тло (поки показане лобі). */
    showBackdrop() {
      state.mode = 'idle';
    },
    get mode() {
      return state.mode;
    },
    destroy() {
      this.stop();
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
