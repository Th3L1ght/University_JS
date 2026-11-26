/**
 * Відмальовування кадру: тло, сутності світу зі спрайтів з інтерполяцією, HUD.
 */

import {
  assertNever,
  createRng,
  Kind,
  lerp,
  lerpAngle,
  TAU,
  type AsteroidSize,
  type EntityComponents,
  type EntityId,
  type EntityKind,
  type ExplosionParticle,
  type ExplosionTint,
  type Vec2Like,
} from '@dogfight/shared';
import { ASTEROID_VARIANTS, asteroidFrameName } from '../assets/atlas.ts';
import type { LoopMetrics } from '../loop.ts';
import { drawSprite, type LoadedSpriteSheet } from './sprites.ts';

export interface ShipView {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly pos: Vec2Like;
  readonly prevPos: Vec2Like;
  readonly angle: number;
  readonly prevAngle: number;
  readonly radius: number;
  readonly alive: boolean;
  readonly hp: number;
  readonly thrust: number;
  readonly invulnerable: number;
  hasBuff(name: string): boolean;
  activeBuffs(): Iterable<readonly [string, number]>;
}

export interface RenderableEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly pos: Vec2Like;
  readonly prevPos: Vec2Like;
  readonly angle: number;
  readonly prevAngle: number;
  readonly radius: number;
  readonly alive: boolean;
  readonly components?: EntityComponents;
  readonly size?: AsteroidSize;
  readonly hp?: number;
  readonly thrust?: number;
  readonly invulnerable?: number;
  readonly tint?: ExplosionTint;
  readonly particles?: readonly ExplosionParticle[];
  hasBuff?(name: string): boolean;
  activeBuffs?(): Iterable<readonly [string, number]>;
}

export interface RenderWorld {
  readonly width: number;
  readonly height: number;
  readonly player: ShipView | null;
  readonly score: number;
  readonly respawnIn: number;
  ofKind(kind: EntityKind): Iterable<RenderableEntity>;
}

export interface DrawSession {
  readonly nickname: string;
  readonly roomName: string;
}

const GRID_SIZE = 80;
const STAR_COUNT = 160;
const HUD_FONT = '14px ui-monospace, Menlo, Consolas, monospace';
const MAX_HP_BAR = 100;

const stars = createStars(STAR_COUNT);

function createStars(count: number) {
  const random = createRng(0x9e3779b9);
  return Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    radius: 0.5 + random() * 1.3,
    alpha: 0.25 + random() * 0.6,
  }));
}

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  view: { readonly width: number; readonly height: number },
): void {
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

interface PaintState {
  readonly alpha: number;
  readonly now: number;
  readonly sheets: Readonly<Record<string, LoadedSpriteSheet>>;
  readonly localShipId: EntityId | null;
}

function paintShip(ctx: CanvasRenderingContext2D, ship: RenderableEntity, state: PaintState): void {
  if ((ship.invulnerable ?? 0) > 0) ctx.globalAlpha = 0.45 + 0.35 * Math.sin(state.now / 45);

  if (state.localShipId && ship.id !== state.localShipId) {
    ctx.strokeStyle = 'rgba(255, 130, 95, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, ship.radius + 4, 0, TAU);
    ctx.stroke();
  }

  if (ship.hasBuff?.('rapid')) {
    ctx.strokeStyle = 'rgba(255, 216, 74, 0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, ship.radius + 6, 0, TAU);
    ctx.stroke();
  }

  const sheet = state.sheets.sprites;
  if (!sheet) return;
  if (ship.thrust) {
    const frame = Math.floor(state.now / 60) % 2 === 0 ? 'flame_a' : 'flame_b';
    drawSprite(ctx, sheet, frame, { dx: -24 });
  }
  drawSprite(ctx, sheet, 'ship');
}

function paintBullet(
  ctx: CanvasRenderingContext2D,
  bullet: RenderableEntity,
  state: PaintState,
): void {
  const sheet = state.sheets.sprites;
  if (!sheet) return;
  const frame = bullet.components?.homing ? 'missile' : 'bullet';
  drawSprite(ctx, sheet, frame);
}

function paintAsteroid(
  ctx: CanvasRenderingContext2D,
  asteroid: RenderableEntity,
  state: PaintState,
): void {
  const sheet = state.sheets.asteroids;
  if (!sheet) return;
  const hunter = Boolean(asteroid.components?.homing);
  const variant = asteroid.id % ASTEROID_VARIANTS;
  const size: AsteroidSize = asteroid.size ?? 3;
  drawSprite(ctx, sheet, asteroidFrameName(size, variant, hunter));
}

function paintPickup(
  ctx: CanvasRenderingContext2D,
  pickup: RenderableEntity,
  state: PaintState,
): void {
  const sheet = state.sheets.sprites;
  const effect = pickup.components?.pickup?.effect;
  if (!sheet || !effect) return;
  const remaining = pickup.components?.lifetime?.remaining ?? Infinity;
  if (remaining < 3) ctx.globalAlpha = 0.45 + 0.4 * Math.sin(state.now / 70);

  const pulse = 1 + 0.08 * Math.sin(state.now / 200);
  const frame = effect.type === 'heal' ? 'pickup_heal' : 'pickup_rapid';
  drawSprite(ctx, sheet, frame, { scale: pulse });
}

function paintExplosion(
  ctx: CanvasRenderingContext2D,
  explosion: RenderableEntity,
  state: PaintState,
): void {
  const palette =
    explosion.tint === 'ship'
      ? (['255, 255, 255', '120, 220, 255'] as const)
      : (['255, 210, 140', '255, 120, 60'] as const);
  for (const p of explosion.particles ?? []) {
    if (p.life <= 0) continue;
    const fade = p.life / p.maxLife;
    const x = lerp(p.prevX, p.x, state.alpha);
    const y = lerp(p.prevY, p.y, state.alpha);
    ctx.fillStyle = `rgba(${fade > 0.5 ? palette[0] : palette[1]}, ${fade.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, p.size * (0.4 + fade), 0, TAU);
    ctx.fill();
  }
}

function paintByKind(
  ctx: CanvasRenderingContext2D,
  entity: RenderableEntity,
  state: PaintState,
): void {
  switch (entity.kind) {
    case Kind.SHIP:
      paintShip(ctx, entity, state);
      return;
    case Kind.BULLET:
      paintBullet(ctx, entity, state);
      return;
    case Kind.ASTEROID:
      paintAsteroid(ctx, entity, state);
      return;
    case Kind.PICKUP:
      paintPickup(ctx, entity, state);
      return;
    case Kind.EXPLOSION:
      paintExplosion(ctx, entity, state);
      return;
    default: {
      const _exhaustive: never = entity.kind;
      return assertNever(_exhaustive, 'невідомий вид сутності для рендера');
    }
  }
}

const DRAW_ORDER: readonly EntityKind[] = [
  Kind.PICKUP,
  Kind.ASTEROID,
  Kind.BULLET,
  Kind.SHIP,
  Kind.EXPLOSION,
];

function drawEntity(
  ctx: CanvasRenderingContext2D,
  arena: { readonly width: number; readonly height: number },
  entity: RenderableEntity,
  state: PaintState,
): void {
  if (entity.kind === Kind.EXPLOSION) {
    paintExplosion(ctx, entity, state);
    return;
  }

  const x = lerp(entity.prevPos.x, entity.pos.x, state.alpha);
  const y = lerp(entity.prevPos.y, entity.pos.y, state.alpha);
  const angle = lerpAngle(entity.prevAngle, entity.angle, state.alpha);
  const margin = entity.radius * 1.4 + 24;

  for (const offsetX of [-arena.width, 0, arena.width]) {
    for (const offsetY of [-arena.height, 0, arena.height]) {
      const px = x + offsetX;
      const py = y + offsetY;
      if (px < -margin || px > arena.width + margin || py < -margin || py > arena.height + margin) {
        continue;
      }
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      paintByKind(ctx, entity, state);
      ctx.restore();
    }
  }
}

function drawEntities(
  ctx: CanvasRenderingContext2D,
  arena: { readonly width: number; readonly height: number },
  world: RenderWorld,
  state: PaintState,
): void {
  for (const kind of DRAW_ORDER) {
    for (const entity of world.ofKind(kind)) {
      if (entity.alive) drawEntity(ctx, arena, entity, state);
    }
  }
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  view: { readonly width: number; readonly height: number },
  world: RenderWorld,
  metrics: LoopMetrics,
  session: DrawSession | null,
): void {
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

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  view: { readonly width: number; readonly height: number },
  world: RenderWorld,
  alpha: number,
  metrics: LoopMetrics,
  now: number,
  sheets: Readonly<Record<string, LoadedSpriteSheet>>,
  session: DrawSession | null = null,
): void {
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
