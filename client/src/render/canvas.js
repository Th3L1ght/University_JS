/**
 * Ініціалізація Canvas 2D: буфер у фізичних пікселях (devicePixelRatio) і автоматична зміна
 * розміру. Увесь інший код малює в CSS-пікселях: масштаб DPR застосовується один раз
 * через setTransform.
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{
 *   ctx: CanvasRenderingContext2D,
 *   view: { width: number, height: number, dpr: number },
 *   destroy: () => void
 * }}
 */
export function createCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D не підтримується цим браузером');

  const view = { width: 0, height: 0, dpr: 1 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    view.width = window.innerWidth;
    view.height = window.innerHeight;
    view.dpr = dpr;
    canvas.width = Math.round(view.width * dpr);
    canvas.height = Math.round(view.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    ctx,
    view,
    destroy: () => window.removeEventListener('resize', resize),
  };
}
