/**
 * Детермінований генератор випадкових чисел mulberry32.
 * Симуляція не використовує Math.random: однаковий seed дає однаковий світ.
 *
 * @param {number} seed
 * @returns {() => number} функція, що повертає число з [0, 1)
 */
export function createRng(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
