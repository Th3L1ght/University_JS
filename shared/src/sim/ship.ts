/**
 * Судно гравця. Нащадок Entity (один рівень успадкування).
 */

import { wrapAngle } from '../math.ts';
import type { EntityId } from '../types.ts';
import { attachHoming } from './behaviors.ts';
import { Bullet } from './bullet.ts';
import { Entity, Kind, type BaseEntitySnapshot } from './entity.ts';
import { Vector2 } from './vector.ts';

export const SHIP_PARAMS = Object.freeze({
  turnRate: 3.4,
  thrustAccel: 420,
  drag: 0.75,
  maxSpeed: 480,
  maxHp: 100,
  radius: 14,
  noseOffset: 18,
  fireInterval: 0.18,
  rapidFireInterval: 0.07,
  bulletSpeed: 640,
  bulletDamage: 10,
  bulletTtl: 1.1,
  missileInterval: 1.1,
  missileSpeed: 380,
  missileDamage: 25,
  missileTtl: 3.2,
  missileTurnRate: 3.6,
  missileRange: 560,
  hitInvulnerability: 0.6,
});

export type ShipParams = typeof SHIP_PARAMS;

export interface Controls {
  readonly thrust: boolean;
  readonly turn: number;
  readonly fire: boolean;
  readonly missile: boolean;
}

export interface RawControlsInput {
  readonly thrust?: boolean;
  readonly turn?: number;
  readonly left?: boolean;
  readonly right?: boolean;
  readonly fire?: boolean;
  readonly missile?: boolean;
}

/** Керування судном за один крок: turn ∈ [-1, 1] (праворуч > 0), решта - прапорці. */
export const IDLE_CONTROLS: Controls = Object.freeze({
  thrust: false,
  turn: 0,
  fire: false,
  missile: false,
});

/**
 * Приводить будь-який вхід до канонічного вигляду. Приймає і старий формат { left, right, thrust },
 * і новий { thrust, turn, fire, missile }. Значення обмежуються: turn - до [-1, 1].
 */
export function normalizeControls(input?: RawControlsInput | null): Controls {
  if (!input) return IDLE_CONTROLS;
  const rawTurn =
    typeof input.turn === 'number' && Number.isFinite(input.turn)
      ? input.turn
      : (input.right ? 1 : 0) - (input.left ? 1 : 0);
  return {
    thrust: Boolean(input.thrust),
    turn: Math.min(1, Math.max(-1, rawTurn)),
    fire: Boolean(input.fire),
    missile: Boolean(input.missile),
  };
}

export interface ShipOptions {
  readonly x?: number;
  readonly y?: number;
  readonly params?: ShipParams;
}

export interface ShipSnapshot extends BaseEntitySnapshot {
  readonly kind: typeof Kind.SHIP;
  readonly hp: number;
  readonly thrust: number;
  readonly fireCooldown: number;
  readonly missileCooldown: number;
  readonly invulnerable: number;
  readonly buffs: readonly (readonly [string, number])[];
  readonly controls: Controls;
}

export interface ShipPatchSnapshot {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly vx?: number;
  readonly vy?: number;
  readonly angle: number;
  readonly alive: boolean;
  readonly hp?: number;
  readonly thrust?: boolean | number;
  readonly invulnerable?: number;
  readonly fireCooldown?: number;
  readonly missileCooldown?: number;
  readonly buffs?: readonly (readonly [string, number])[];
  readonly controls?: RawControlsInput;
  readonly respawnTimer?: number | null;
}

export class Ship extends Entity {
  #hp: number;
  #fireCooldown = 0;
  #missileCooldown = 0;
  #invulnerable = 0;
  #buffs = new Map<string, number>();

  readonly params: ShipParams;
  controls: Controls;
  thrust: number;

  constructor({ x = 0, y = 0, params = SHIP_PARAMS }: ShipOptions = {}) {
    super({ kind: Kind.SHIP, x, y, angle: -Math.PI / 2, radius: params.radius });
    this.params = params;
    this.#hp = params.maxHp;
    this.controls = IDLE_CONTROLS;
    this.thrust = 0;

    this.fire = this.fire.bind(this);
    this.fireMissile = this.fireMissile.bind(this);
  }

  get hp(): number {
    return this.#hp;
  }

  /** Залишок невразливості, секунди (> 0 - судно не отримує шкоди). */
  get invulnerable(): number {
    return this.#invulnerable;
  }

  /** Залишок перезарядки основної зброї, секунди. */
  get fireCooldown(): number {
    return this.#fireCooldown;
  }

  *activeBuffs(): Generator<readonly [string, number]> {
    yield* this.#buffs;
  }

  hasBuff(name: string): boolean {
    return this.#buffs.has(name);
  }

  buffRemaining(name: string): number {
    return this.#buffs.get(name) ?? 0;
  }

  addBuff(name: string, duration: number): void {
    this.#buffs.set(name, Math.max(duration, this.#buffs.get(name) ?? 0));
  }

  heal(amount: number): void {
    if (!this.alive || amount <= 0) return;
    this.#hp = Math.min(this.params.maxHp, this.#hp + amount);
  }

  grantInvulnerability(seconds: number): void {
    this.#invulnerable = Math.max(this.#invulnerable, seconds);
  }

  /** @returns true, якщо судно знищено цим ударом */
  takeDamage(amount: number): boolean {
    if (!this.alive || this.#invulnerable > 0 || amount <= 0) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) {
      this.alive = false;
      return true;
    }
    this.#invulnerable = this.params.hitInvulnerability;
    return false;
  }

  respawnAt(x: number, y: number, invulnerableSeconds: number): void {
    this.#hp = this.params.maxHp;
    this.alive = true;
    this.vel = Vector2.ZERO;
    this.angle = -Math.PI / 2;
    this.prevAngle = this.angle;
    this.controls = IDLE_CONTROLS;
    this.thrust = 0;
    this.#fireCooldown = 0;
    this.#missileCooldown = 0;
    this.#invulnerable = invulnerableSeconds;
    this.#buffs.clear();
    this.teleport(x, y);
  }

  setControls(controls: RawControlsInput): void {
    this.controls = normalizeControls(controls);
  }

  override update(dt: number): void {
    this.savePrev();
    const { turnRate, thrustAccel, drag, maxSpeed } = this.params;

    this.angle = wrapAngle(this.angle + this.controls.turn * turnRate * dt);

    this.thrust = this.controls.thrust ? 1 : 0;
    let nextVel = this.vel;
    if (this.thrust) nextVel = nextVel.add(Vector2.fromAngle(this.angle, thrustAccel * dt));

    nextVel = nextVel.scale(Math.exp(-drag * dt));
    const speed = nextVel.length();
    if (speed > maxSpeed) nextVel = nextVel.scale(maxSpeed / speed);
    this.vel = nextVel;

    this.pos = this.pos.addScaled(this.vel, dt);

    this.#fireCooldown = Math.max(0, this.#fireCooldown - dt);
    this.#missileCooldown = Math.max(0, this.#missileCooldown - dt);
    this.#invulnerable = Math.max(0, this.#invulnerable - dt);
    for (const [name, remaining] of this.#buffs) {
      if (remaining - dt <= 0) this.#buffs.delete(name);
      else this.#buffs.set(name, remaining - dt);
    }
  }

  fire(): Bullet | null {
    if (!this.alive || !this.world || this.#fireCooldown > 0) return null;
    const p = this.params;
    this.#fireCooldown = this.hasBuff('rapid') ? p.rapidFireInterval : p.fireInterval;

    const direction = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: this.pos.add(direction.scale(p.noseOffset)),
      vel: this.vel.add(direction.scale(p.bulletSpeed)),
      owner: this.id,
      damage: p.bulletDamage,
      ttl: p.bulletTtl,
    });
    this.world.spawn(bullet);
    this.world.emit('fired', { shooter: this, bullet, missile: false });
    return bullet;
  }

  fireMissile(): Bullet | null {
    if (!this.alive || !this.world || this.#missileCooldown > 0) return null;
    const p = this.params;
    this.#missileCooldown = p.missileInterval;

    const direction = Vector2.fromAngle(this.angle);
    const missile = new Bullet({
      pos: this.pos.add(direction.scale(p.noseOffset)),
      vel: this.vel.scale(0.3).add(direction.scale(p.missileSpeed)),
      owner: this.id,
      damage: p.missileDamage,
      ttl: p.missileTtl,
    });
    attachHoming(missile, {
      turnRate: p.missileTurnRate,
      range: p.missileRange,
      targetKinds: [Kind.ASTEROID],
    });
    this.world.spawn(missile);
    this.world.emit('fired', { shooter: this, bullet: missile, missile: true });
    return missile;
  }

  override toSnapshot(): ShipSnapshot {
    return {
      ...super.toSnapshot(),
      kind: Kind.SHIP,
      hp: this.#hp,
      thrust: this.thrust,
      fireCooldown: this.#fireCooldown,
      missileCooldown: this.#missileCooldown,
      invulnerable: this.#invulnerable,
      buffs: [...this.#buffs],
      controls: { ...this.controls },
    };
  }

  applySnapshot(data: ShipPatchSnapshot): this {
    this.applyBaseSnapshot({
      id: data.id,
      x: data.x,
      y: data.y,
      vx: data.vx ?? 0,
      vy: data.vy ?? 0,
      angle: data.angle,
      alive: data.alive,
      components: {},
    });
    this.#hp = data.hp ?? this.params.maxHp;
    this.thrust = data.thrust ? 1 : 0;
    this.#fireCooldown = data.fireCooldown ?? 0;
    this.#missileCooldown = data.missileCooldown ?? 0;
    this.#invulnerable = data.invulnerable ?? 0;
    this.#buffs = new Map(data.buffs ?? []);
    this.controls = data.controls ? normalizeControls(data.controls) : IDLE_CONTROLS;
    return this;
  }

  static override fromSnapshot(data: ShipPatchSnapshot, params: ShipParams = SHIP_PARAMS): Ship {
    return new Ship({ x: data.x, y: data.y, params }).applySnapshot(data);
  }
}
