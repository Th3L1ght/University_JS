/**
 * Система зіткнень (коло-коло). Ізольована від правил гри: лише знаходить пари,
 * що перетинаються, і нічого не змінює. Рішення про наслідки приймає World.
 */

import { wrappedDelta } from './arena.ts';
import type { Entity } from './entity.ts';

export interface CollisionWorld extends Iterable<Entity> {
  readonly width: number;
  readonly height: number;
}

/** Чи перетинаються кола двох сутностей з урахуванням "склеєних" країв арени. */
export function circlesOverlap(a: Entity, b: Entity, width: number, height: number): boolean {
  const dx = wrappedDelta(a.pos.x, b.pos.x, width);
  const dy = wrappedDelta(a.pos.y, b.pos.y, height);
  const reach = a.radius + b.radius;
  return dx * dx + dy * dy <= reach * reach;
}

export function findCollisions(world: CollisionWorld): Array<readonly [Entity, Entity]> {
  const candidates: Entity[] = [];
  for (const entity of world) {
    if (entity.alive && entity.collidable) candidates.push(entity);
  }

  const pairs: Array<readonly [Entity, Entity]> = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    if (!a) continue;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      if (!b) continue;
      if (circlesOverlap(a, b, world.width, world.height)) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}
