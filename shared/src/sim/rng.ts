/**
 * Детермінований генератор випадкових чисел mulberry32.
 * Симуляція не використовує Math.random: однаковий seed дає однаковий світ.
 */

export interface Rng {
  (): number;
  getState(): number;
  setState(state: number): void;
}

export function createRng(seed: number): Rng {
  let state = seed | 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.getState = (): number => state;
  next.setState = (value: number): void => {
    state = value | 0;
  };
  return next;
}
