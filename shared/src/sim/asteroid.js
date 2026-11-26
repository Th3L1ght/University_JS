/**
 * Астероїд: дрейфує, обертається, має запас міцності й дає очки за знищення.
 * Нащадок Entity. Версія-"мисливець" - це той самий клас із компонентом homing.
 */

import { Entity, Kind } from './entity.js';
import { TAU, wrapAngle } from '../math.js';

/** Параметри за розміром: 3 - великий, 2 - середній, 1 - малий. */
export const ASTEROID_SIZES = Object.freeze({
  3: Object.freeze({ radius: 38, hp: 30, score: 50 }),
  2: Object.freeze({ radius: 24, hp: 20, score: 30 }),
  1: Object.freeze({ radius: 13, hp: 10, score: 20 }),
});

const SHAPE_VERTICES = 10;

export class Asteroid extends Entity {
  #hp;

  /**
   * @param {object} options
   * @param {number} options.x
   * @param {number} options.y
   * @param {number} options.vx
   * @param {number} options.vy
   * @param {1 | 2 | 3} [options.size]
   * @param {() => number} options.rng генератор випадкових чисел [0, 1): обов'язковий,
   *   щоб симуляція ніколи не звернулась до Math.random
   */
  constructor({ x, y, vx, vy, size = 3, rng }) {
    const config = ASTEROID_SIZES[size];
    super({ kind: Kind.ASTEROID, x, y, radius: config.radius });
    this.size = size;
    this.#hp = config.hp;
    this.vel.set(vx, vy);
    this.spin = (rng() - 0.5) * 2.4; // рад/с
    this.angle = wrapAngle(rng() * TAU);
    this.prevAngle = this.angle;
    // Нерівний контур: множники радіуса для кожної вершини (використовує render).
    this.shape = Array.from({ length: SHAPE_VERTICES }, () => 0.78 + rng() * 0.4);
  }

  get hp() {
    return this.#hp;
  }

  get score() {
    return ASTEROID_SIZES[this.size].score;
  }

  /** @returns {boolean} true, якщо астероїд зруйновано цим ударом */
  takeDamage(amount) {
    if (!this.alive || amount <= 0) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp > 0) return false;
    this.alive = false;
    return true;
  }

  update(dt) {
    super.update(dt);
    this.angle = wrapAngle(this.angle + this.spin * dt);
  }

  toSnapshot() {
    return {
      ...super.toSnapshot(),
      size: this.size,
      hp: this.#hp,
      spin: this.spin,
      shape: [...this.shape],
    };
  }

  static fromSnapshot(data) {
    const asteroid = new Asteroid({
      x: data.x,
      y: data.y,
      vx: data.vx,
      vy: data.vy,
      size: data.size,
      rng: () => 0,
    });
    asteroid.applyBaseSnapshot(data);
    asteroid.#hp = data.hp;
    asteroid.spin = data.spin;
    asteroid.shape = [...data.shape];
    return asteroid;
  }
}
