/**
 * Вибух: візуальний ефект із короткоживучих частинок. Не бере участі в зіткненнях.
 */

import { TAU } from '../math.ts';
import { Entity, Kind, type BaseEntitySnapshot } from './entity.ts';

const PARTICLE_DRAG = 2;

export type ExplosionTint = 'rock' | 'ship';

export interface ExplosionParticle {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}

export interface ExplosionOptions {
  readonly x: number;
  readonly y: number;
  readonly rng: () => number;
  readonly count?: number;
  readonly speed?: number;
  readonly life?: number;
  readonly tint?: ExplosionTint;
}

export interface ExplosionSnapshot extends BaseEntitySnapshot {
  readonly kind: typeof Kind.EXPLOSION;
  readonly tint: ExplosionTint;
  readonly particles: readonly ExplosionParticle[];
}

export class Explosion extends Entity {
  tint: ExplosionTint;
  particles: ExplosionParticle[];

  constructor({ x, y, rng, count = 20, speed = 120, life = 0.8, tint = 'rock' }: ExplosionOptions) {
    super({ kind: Kind.EXPLOSION, x, y, radius: 0, collidable: false });
    this.tint = tint;
    this.particles = [];
    this.reset({ x, y, rng, count, speed, life, tint });
  }

  /** Повторно використовує масив і об'єкти частинок для ObjectPool без зайвих алокацій. */
  reset({ x, y, rng, count = 20, speed = 120, life = 0.8, tint = 'rock' }: ExplosionOptions): this {
    this.teleport(x, y);
    this.alive = count > 0;
    this.collidable = false;
    this.components = {};
    this.world = null;
    this.tint = tint;

    this.particles.length = count;
    for (let i = 0; i < count; i += 1) {
      const direction = rng() * TAU;
      const v = speed * (0.35 + rng() * 0.65);
      const lifetime = life * (0.6 + rng() * 0.4);
      const size = 1 + rng() * 2.2;
      const existing = this.particles[i];
      if (existing) {
        existing.x = x;
        existing.y = y;
        existing.prevX = x;
        existing.prevY = y;
        existing.vx = Math.cos(direction) * v;
        existing.vy = Math.sin(direction) * v;
        existing.life = lifetime;
        existing.maxLife = lifetime;
        existing.size = size;
      } else {
        this.particles[i] = {
          x,
          y,
          prevX: x,
          prevY: y,
          vx: Math.cos(direction) * v,
          vy: Math.sin(direction) * v,
          life: lifetime,
          maxLife: lifetime,
          size,
        };
      }
    }
    return this;
  }

  override update(dt: number): void {
    super.update(dt);
    const damping = Math.exp(-PARTICLE_DRAG * dt);
    let anyAlive = false;
    for (const p of this.particles) {
      p.prevX = p.x;
      p.prevY = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= damping;
      p.vy *= damping;
      p.life -= dt;
      if (p.life > 0) anyAlive = true;
    }
    this.alive = anyAlive;
  }

  override toSnapshot(): ExplosionSnapshot {
    return {
      ...super.toSnapshot(),
      kind: Kind.EXPLOSION,
      tint: this.tint,
      particles: this.particles.map((p) => ({ ...p })),
    };
  }

  static override fromSnapshot(data: ExplosionSnapshot): Explosion {
    const explosion = new Explosion({
      x: data.x,
      y: data.y,
      rng: () => 0,
      count: 0,
      tint: data.tint,
    });
    explosion.applyBaseSnapshot(data);
    explosion.particles = data.particles.map((p) => ({ ...p }));
    return explosion;
  }
}
