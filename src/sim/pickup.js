/**
 * Бонуси, що підбираються. Окремого класу немає: це звичайна Entity з компонентами
 * pickup (що робить) і lifetime (скільки лежить) - композиція замість підкласу.
 */

import { Entity, Kind } from './entity.js';
import { attachLifetime, attachPickup } from './behaviors.js';

/** Дані ефектів. Обробники - у behaviors.js (EFFECT_HANDLERS). */
export const PICKUP_EFFECTS = Object.freeze({
  heal: Object.freeze({ type: 'heal', amount: 35 }), // відновлює HP
  rapid: Object.freeze({ type: 'rapid', duration: 8 }), // скорострільність, секунди
});

const PICKUP_RADIUS = 14;
const PICKUP_LIFETIME = 14; // секунди, потім бонус зникає

/**
 * @param {number} x
 * @param {number} y
 * @param {keyof typeof PICKUP_EFFECTS} effectType
 */
export function createPickup(x, y, effectType) {
  const effect = PICKUP_EFFECTS[effectType];
  if (!effect) throw new Error(`Невідомий тип бонусу: ${effectType}`);
  const entity = new Entity({ kind: Kind.PICKUP, x, y, radius: PICKUP_RADIUS });
  attachPickup(entity, effect);
  attachLifetime(entity, PICKUP_LIFETIME);
  return entity;
}
