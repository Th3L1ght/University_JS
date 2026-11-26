/**
 * Хеш стану для перевірки детермінізму: FNV-1a (32 біти) від JSON-представлення знімка.
 */

import type { World } from './sim/world.ts';

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function worldHash(world: World): string {
  return fnv1a(JSON.stringify(world.toSnapshot()));
}
