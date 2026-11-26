/**
 * Куля (або ракета, якщо до неї приєднано компонент homing). Нащадок Entity.
 * Самонаведення - не підклас, а компонент: див. behaviors.js.
 */

import { Entity, Kind } from './entity.js';

export class Bullet extends Entity {
  /**
   * @param {object} options
   * @param {import('./vector.js').Vector2} options.pos початкова позиція
   * @param {import('./vector.js').Vector2} options.vel початкова швидкість
   * @param {number} options.owner id сутності, що вистрілила (власні кулі її не зачіпають)
   * @param {number} options.damage шкода при влученні
   * @param {number} options.ttl час життя, секунди
   */
  constructor({ pos, vel, owner, damage, ttl }) {
    super({ kind: Kind.BULLET, x: pos.x, y: pos.y, angle: Math.atan2(vel.y, vel.x), radius: 3 });
    this.vel.copyFrom(vel);
    this.owner = owner;
    this.damage = damage;
    this.ttl = ttl;
  }

  update(dt) {
    super.update(dt);
    // Курс кулі завжди збігається з напрямком швидкості (важливо для ракети, що повертає).
    this.angle = Math.atan2(this.vel.y, this.vel.x);
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}
