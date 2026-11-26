/**
 * Система зіткнень (коло-коло) на базі SpatialHashGrid O(n).
 * Також експортує `findCollisionsNaive` O(n²) для верифікації еквівалентності й бенчмарків
 * та чисту функцію інтегрування `integrate`.
 */

import { wrappedDelta } from './arena.ts';
import type { Entity } from './entity.ts';
import { SpatialHashGrid } from './spatial_hash.ts';
import { Vector2, type Vec2Like } from './vector.ts';

export interface CollisionWorld extends Iterable<Entity> {
  readonly width: number;
  readonly height: number;
}

/** Чистий крок напівнеявного Ейлера для позиції: pos + vel * dt. */
export function integrate(pos: Vec2Like, vel: Vec2Like, dt: number): Vector2 {
  return new Vector2(pos.x + vel.x * dt, pos.y + vel.y * dt);
}

/** Чи перетинаються кола двох сутностей з урахуванням "склеєних" країв арени. */
export function circlesOverlap(a: Entity, b: Entity, width: number, height: number): boolean {
  const dx = wrappedDelta(a.pos.x, b.pos.x, width);
  const dy = wrappedDelta(a.pos.y, b.pos.y, height);
  const reach = a.radius + b.radius;
  return dx * dx + dy * dy <= reach * reach;
}

const sharedGrid = new SpatialHashGrid(96);
const scratchCandidates: Entity[] = [];

/** Пошук зіткнень за O(n) через SpatialHashGrid (без алокації проміжних списків). */
export function findCollisions(world: CollisionWorld): Array<readonly [Entity, Entity]> {
  scratchCandidates.length = 0;
  for (const entity of world) {
    if (entity.alive && entity.collidable) scratchCandidates.push(entity);
  }
  if (scratchCandidates.length < 2) return [];
  const pairs = sharedGrid.queryPairs(scratchCandidates, world.width, world.height);
  scratchCandidates.length = 0;
  return pairs;
}

/** Еталонний перебір O(n²) для тестів еквівалентності та порівняльних замірів. */
export function findCollisionsNaive(world: CollisionWorld): Array<readonly [Entity, Entity]> {
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
