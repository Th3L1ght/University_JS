/**
 * Композиція поведінок: behavior-as-data.
 *
 * Поведінка - це звичайний об'єкт-дані в `entity.components.<ім'я>`, а логіка живе в системі
 * (runBehaviors) і не прив'язана до класу сутності. Тому самонаведення можна приєднати і до
 * кулі, і до астероїда без підкласів на кшталт HomingBullet чи HomingAsteroid, а підбір бонусу -
 * до будь-якої сутності.
 *
 * Компоненти:
 *   homing   { turnRate, range, targetKinds }   - плавно повертає вектор швидкості до цілі
 *   pickup   { effect }                         - сутність підбирається кораблем при зіткненні
 *   lifetime { remaining }                      - сутність зникає за вказаний час
 */

import { clamp, shortestAngleDelta } from '../math.js';
import { wrappedDelta } from './arena.js';

// --- Приєднання компонентів ---

/**
 * @param {import('./entity.js').Entity} entity
 * @param {{ turnRate?: number, range?: number, targetKinds: string[] }} options
 */
export function attachHoming(entity, options) {
  entity.components.homing = { turnRate: 3, range: 500, ...options };
  return entity;
}

/** @param {{ type: string }} effect дані ефекту, див. PICKUP_EFFECTS у pickup.js */
export function attachPickup(entity, effect) {
  entity.components.pickup = { effect: { ...effect } };
  return entity;
}

export function attachLifetime(entity, seconds) {
  entity.components.lifetime = { remaining: seconds };
  return entity;
}

// --- Системи ---

/**
 * Повертає вектор швидкості сутності до найближчої цілі в межах `range`, не більше ніж на
 * `turnRate * dt` радіанів за крок. Модуль швидкості не змінюється.
 */
function steerHoming(entity, homing, world, dt) {
  let bestDx = 0;
  let bestDy = 0;
  let bestDistSq = homing.range * homing.range;
  let found = false;

  for (const target of world) {
    if (!target.alive || target === entity || !homing.targetKinds.includes(target.kind)) continue;
    const dx = wrappedDelta(entity.pos.x, target.pos.x, world.width);
    const dy = wrappedDelta(entity.pos.y, target.pos.y, world.height);
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestDx = dx;
      bestDy = dy;
      found = true;
    }
  }
  if (!found) return;

  const speed = entity.vel.length();
  if (speed === 0) return;

  const heading = Math.atan2(entity.vel.y, entity.vel.x);
  const wanted = shortestAngleDelta(heading, Math.atan2(bestDy, bestDx));
  const maxTurn = homing.turnRate * dt;
  const newHeading = heading + clamp(wanted, -maxTurn, maxTurn);
  entity.vel.set(Math.cos(newHeading) * speed, Math.sin(newHeading) * speed);
}

/** Виконує всі приєднані компоненти сутності. Викликається World.step перед update. */
export function runBehaviors(entity, world, dt) {
  const { lifetime, homing } = entity.components;

  if (lifetime) {
    lifetime.remaining -= dt;
    if (lifetime.remaining <= 0) {
      entity.alive = false;
      return;
    }
  }
  if (homing) steerHoming(entity, homing, world, dt);
}

// --- Ефекти бонусів ---

/** Обробники ефектів: тип -> (збирач, дані ефекту). Новий бонус = новий запис, без підкласів. */
const EFFECT_HANDLERS = {
  heal: (collector, effect) => collector.heal(effect.amount),
  rapid: (collector, effect) => collector.addBuff('rapid', effect.duration),
};

/**
 * Застосовує ефект бонусу до збирача (корабля) і гасить бонус.
 * @returns {boolean} true, якщо ефект застосовано
 */
export function applyPickup(collector, pickup) {
  const component = pickup.components.pickup;
  if (!component || !pickup.alive) return false;
  const handler = EFFECT_HANDLERS[component.effect.type];
  if (!handler) return false;
  handler(collector, component.effect);
  pickup.alive = false;
  return true;
}
