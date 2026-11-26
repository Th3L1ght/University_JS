/**
 * Астероїд: дрейфує, обертається, має запас міцності й дає очки за знищення.
 */

import { TAU, wrapAngle } from '../math.ts';
import { Entity, Kind, type BaseEntitySnapshot } from './entity.ts';
import { Vector2 } from './vector.ts';

export type AsteroidSize = 1 | 2 | 3;

export interface AsteroidSizeConfig {
  readonly radius: number;
  readonly hp: number;
  readonly score: number;
}

/** Параметри за розміром: 3 - великий, 2 - середній, 1 - малий. */
export const ASTEROID_SIZES: Readonly<Record<AsteroidSize, AsteroidSizeConfig>> = Object.freeze({
  3: Object.freeze({ radius: 38, hp: 30, score: 50 }),
  2: Object.freeze({ radius: 24, hp: 20, score: 30 }),
  1: Object.freeze({ radius: 13, hp: 10, score: 20 }),
});

export function isAsteroidSize(value: number): value is AsteroidSize {
  return value === 1 || value === 2 || value === 3;
}

const SHAPE_VERTICES = 10;

export interface AsteroidOptions {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly size?: AsteroidSize;
  readonly rng: () => number;
}

export interface AsteroidSnapshot extends BaseEntitySnapshot {
  readonly kind: typeof Kind.ASTEROID;
  readonly size: AsteroidSize;
  readonly hp: number;
  readonly spin: number;
  readonly shape: readonly number[];
}

export class Asteroid extends Entity {
  #hp: number;
  readonly size: AsteroidSize;
  spin: number;
  shape: number[];

  constructor({ x, y, vx, vy, size = 3, rng }: AsteroidOptions) {
    const config = ASTEROID_SIZES[size];
    super({ kind: Kind.ASTEROID, x, y, radius: config.radius });
    this.size = size;
    this.#hp = config.hp;
    this.vel = new Vector2(vx, vy);
    this.spin = (rng() - 0.5) * 2.4;
    this.angle = wrapAngle(rng() * TAU);
    this.prevAngle = this.angle;
    this.shape = Array.from({ length: SHAPE_VERTICES }, () => 0.78 + rng() * 0.4);
  }

  get hp(): number {
    return this.#hp;
  }

  get score(): number {
    return ASTEROID_SIZES[this.size].score;
  }

  /** @returns true, якщо астероїд зруйновано цим ударом */
  takeDamage(amount: number): boolean {
    if (!this.alive || amount <= 0) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp > 0) return false;
    this.alive = false;
    return true;
  }

  override update(dt: number): void {
    super.update(dt);
    this.angle = wrapAngle(this.angle + this.spin * dt);
  }

  override toSnapshot(): AsteroidSnapshot {
    return {
      ...super.toSnapshot(),
      kind: Kind.ASTEROID,
      size: this.size,
      hp: this.#hp,
      spin: this.spin,
      shape: [...this.shape],
    };
  }

  static override fromSnapshot(data: AsteroidSnapshot): Asteroid {
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
