/**
 * Хеш стану для перевірки детермінізму: FNV-1a (32 біти) від JSON-представлення знімка.
 * Однакові початкові дані й кроки мають давати однаковий хеш на будь-якій машині.
 */

/** @param {string} text @returns {string} 8 hex-символів */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Хеш повного стану світу (World#toSnapshot). */
export function worldHash(world) {
  return fnv1a(JSON.stringify(world.toSnapshot()));
}
