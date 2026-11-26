/**
 * Судно гравця. Нащадок Entity (один рівень успадкування).
 *
 * Фізика - з Лаби №1 (напівнеявний Ейлер, експоненційний опір, стеля швидкості), але тепер на
 * Vector2. Здоров'я приватне: змінити його можна лише через takeDamage і heal.
 *
 * Важливо про `this`: fire і fireMissile прив'язуються до екземпляра в конструкторі
 * (див. розділ про втрату контексту в README), тому їх безпечно передавати як колбеки.
 */

import { Entity, Kind } from './entity.js';
import { Vector2 } from './vector.js';
import { Bullet } from './bullet.js';
import { attachHoming } from './behaviors.js';
import { wrapAngle } from '../math.js';

export const SHIP_PARAMS = Object.freeze({
  turnRate: 3.4, // рад/с
  thrustAccel: 420, // пкс/с²
  drag: 0.75, // 1/с
  maxSpeed: 480, // пкс/с
  maxHp: 100,
  radius: 14,
  noseOffset: 18, // відстань від центру до носа, звідки вилітають кулі
  fireInterval: 0.18, // с між пострілами
  rapidFireInterval: 0.07, // с між пострілами з бонусом rapid
  bulletSpeed: 640, // пкс/с відносно судна
  bulletDamage: 10,
  bulletTtl: 1.1, // с
  missileInterval: 1.1, // с між пусками ракет
  missileSpeed: 380,
  missileDamage: 25,
  missileTtl: 3.2,
  missileTurnRate: 3.6, // рад/с
  missileRange: 560, // пкс: дальність захоплення цілі
  hitInvulnerability: 0.6, // с невразливості після влучання
});

const IDLE_CONTROLS = Object.freeze({ left: false, right: false, thrust: false });

export class Ship extends Entity {
  #hp;
  #fireCooldown = 0;
  #missileCooldown = 0;
  #invulnerable = 0;
  #buffs = new Map(); // назва бонусу -> залишок часу, с

  /**
   * @param {object} [options]
   * @param {number} [options.x]
   * @param {number} [options.y]
   * @param {typeof SHIP_PARAMS} [options.params]
   */
  constructor({ x = 0, y = 0, params = SHIP_PARAMS } = {}) {
    super({ kind: Kind.SHIP, x, y, angle: -Math.PI / 2, radius: params.radius });
    this.params = params;
    this.#hp = params.maxHp;
    this.controls = IDLE_CONTROLS;
    this.thrust = 0; // 0 або 1: чи працює двигун (для полум'я в render)

    // Прив'язка контексту: без неї `const f = ship.fire; f()` падає (this === undefined),
    // а `window.addEventListener('keydown', ship.fire)` мовчки нічого не робить (this === window).
    this.fire = this.fire.bind(this);
    this.fireMissile = this.fireMissile.bind(this);
  }

  get hp() {
    return this.#hp;
  }

  /** Залишок невразливості, секунди (> 0 - судно не отримує шкоди). */
  get invulnerable() {
    return this.#invulnerable;
  }

  /** @returns {Generator<[string, number]>} пари [назва бонусу, залишок секунд] */
  *activeBuffs() {
    yield* this.#buffs;
  }

  hasBuff(name) {
    return this.#buffs.has(name);
  }

  /** Додає або продовжує бонус до `duration` секунд. */
  addBuff(name, duration) {
    this.#buffs.set(name, Math.max(duration, this.#buffs.get(name) ?? 0));
  }

  heal(amount) {
    if (!this.alive || amount <= 0) return;
    this.#hp = Math.min(this.params.maxHp, this.#hp + amount);
  }

  grantInvulnerability(seconds) {
    this.#invulnerable = Math.max(this.#invulnerable, seconds);
  }

  /** @returns {boolean} true, якщо судно знищено цим ударом */
  takeDamage(amount) {
    if (!this.alive || this.#invulnerable > 0 || amount <= 0) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) {
      this.alive = false;
      return true;
    }
    this.#invulnerable = this.params.hitInvulnerability;
    return false;
  }

  /** Повертає знищене судно в гру: повне HP, нуль швидкості, тимчасова невразливість. */
  respawnAt(x, y, invulnerableSeconds) {
    this.#hp = this.params.maxHp;
    this.alive = true;
    this.vel.set(0, 0);
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

  /** @param {{ left: boolean, right: boolean, thrust: boolean }} controls */
  setControls(controls) {
    this.controls = controls;
  }

  update(dt) {
    this.savePrev();
    const { turnRate, thrustAccel, drag, maxSpeed } = this.params;

    const turn = (this.controls.right ? 1 : 0) - (this.controls.left ? 1 : 0);
    this.angle = wrapAngle(this.angle + turn * turnRate * dt);

    this.thrust = this.controls.thrust ? 1 : 0;
    if (this.thrust) this.vel.addInPlace(Vector2.fromAngle(this.angle, thrustAccel * dt));

    // Експоненційне згасання v *= e^(-drag*dt): не залежить від розміру кроку.
    this.vel.scaleInPlace(Math.exp(-drag * dt));
    const speed = this.vel.length();
    if (speed > maxSpeed) this.vel.scaleInPlace(maxSpeed / speed);

    this.pos.addScaledInPlace(this.vel, dt);

    this.#fireCooldown = Math.max(0, this.#fireCooldown - dt);
    this.#missileCooldown = Math.max(0, this.#missileCooldown - dt);
    this.#invulnerable = Math.max(0, this.#invulnerable - dt);
    for (const [name, remaining] of this.#buffs) {
      if (remaining - dt <= 0) this.#buffs.delete(name);
      else this.#buffs.set(name, remaining - dt);
    }
  }

  /**
   * Постріл кулею з носа з урахуванням кута й власної швидкості судна.
   * @returns {Bullet | null} нова куля або null (судно знищене, не в світі, триває перезарядка)
   */
  fire() {
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

  /**
   * Альтернативний вогонь: ракета з самонаведенням на астероїди.
   * Це та сама Bullet, до якої приєднано компонент homing - без окремого підкласу.
   * @returns {Bullet | null}
   */
  fireMissile() {
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
}
