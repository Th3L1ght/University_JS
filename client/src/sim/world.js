/**
 * Світ: сховище сутностей на Map, один крок симуляції, правила гри (наслідки зіткнень, шкода,
 * вибухи, респаун, очки, поява астероїдів і бонусів) і шина подій.
 *
 * Шина подій: World успадковує EventTarget і диспатчить CustomEvent про ігрові події:
 *   fired         { shooter, bullet, missile }
 *   hit           { target, source, damage, destroyed }
 *   exploded      { entity, kind, size, x, y }
 *   pickup        { collector, pickup, effect }
 *   scoreChanged  { score, delta }
 * Симуляція нічого не знає про її споживачів (звук, HUD, мережа): вони самі підписуються.
 */

import { Kind } from './entity.js';
import { Vector2 } from './vector.js';
import { Asteroid } from './asteroid.js';
import { Explosion } from './explosion.js';
import { createPickup, PICKUP_EFFECTS } from './pickup.js';
import { applyPickup, attachHoming, runBehaviors } from './behaviors.js';
import { findCollisions } from './collision.js';
import { wrapEntity, wrappedDelta } from './arena.js';
import { createRng } from './rng.js';
import { TAU } from '../math.js';

export const WORLD_RULES = Object.freeze({
  initialAsteroids: 6,
  minAsteroids: 5, // нижче цього значення з'являються нові астероїди
  asteroidRefillDelay: 2.5, // с
  hunterChance: 0.3, // частка астероїдів-"мисливців" (з компонентом homing)
  hunter: Object.freeze({ turnRate: 0.55, range: 650, targetKinds: [Kind.SHIP] }),
  respawnDelay: 2, // с до відродження гравця
  respawnInvulnerability: 2, // с невразливості після відродження
  safePointCandidates: 32, // скільки точок перевіряти під час пошуку безпечного місця
  contactDamagePerSize: 10, // шкода судну від зіткнення з астероїдом: × розмір
  ramDamage: 15, // шкода астероїду від тарану судном
  pickupInterval: 9, // с між спробами створити бонус
  maxPickups: 2,
  bounce: 0.8, // пружність зіткнень
});

/** Межі для правил, що приходять ззовні (arena.json, параметри кімнати). */
const RULE_LIMITS = Object.freeze({
  initialAsteroids: [0, 40],
  minAsteroids: [0, 40],
  asteroidRefillDelay: [0.2, 60],
  hunterChance: [0, 1],
  respawnDelay: [0, 10],
  respawnInvulnerability: [0, 10],
  pickupInterval: [1, 120],
  maxPickups: [0, 10],
});

/**
 * Накладає перевірені перевизначення на WORLD_RULES. Невідомі ключі й нечислові значення
 * ігноруються, числа обмежуються безпечним діапазоном: дані з мережі не можуть зламати світ.
 */
export function mergeRules(...overrides) {
  const rules = { ...WORLD_RULES };
  for (const source of overrides) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, [min, max]] of Object.entries(RULE_LIMITS)) {
      const value = source[key];
      if (Number.isFinite(value)) rules[key] = Math.min(max, Math.max(min, value));
    }
  }
  return Object.freeze(rules);
}

export class World extends EventTarget {
  /** Сховище сутностей: Map<id, Entity>. Порядок обходу = порядок додавання. */
  #entities = new Map();
  #rules;
  #rng;
  #player = null;
  #respawnTimer = null; // секунди до відродження або null, якщо гравець живий
  #refillTimer;
  #pickupTimer;
  #score = 0;

  /**
   * @param {object} options
   * @param {number} options.width розмір арени, CSS-пікселі
   * @param {number} options.height
   * @param {number} [options.seed] seed детермінованого генератора
   * @param {object} [options.rules] перевизначення правил (arena.json + параметри кімнати)
   */
  constructor({ width, height, seed = 1, rules = {} }) {
    super();
    this.width = width;
    this.height = height;
    this.#rules = mergeRules(rules);
    this.#rng = createRng(seed);
    this.#refillTimer = this.#rules.asteroidRefillDelay;
    this.#pickupTimer = this.#rules.pickupInterval;
  }

  get rules() {
    return this.#rules;
  }

  get player() {
    return this.#player;
  }

  get score() {
    return this.#score;
  }

  /** Секунди до відродження гравця (0, якщо він живий). */
  get respawnIn() {
    return this.#respawnTimer ?? 0;
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
  }

  /** Диспатчить ігрову подію шини. */
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // --- Керування сутностями ---

  /** Додає сутність у світ. Не викликати з циклу, що ітерує сам світ. */
  spawn(entity) {
    this.#entities.set(entity.id, entity);
    entity.world = this;
    return entity;
  }

  /**
   * Відкладене видалення: лише позначає alive = false. Фізично сутність прибирається в кінці
   * кроку, тож безпечно викликати під час ітерації по світу.
   */
  despawn(id) {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  /** @returns {import('./entity.js').Entity | undefined} жива сутність за id */
  get(id) {
    const entity = this.#entities.get(id);
    return entity?.alive ? entity : undefined;
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  /** Усі сутності вказаного виду. */
  *ofKind(kind) {
    for (const entity of this.#entities.values()) {
      if (entity.kind === kind) yield entity;
    }
  }

  /** Реєструє судно гравця й додає його у світ. */
  setPlayer(ship) {
    this.#player = ship;
    this.spawn(ship);
  }

  /** Створює стартові астероїди подалі від центру арени, де з'являється гравець. */
  populate() {
    const cx = this.width / 2;
    const cy = this.height / 2;
    for (let i = 0; i < this.#rules.initialAsteroids; i += 1) {
      let x;
      let y;
      do {
        x = this.#rng() * this.width;
        y = this.#rng() * this.height;
      } while (Math.hypot(x - cx, y - cy) < 220);
      this.spawn(this.#createAsteroid({ x, y, size: 3 }));
    }
  }

  // --- Крок симуляції ---

  /**
   * @param {number} dt крок, секунди
   * @param {{ left: boolean, right: boolean, thrust: boolean }} input керування гравця
   */
  step(dt, input) {
    const player = this.#player;
    if (player?.alive) player.setControls(input);

    // Ці цикли лише змінюють наявні сутності й нічого не додають: Map безпечно ітерується.
    for (const entity of this.#entities.values()) {
      if (entity.alive) runBehaviors(entity, this, dt);
    }
    for (const entity of this.#entities.values()) {
      if (!entity.alive) continue;
      entity.update(dt);
      if (entity.kind !== Kind.EXPLOSION) wrapEntity(entity, this.width, this.height);
    }

    for (const [a, b] of findCollisions(this)) {
      if (a.alive && b.alive) this.#resolveCollision(a, b);
    }

    this.#updateSpawners(dt);
    this.#updateRespawn(dt);
    this.#sweep();
  }

  /** Прибирає мертві сутності. Ключі збираємо окремо: Map не змінюється під час обходу. */
  #sweep() {
    const dead = [];
    for (const entity of this.#entities.values()) {
      if (!entity.alive) dead.push(entity);
    }
    for (const entity of dead) {
      this.#entities.delete(entity.id);
      entity.world = null;
    }
  }

  // --- Правила зіткнень ---

  #resolveCollision(a, b) {
    const pick = (kindA, kindB) => {
      if (a.kind === kindA && b.kind === kindB) return [a, b];
      if (a.kind === kindB && b.kind === kindA) return [b, a];
      return null;
    };

    let pair = pick(Kind.BULLET, Kind.ASTEROID);
    if (pair) return this.#bulletHitsAsteroid(...pair);

    pair = pick(Kind.SHIP, Kind.ASTEROID);
    if (pair) return this.#shipHitsAsteroid(...pair);

    pair = pick(Kind.SHIP, Kind.PICKUP);
    if (pair) return this.#shipTakesPickup(...pair);

    if (a.kind === Kind.ASTEROID && b.kind === Kind.ASTEROID) return this.#bounce(a, b);
    return undefined;
  }

  #bulletHitsAsteroid(bullet, asteroid) {
    bullet.alive = false;
    const destroyed = asteroid.takeDamage(bullet.damage);
    this.emit('hit', { target: asteroid, source: bullet, damage: bullet.damage, destroyed });
    if (destroyed) this.#destroyAsteroid(asteroid);
  }

  #shipHitsAsteroid(ship, asteroid) {
    this.#bounce(ship, asteroid);
    if (ship.invulnerable > 0) return;

    const damage = this.#rules.contactDamagePerSize * asteroid.size;
    const shipDestroyed = ship.takeDamage(damage);
    this.emit('hit', { target: ship, source: asteroid, damage, destroyed: shipDestroyed });
    if (shipDestroyed) this.#destroyShip(ship);

    if (asteroid.takeDamage(this.#rules.ramDamage)) this.#destroyAsteroid(asteroid);
  }

  #shipTakesPickup(ship, pickup) {
    const { effect } = pickup.components.pickup;
    if (applyPickup(ship, pickup)) this.emit('pickup', { collector: ship, pickup, effect });
  }

  /** Пружне зіткнення двох кіл: маси пропорційні площі, розведення за перекриттям. */
  #bounce(a, b) {
    const dx = wrappedDelta(a.pos.x, b.pos.x, this.width);
    const dy = wrappedDelta(a.pos.y, b.pos.y, this.height);
    const distance = Math.hypot(dx, dy) || 1;
    const nx = dx / distance;
    const ny = dy / distance;

    const massA = a.radius * a.radius;
    const massB = b.radius * b.radius;
    const totalMass = massA + massB;

    // Розводимо кола. prevPos зсуваємо так само, щоб інтерполяція не "смикалась".
    const overlap = a.radius + b.radius - distance;
    if (overlap > 0) {
      const moveA = (overlap * massB) / totalMass;
      const moveB = (overlap * massA) / totalMass;
      a.pos.addScaledInPlace({ x: nx, y: ny }, -moveA);
      a.prevPos.addScaledInPlace({ x: nx, y: ny }, -moveA);
      b.pos.addScaledInPlace({ x: nx, y: ny }, moveB);
      b.prevPos.addScaledInPlace({ x: nx, y: ny }, moveB);
    }

    // Імпульс уздовж нормалі, лише якщо кола зближуються.
    const approach = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
    if (approach >= 0) return;
    const impulse = (-(1 + WORLD_RULES.bounce) * approach) / (1 / massA + 1 / massB);
    a.vel.addScaledInPlace({ x: nx, y: ny }, -impulse / massA);
    b.vel.addScaledInPlace({ x: nx, y: ny }, impulse / massB);
  }

  // --- Знищення, вибухи, очки ---

  #addScore(delta) {
    this.#score += delta;
    this.emit('scoreChanged', { score: this.#score, delta });
  }

  #destroyAsteroid(asteroid) {
    const { x, y } = asteroid.pos;
    this.emit('exploded', { entity: asteroid, kind: Kind.ASTEROID, size: asteroid.size, x, y });
    this.#addScore(asteroid.score);
    this.spawn(
      new Explosion({
        x,
        y,
        rng: this.#rng,
        count: 6 + 5 * asteroid.size,
        speed: 40 + 35 * asteroid.size,
        life: 0.45 + 0.2 * asteroid.size,
        tint: 'rock',
      }),
    );

    if (asteroid.size > 1) {
      const hunter = Boolean(asteroid.components.homing);
      const heading = this.#rng() * TAU;
      for (const direction of [heading, heading + Math.PI]) {
        const size = asteroid.size - 1;
        const speed = 45 + this.#rng() * 45;
        const child = this.#createAsteroid({
          x: x + Math.cos(direction) * asteroid.radius * 0.5,
          y: y + Math.sin(direction) * asteroid.radius * 0.5,
          vx: asteroid.vel.x * 0.5 + Math.cos(direction) * speed,
          vy: asteroid.vel.y * 0.5 + Math.sin(direction) * speed,
          size,
          hunter,
        });
        this.spawn(child);
      }
    }
  }

  #destroyShip(ship) {
    const { x, y } = ship.pos;
    this.emit('exploded', { entity: ship, kind: Kind.SHIP, size: 0, x, y });
    this.spawn(
      new Explosion({
        x,
        y,
        rng: this.#rng,
        count: 42,
        speed: 240,
        life: 1.1,
        tint: 'ship',
      }),
    );
    this.#respawnTimer = this.#rules.respawnDelay;
  }

  // --- Поява та відродження ---

  /** hunter: undefined - вирішує генератор за hunterChance; true/false - примусово. */
  #createAsteroid({ x, y, vx, vy, size, hunter }) {
    let velocityX = vx;
    let velocityY = vy;
    if (velocityX === undefined || velocityY === undefined) {
      const direction = this.#rng() * TAU;
      const speed = 30 + this.#rng() * 50;
      velocityX = Math.cos(direction) * speed;
      velocityY = Math.sin(direction) * speed;
    }
    const asteroid = new Asteroid({ x, y, vx: velocityX, vy: velocityY, size, rng: this.#rng });
    const isHunter = hunter ?? this.#rng() < this.#rules.hunterChance;
    if (isHunter) attachHoming(asteroid, this.#rules.hunter);
    return asteroid;
  }

  #countOf(kind) {
    let count = 0;
    for (const entity of this.ofKind(kind)) if (entity.alive) count += 1;
    return count;
  }

  #updateSpawners(dt) {
    // Нові астероїди виходять із випадкового краю арени.
    if (this.#countOf(Kind.ASTEROID) < this.#rules.minAsteroids) {
      this.#refillTimer -= dt;
      if (this.#refillTimer <= 0) {
        this.#refillTimer = this.#rules.asteroidRefillDelay;
        const onVerticalEdge = this.#rng() < 0.5;
        const x = onVerticalEdge ? (this.#rng() < 0.5 ? 0 : this.width) : this.#rng() * this.width;
        const y = onVerticalEdge ? this.#rng() * this.height : this.#rng() < 0.5 ? 0 : this.height;
        this.spawn(this.#createAsteroid({ x, y, size: 3 }));
      }
    } else {
      this.#refillTimer = this.#rules.asteroidRefillDelay;
    }

    this.#pickupTimer -= dt;
    if (this.#pickupTimer <= 0) {
      this.#pickupTimer = this.#rules.pickupInterval;
      if (this.#countOf(Kind.PICKUP) < this.#rules.maxPickups) {
        const types = Object.keys(PICKUP_EFFECTS);
        const type = types[Math.floor(this.#rng() * types.length)];
        const margin = 60;
        const x = margin + this.#rng() * Math.max(1, this.width - 2 * margin);
        const y = margin + this.#rng() * Math.max(1, this.height - 2 * margin);
        this.spawn(createPickup(x, y, type));
      }
    }
  }

  #updateRespawn(dt) {
    if (this.#respawnTimer === null || !this.#player) return;
    this.#respawnTimer -= dt;
    if (this.#respawnTimer > 0) return;

    this.#respawnTimer = null;
    const point = this.#findSafePoint();
    this.#player.respawnAt(point.x, point.y, this.#rules.respawnInvulnerability);
    this.spawn(this.#player);
  }

  /** Серед кількох випадкових точок бере ту, що найдалі від усіх перешкод. */
  #findSafePoint() {
    const margin = 60;
    let best = new Vector2(this.width / 2, this.height / 2);
    let bestClearance = -Infinity;

    for (let i = 0; i < this.#rules.safePointCandidates; i += 1) {
      const x = margin + this.#rng() * Math.max(1, this.width - 2 * margin);
      const y = margin + this.#rng() * Math.max(1, this.height - 2 * margin);
      let clearance = Infinity;
      for (const entity of this.#entities.values()) {
        if (!entity.alive || !entity.collidable || entity === this.#player) continue;
        const dx = wrappedDelta(x, entity.pos.x, this.width);
        const dy = wrappedDelta(y, entity.pos.y, this.height);
        clearance = Math.min(clearance, Math.hypot(dx, dy) - entity.radius);
      }
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = new Vector2(x, y);
      }
    }
    return best;
  }
}
