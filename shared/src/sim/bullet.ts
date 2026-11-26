/**
 * Куля (або ракета, якщо до неї приєднано компонент homing). Нащадок Entity.
 */

import type { EntityId } from '../types.ts';
import { Entity, Kind, type BaseEntitySnapshot } from './entity.ts';
import { Vector2, type Vec2Like } from './vector.ts';

export interface BulletOptions {
  readonly pos: Vec2Like;
  readonly vel: Vec2Like;
  readonly owner: EntityId;
  readonly damage: number;
  readonly ttl: number;
}

export interface BulletSnapshot extends BaseEntitySnapshot {
  readonly kind: typeof Kind.BULLET;
  readonly owner: EntityId;
  readonly damage: number;
  readonly ttl: number;
}

export class Bullet extends Entity {
  owner: EntityId;
  damage: number;
  ttl: number;

  constructor({ pos, vel, owner, damage, ttl }: BulletOptions) {
    super({ kind: Kind.BULLET, x: pos.x, y: pos.y, angle: Math.atan2(vel.y, vel.x), radius: 3 });
    this.vel = Vector2.from(vel);
    this.owner = owner;
    this.damage = damage;
    this.ttl = ttl;
  }

  /** Скидає стан для повторного використання з ObjectPool (стабільна форма V8 Hidden Class). */
  reset({ pos, vel, owner, damage, ttl }: BulletOptions): this {
    const start = Vector2.from(pos);
    this.pos = start;
    this.prevPos = start;
    this.vel = Vector2.from(vel);
    const heading = Math.atan2(vel.y, vel.x);
    this.angle = heading;
    this.prevAngle = heading;
    this.radius = 3;
    this.alive = true;
    this.collidable = true;
    this.components = {};
    this.world = null;
    this.owner = owner;
    this.damage = damage;
    this.ttl = ttl;
    return this;
  }

  override update(dt: number): void {
    super.update(dt);
    this.angle = Math.atan2(this.vel.y, this.vel.x);
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }

  override toSnapshot(): BulletSnapshot {
    return {
      ...super.toSnapshot(),
      kind: Kind.BULLET,
      owner: this.owner,
      damage: this.damage,
      ttl: this.ttl,
    };
  }

  static override fromSnapshot(data: BulletSnapshot): Bullet {
    const bullet = new Bullet({
      pos: { x: data.x, y: data.y },
      vel: { x: data.vx, y: data.vy },
      owner: data.owner,
      damage: data.damage,
      ttl: data.ttl,
    });
    return bullet.applyBaseSnapshot(data);
  }
}
