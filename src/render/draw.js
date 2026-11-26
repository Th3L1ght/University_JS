/**
 * Відмальовування кадру: тло, усі сутності світу з інтерполяцією, HUD.
 * Стан симуляції тут лише читається.
 */

import { lerp, lerpAngle, TAU } from '../math.js';
import { Kind } from '../sim/entity.js';
import { createRng } from '../sim/rng.js';

const GRID_SIZE = 80;
const STAR_COUNT = 160;
const HUD_FONT = '14px ui-monospace, Menlo, Consolas, monospace';
const MAX_HP_BAR = 100;

// Зірки зберігаються в частках екрана (0..1): під час зміни розміру небо масштабується, а не
// генерується заново. Генератор із фіксованим seed дає те саме небо за кожного запуску.
const stars = createStars(STAR_COUNT);

function createStars(count) {
  const random = createRng(0x9e3779b9);
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
    ctx.arc(star.x * view.width, star.y * view.height, star.radius, 0, TAU);
    ctx.fill();
  }
}

// --- Художники сутностей. Початок координат - центр сутності, вісь X - її курс. ---

function paintShip(ctx, ship, state) {
  // Невразливе судно блимає.
  if (ship.invulnerable > 0) ctx.globalAlpha = 0.45 + 0.35 * Math.sin(state.now / 45);

  if (ship.thrust) {
    const flicker = 0.5 + 0.5 * Math.sin(state.now / 35);
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
  ctx.strokeStyle = ship.hasBuff('rapid') ? '#ffd84a' : '#5fd7ff';
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

function paintBullet(ctx, bullet, state) {
  if (bullet.components.homing) {
    // Ракета: подовжене тіло з полум'ям.
    const flicker = 0.5 + 0.5 * Math.sin(state.now / 30);
    ctx.fillStyle = '#ff7a2e';
    ctx.beginPath();
    ctx.moveTo(-6, -2.5);
    ctx.lineTo(-12 - 6 * flicker, 0);
    ctx.lineTo(-6, 2.5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ffd9a8';
    ctx.strokeStyle = '#ff9a2e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-6, -3.5);
    ctx.lineTo(-6, 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return;
  }

  ctx.strokeStyle = 'rgba(120, 230, 255, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-9, 0);
  ctx.lineTo(0, 0);
  ctx.stroke();
  ctx.fillStyle = '#e8fbff';
  ctx.beginPath();
  ctx.arc(0, 0, 2.6, 0, TAU);
  ctx.fill();
}

function paintAsteroid(ctx, asteroid) {
  const hunter = Boolean(asteroid.components.homing);
  ctx.fillStyle = hunter ? '#241216' : '#121a28';
  ctx.strokeStyle = hunter ? '#ff6b5a' : '#9aa7b8';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const count = asteroid.shape.length;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * TAU;
    const r = asteroid.radius * asteroid.shape[i];
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function paintPickup(ctx, pickup, state) {
  const { effect } = pickup.components.pickup;
  const color = effect.type === 'heal' ? '#5dff9a' : '#ffd84a';
  const remaining = pickup.components.lifetime?.remaining ?? Infinity;
  // Перед зникненням бонус блимає.
  if (remaining < 3) ctx.globalAlpha = 0.45 + 0.4 * Math.sin(state.now / 70);

  const pulse = 1 + 0.08 * Math.sin(state.now / 200);
  ctx.strokeStyle = color;
  ctx.fillStyle = `${color}26`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, pickup.radius * pulse, 0, TAU);
  ctx.fill();
  ctx.stroke();

  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (effect.type === 'heal') {
    ctx.moveTo(-6, 0);
    ctx.lineTo(6, 0);
    ctx.moveTo(0, -6);
    ctx.lineTo(0, 6);
  } else {
    ctx.moveTo(-6, -5);
    ctx.lineTo(0, 0);
    ctx.lineTo(-6, 5);
    ctx.moveTo(1, -5);
    ctx.lineTo(7, 0);
    ctx.lineTo(1, 5);
  }
  ctx.stroke();
}

/** Вибух малює частинки в координатах світу (без translate/rotate). */
function paintExplosion(ctx, explosion, state) {
  const palette =
    explosion.tint === 'ship'
      ? ['255, 255, 255', '120, 220, 255']
      : ['255, 210, 140', '255, 120, 60'];
  for (const p of explosion.particles) {
    if (p.life <= 0) continue;
    const fade = p.life / p.maxLife;
    const x = lerp(p.prevX, p.x, state.alpha);
    const y = lerp(p.prevY, p.y, state.alpha);
    ctx.fillStyle = `rgba(${palette[fade > 0.5 ? 0 : 1]}, ${fade.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, p.size * (0.4 + fade), 0, TAU);
    ctx.fill();
  }
}

const PAINTERS = {
  [Kind.SHIP]: paintShip,
  [Kind.BULLET]: paintBullet,
  [Kind.ASTEROID]: paintAsteroid,
  [Kind.PICKUP]: paintPickup,
  [Kind.EXPLOSION]: paintExplosion,
};

const DRAW_ORDER = [Kind.PICKUP, Kind.ASTEROID, Kind.BULLET, Kind.SHIP, Kind.EXPLOSION];

function drawEntity(ctx, view, entity, painter, alpha, now) {
  if (entity.kind === Kind.EXPLOSION) {
    painter(ctx, entity, { alpha, now });
    return;
  }

  const x = lerp(entity.prevPos.x, entity.pos.x, alpha);
  const y = lerp(entity.prevPos.y, entity.pos.y, alpha);
  const angle = lerpAngle(entity.prevAngle, entity.angle, alpha);
  const margin = entity.radius + 24;

  // Сутність біля краю малюється ще й з протилежного боку: перенос виглядає безшовним.
  for (const offsetX of [-view.width, 0, view.width]) {
    for (const offsetY of [-view.height, 0, view.height]) {
      const px = x + offsetX;
      const py = y + offsetY;
      if (px < -margin || px > view.width + margin || py < -margin || py > view.height + margin) {
        continue;
      }
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      painter(ctx, entity, { alpha, now });
      ctx.restore();
    }
  }
}

function drawEntities(ctx, view, world, alpha, now) {
  for (const kind of DRAW_ORDER) {
    const painter = PAINTERS[kind];
    for (const entity of world.ofKind(kind)) {
      if (entity.alive) drawEntity(ctx, view, entity, painter, alpha, now);
    }
  }
}

// --- HUD ---

function drawHud(ctx, view, world, metrics) {
  ctx.save();
  ctx.font = HUD_FONT;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(190, 215, 255, 0.9)';
  ctx.fillText(`Steps/s:     ${metrics.stepsPerSec.toFixed(1)}`, 14, 12);
  ctx.fillText(`FPS:         ${metrics.fps.toFixed(1)}`, 14, 32);
  ctx.fillText(`Frame time:  ${metrics.frameTimeMs.toFixed(2)} ms`, 14, 52);

  const ship = world.player;
  const hp = ship ? ship.hp : 0;
  ctx.fillStyle = 'rgba(190, 215, 255, 0.9)';
  ctx.fillText(`HP:          ${Math.round(hp)}`, 14, 78);
  const barWidth = 100;
  ctx.fillStyle = 'rgba(190, 215, 255, 0.18)';
  ctx.fillRect(160, 82, barWidth, 8);
  ctx.fillStyle = hp > 30 ? '#5dff9a' : '#ff6b5a';
  ctx.fillRect(160, 82, (barWidth * hp) / MAX_HP_BAR, 8);

  ctx.fillStyle = 'rgba(190, 215, 255, 0.9)';
  ctx.fillText(`Score:       ${world.score}`, 14, 98);

  let line = 118;
  if (ship) {
    for (const [name, remaining] of ship.activeBuffs()) {
      ctx.fillStyle = '#ffd84a';
      const label = name === 'rapid' ? 'Rapid fire' : name;
      ctx.fillText(`${label}: ${remaining.toFixed(1)} s`, 14, line);
      line += 20;
    }
  }

  if (world.respawnIn > 0) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '20px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(255, 180, 160, 0.95)';
    ctx.fillText(
      `Судно знищено - респаун через ${world.respawnIn.toFixed(1)} с`,
      view.width / 2,
      view.height / 2,
    );
    ctx.textAlign = 'start';
  }

  ctx.font = HUD_FONT;
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(190, 215, 255, 0.6)';
  ctx.fillText(
    '← → / A D: поворот    ↑ / W: тяга    Пробіл: вогонь    X / E: ракета',
    14,
    view.height - 12,
  );
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ width: number, height: number }} view розмір області в CSS-пікселях
 * @param {import('../sim/world.js').World} world
 * @param {number} alpha частка кроку симуляції [0, 1) для інтерполяції
 * @param {{ stepsPerSec: number, fps: number, frameTimeMs: number }} metrics
 * @param {number} now поточний час, мс (лише для анімацій)
 */
export function drawFrame(ctx, view, world, alpha, metrics, now) {
  drawBackground(ctx, view);
  drawEntities(ctx, view, world, alpha, now);
  drawHud(ctx, view, world, metrics);
}
