/**
 * Відмальовування кадру: тло, судно з інтерполяцією, полум'я, HUD.
 * Стан симуляції тут лише читається.
 */

import { lerp, lerpAngle } from '../math.js';

const GRID_SIZE = 80;
const SHIP_RADIUS = 20;
const STAR_COUNT = 160;
const HUD_FONT = '14px ui-monospace, Menlo, Consolas, monospace';

// Зірки зберігаються в частках екрана (0..1): під час зміни розміру небо масштабується, а не
// генерується заново. Генератор із фіксованим seed (mulberry32) дає те саме небо за кожного запуску.
const stars = createStars(STAR_COUNT);

function createStars(count) {
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    radius: 0.5 + random() * 1.3,
    alpha: 0.25 + random() * 0.6,
  }));
}

function drawBackground(ctx, view) {
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, view.width, view.height);

  ctx.strokeStyle = 'rgba(90, 120, 180, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= view.width; x += GRID_SIZE) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, view.height);
  }
  for (let y = 0; y <= view.height; y += GRID_SIZE) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(view.width, y + 0.5);
  }
  ctx.stroke();

  for (const star of stars) {
    ctx.fillStyle = `rgba(210, 225, 255, ${star.alpha})`;
    ctx.beginPath();
    ctx.arc(star.x * view.width, star.y * view.height, star.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawShipBody(ctx, thrust, now) {
  if (thrust) {
    const flicker = 0.5 + 0.5 * Math.sin(now / 35);
    const length = 12 + 10 * flicker;
    ctx.fillStyle = '#ff9a2e';
    ctx.beginPath();
    ctx.moveTo(-8, -5);
    ctx.lineTo(-8 - length, 0);
    ctx.lineTo(-8, 5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ffe38a';
    ctx.beginPath();
    ctx.moveTo(-8, -2.5);
    ctx.lineTo(-8 - length * 0.55, 0);
    ctx.lineTo(-8, 2.5);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = '#0d1b2e';
  ctx.strokeStyle = '#5fd7ff';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.lineTo(-12, -11);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-12, 11);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawShip(ctx, view, ship, alpha, now) {
  const x = lerp(ship.prevX, ship.x, alpha);
  const y = lerp(ship.prevY, ship.y, alpha);
  const angle = lerpAngle(ship.prevAngle, ship.angle, alpha);

  // Судно біля краю малюється ще й з протилежного боку: перенос виглядає безшовним.
  for (const offsetX of [-view.width, 0, view.width]) {
    for (const offsetY of [-view.height, 0, view.height]) {
      const px = x + offsetX;
      const py = y + offsetY;
      const visible =
        px > -SHIP_RADIUS &&
        px < view.width + SHIP_RADIUS &&
        py > -SHIP_RADIUS &&
        py < view.height + SHIP_RADIUS;
      if (!visible) continue;

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      drawShipBody(ctx, ship.thrust, now);
      ctx.restore();
    }
  }
}

function drawHud(ctx, view, metrics) {
  ctx.save();
  ctx.font = HUD_FONT;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(190, 215, 255, 0.9)';
  ctx.fillText(`Steps/s:     ${metrics.stepsPerSec.toFixed(1)}`, 14, 12);
  ctx.fillText(`FPS:         ${metrics.fps.toFixed(1)}`, 14, 32);
  ctx.fillText(`Frame time:  ${metrics.frameTimeMs.toFixed(2)} ms`, 14, 52);

  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(190, 215, 255, 0.6)';
  ctx.fillText('← → / A D: поворот    ↑ / W: тяга', 14, view.height - 12);
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ width: number, height: number }} view розмір області в CSS-пікселях
 * @param {ReturnType<import('../sim/ship.js').createShip>} ship
 * @param {number} alpha частка кроку симуляції [0, 1) для інтерполяції
 * @param {{ stepsPerSec: number, fps: number, frameTimeMs: number }} metrics
 * @param {number} now поточний час, мс (лише для анімації полум'я)
 */
export function drawFrame(ctx, view, ship, alpha, metrics, now) {
  drawBackground(ctx, view);
  drawShip(ctx, view, ship, alpha, now);
  drawHud(ctx, view, metrics);
}
