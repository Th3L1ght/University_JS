/**
 * Відмальовування кадру: тло, усі сутності світу зі спрайтів з інтерполяцією, HUD.
 * Стан симуляції тут лише читається.
 */

import { createRng, Kind, lerp, lerpAngle, TAU } from '@dogfight/shared';
import { asteroidFrameName, ASTEROID_VARIANTS } from '../assets/atlas.js';
import { drawSprite } from './sprites.js';

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

/** Тло: сітка й зорі. Використовується і грою, і екранами завантаження та лобі. */
export function drawBackground(ctx, view) {
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

  // Чуже судно в мережевому матчі підсвічується м'яким кільцем.
  if (state.localShipId && ship.id !== state.localShipId) {
    ctx.strokeStyle = 'rgba(255, 130, 95, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, ship.radius + 4, 0, TAU);
    ctx.stroke();
  }

  // Бонус rapid fire підсвічується золотим кільцем.
  if (ship.hasBuff('rapid')) {
    ctx.strokeStyle = 'rgba(255, 216, 74, 0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, ship.radius + 6, 0, TAU);
    ctx.stroke();
  }

  const sheet = state.sheets.sprites;
  // Полум'я двигуна: два кадри, що чергуються (~16 разів на секунду).
  if (ship.thrust) {
    const frame = Math.floor(state.now / 60) % 2 === 0 ? 'flame_a' : 'flame_b';
    drawSprite(ctx, sheet, frame, { dx: -24 });
  }
  drawSprite(ctx, sheet, 'ship');
}

function paintBullet(ctx, bullet, state) {
  const frame = bullet.components.homing ? 'missile' : 'bullet';
  drawSprite(ctx, state.sheets.sprites, frame);
}

function paintAsteroid(ctx, asteroid, state) {
  const hunter = Boolean(asteroid.components.homing);
  const variant = asteroid.id % ASTEROID_VARIANTS;
  drawSprite(ctx, state.sheets.asteroids, asteroidFrameName(asteroid.size, variant, hunter));
}

function paintPickup(ctx, pickup, state) {
  const { effect } = pickup.components.pickup;
  const remaining = pickup.components.lifetime?.remaining ?? Infinity;
  // Перед зникненням бонус блимає.
  if (remaining < 3) ctx.globalAlpha = 0.45 + 0.4 * Math.sin(state.now / 70);

  const pulse = 1 + 0.08 * Math.sin(state.now / 200);
  const frame = effect.type === 'heal' ? 'pickup_heal' : 'pickup_rapid';
  drawSprite(ctx, state.sheets.sprites, frame, { scale: pulse });
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

function drawEntity(ctx, view, entity, painter, state) {
  if (entity.kind === Kind.EXPLOSION) {
    painter(ctx, entity, state);
    return;
  }

  const x = lerp(entity.prevPos.x, entity.pos.x, state.alpha);
  const y = lerp(entity.prevPos.y, entity.pos.y, state.alpha);
  const angle = lerpAngle(entity.prevAngle, entity.angle, state.alpha);
  // Спрайт астероїда трохи більший за коло зіткнень, тому запас по краях ширший.
  const margin = entity.radius * 1.4 + 24;

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
      painter(ctx, entity, state);
      ctx.restore();
    }
  }
}

function drawEntities(ctx, arena, world, state) {
  for (const kind of DRAW_ORDER) {
    const painter = PAINTERS[kind];
    for (const entity of world.ofKind(kind)) {
      if (entity.alive) drawEntity(ctx, arena, entity, painter, state);
    }
  }
}

// --- HUD ---

function drawHud(ctx, view, world, metrics, session) {
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

  // Пілот і кімната (праворуч угорі).
  if (session) {
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(190, 215, 255, 0.9)';
    ctx.fillText(session.nickname, view.width - 14, 12);
    ctx.fillStyle = 'rgba(190, 215, 255, 0.55)';
    ctx.fillText(session.roomName, view.width - 14, 32);
    ctx.textAlign = 'start';
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
    '← → / A D: поворот    ↑ / W: тяга    Пробіл: вогонь    X / E: ракета    M: звук    Tab / F3: Netgraph',
    14,
    view.height - 12,
  );
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ width: number, height: number }} view розмір області в CSS-пікселях
 * @param {{ width: number, height: number, player: any, score: number, respawnIn: number, ofKind: Function }} world
 * @param {number} alpha частка кроку симуляції [0, 1) для інтерполяції
 * @param {{ stepsPerSec: number, fps: number, frameTimeMs: number }} metrics
 * @param {number} now поточний час, мс (лише для анімацій)
 * @param {Record<string, object>} sheets завантажені спрайт-листи (loadAll().sprites)
 * @param {{ nickname: string, roomName: string, mode?: string } | null} [session]
 */
export function drawFrame(ctx, view, world, alpha, metrics, now, sheets, session = null) {
  drawBackground(ctx, view);
  const arena = { width: world.width, height: world.height };
  const localShipId = world.player?.id ?? null;

  const scaled = arena.width !== view.width || arena.height !== view.height;
  if (scaled && arena.width > 0 && arena.height > 0) {
    const scale = Math.min(view.width / arena.width, view.height / arena.height);
    const offsetX = (view.width - arena.width * scale) / 2;
    const offsetY = (view.height - arena.height * scale) / 2;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, arena.width, arena.height);
    ctx.clip();
    drawEntities(ctx, arena, world, { alpha, now, sheets, localShipId });
    ctx.strokeStyle = 'rgba(95, 215, 255, 0.25)';
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeRect(0.5, 0.5, arena.width - 1, arena.height - 1);
    ctx.restore();
  } else {
    drawEntities(ctx, arena, world, { alpha, now, sheets, localShipId });
  }

  drawHud(ctx, view, world, metrics, session);
}
