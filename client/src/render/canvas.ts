/**
 * Ініціалізація Canvas 2D: буфер у фізичних пікселях (devicePixelRatio) і автоматичний ресайз.
 */

export interface CanvasView {
  width: number;
  height: number;
  dpr: number;
}

export interface CanvasHandle {
  readonly ctx: CanvasRenderingContext2D;
  readonly view: CanvasView;
  destroy(): void;
}

export function createCanvas(canvas: HTMLCanvasElement): CanvasHandle {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D не підтримується цим браузером');

  const view: CanvasView = { width: 0, height: 0, dpr: 1 };

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    view.width = window.innerWidth;
    view.height = window.innerHeight;
    view.dpr = dpr;
    canvas.width = Math.round(view.width * dpr);
    canvas.height = Math.round(view.height * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    ctx,
    view,
    destroy: () => window.removeEventListener('resize', resize),
  };
}
