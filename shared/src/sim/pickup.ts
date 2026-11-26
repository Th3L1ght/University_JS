/**
 * Бонуси, що підбираються. Окремого класу немає: це звичайна Entity з компонентами
 * pickup (що робить) і lifetime (скільки лежить) - композиція замість підкласу.
 */

import { attachLifetime, attachPickup } from './behaviors.ts';
import { Entity, Kind, type PickupEffect } from './entity.ts';

export type PickupEffectType = 'heal' | 'rapid';

/** Дані ефектів. Обробники - у behaviors.ts. */
export const PICKUP_EFFECTS: Readonly<Record<PickupEffectType, PickupEffect>> = Object.freeze({
  heal: Object.freeze({ type: 'heal', amount: 35 } as const),
  rapid: Object.freeze({ type: 'rapid', duration: 8 } as const),
});

export const PICKUP_EFFECT_TYPES: readonly PickupEffectType[] = Object.freeze(['heal', 'rapid']);

const PICKUP_RADIUS = 14;
const PICKUP_LIFETIME = 14;

export function createPickup(x: number, y: number, effectType: PickupEffectType): Entity {
  const effect = PICKUP_EFFECTS[effectType];
  const entity = new Entity({ kind: Kind.PICKUP, x, y, radius: PICKUP_RADIUS });
  attachPickup(entity, effect);
  attachLifetime(entity, PICKUP_LIFETIME);
  return entity;
}
