/**
 * Вибух: візуальний ефект із короткоживучих частинок. Не бере участі в зіткненнях.
 * Нащадок Entity. Частинки зберігають попередню позицію для інтерполяції в render.
 */

import { Entity, Kind } from './entity.js';
import { TAU } from '../math.js';

const PARTICLE_DRAG = 2; // 1/с: частинки гальмують експоненційно

export class Explosion extends Entity {
  /**
   * @param {object} options
   * @param {number} options.x
   * @param {number} options.y
   * @param {() => number} options.rng генератор випадкових чисел [0, 1)
   * @param {number} [options.count] кількість частинок
   * @param {number} [options.speed] максимальна початкова швидкість, пкс/с
   * @param {number} [options.life] максимальний час життя частинки, секунди
   * @param {'rock' | 'ship'} [options.tint] палітра для render
   */
  constructor({ x, y, rng, count = 20, speed = 120, life = 0.8, tint = 'rock' }) {
    super({ kind: Kind.EXPLOSION, x, y, radius: 0, collidable: false });
    this.tint = tint;
    this.particles = Array.from({ length: count }, () => {
      const direction = rng() * TAU;
      const v = speed * (0.35 + rng() * 0.65);
      const lifetime = life * (0.6 + rng() * 0.4);
      return {
        x,
        y,
        prevX: x,
        prevY: y,
        vx: Math.cos(direction) * v,
        vy: Math.sin(direction) * v,
        life: lifetime,
        maxLife: lifetime,
        size: 1 + rng() * 2.2,
      };
    });
  }

  update(dt) {
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

  toSnapshot() {
    return {
      ...super.toSnapshot(),
      tint: this.tint,
      particles: this.particles.map((p) => ({ ...p })),
    };
  }

  static fromSnapshot(data) {
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
