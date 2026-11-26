/**
 * Система зіткнень (коло-коло). Ізольована від правил гри: лише знаходить пари,
 * що перетинаються, і нічого не змінює. Рішення про наслідки приймає World.
 *
 * Зараз - повний перебір O(n²) (для десятків об'єктів достатньо). Контракт
 * `findCollisions(world) -> Array<[a, b]>` дозволяє замінити реалізацію на просторовий хеш
 * (spatial hash), не чіпаючи World.
 */

import { wrappedDelta } from './arena.js';

/**
 * Чи перетинаються кола двох сутностей з урахуванням "склеєних" країв арени.
 * @param {import('./entity.js').Entity} a
 * @param {import('./entity.js').Entity} b
 * @param {number} width
 * @param {number} height
 */
export function circlesOverlap(a, b, width, height) {
  const dx = wrappedDelta(a.pos.x, b.pos.x, width);
  const dy = wrappedDelta(a.pos.y, b.pos.y, height);
  const reach = a.radius + b.radius;
  return dx * dx + dy * dy <= reach * reach;
}

/**
 * @param {{ width: number, height: number } & Iterable<import('./entity.js').Entity>} world
 * @returns {Array<[import('./entity.js').Entity, import('./entity.js').Entity]>}
 */
export function findCollisions(world) {
  const candidates = [];
  for (const entity of world) {
    if (entity.alive && entity.collidable) candidates.push(entity);
  }

  const pairs = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (circlesOverlap(candidates[i], candidates[j], world.width, world.height)) {
        pairs.push([candidates[i], candidates[j]]);
      }
    }
  }
  return pairs;
}
