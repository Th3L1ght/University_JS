/**
 * Світ: сховище сутностей на Map, один крок симуляції, правила гри (наслідки зіткнень, шкода,
 * вибухи, респаун, очки, поява астероїдів і бонусів) і шина подій.
 *
 * Модуль живе в пакеті @dogfight/shared і виконується однаково на клієнті (прогноз, офлайн-режим)
 * та на сервері (авторитативний стан). Тому він детермінований:
 *   - немає Math.random і Date.now: уся випадковість іде з seeded-генератора mulberry32;
 *   - крок симуляції отримує фіксований dt ззовні;
 *   - id сутностей видає сам світ, порядок обходу Map = порядок додавання;
 *   - немає залежностей від DOM, Canvas чи node:* (лише EventTarget/CustomEvent, що є всюди).
 *
 * Гравці. Світ підтримує кілька гравців (addPlayer/removePlayer/setInput). Режим однієї гри
 * (офлайн) лишився: setPlayer(ship) + step(dt, controls) працюють із "головним" гравцем.
 *
 * Шина подій: World успадковує EventTarget і диспатчить CustomEvent про ігрові події:
 *   fired         { shooter, bullet, missile }
 *   hit           { target, source, damage, destroyed }
 *   exploded      { entity, kind, size, x, y }
 *   pickup        { collector, pickup, effect }
 *   scoreChanged  { score, delta, playerId }
 * Симуляція нічого не знає про її споживачів (звук, HUD, мережа): вони самі підписуються.
 */

import { Entity, Kind } from './entity.js';
import { Vector2 } from './vector.js';
import { Asteroid } from './asteroid.js';
import { Bullet } from './bullet.js';
import { Explosion } from './explosion.js';
import { createPickup, PICKUP_EFFECTS } from './pickup.js';
import { applyPickup, attachHoming, runBehaviors } from './behaviors.js';
import { findCollisions } from './collision.js';
import { wrapEntity, wrappedDelta } from './arena.js';
import { createRng } from './rng.js';
import { IDLE_CONTROLS, normalizeControls, Ship } from './ship.js';
import { TAU } from '../math.js';

/** Ідентифікатор "головного" гравця в режимі однієї гри (setPlayer). */
export const LOCAL_PLAYER_ID = 'local';

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
  killScore: 100, // очки за знищення чужого судна
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

/** Відновлює сутність потрібного класу зі знімка. */
function entityFromSnapshot(data) {
  switch (data.kind) {
    case Kind.SHIP:
      return Ship.fromSnapshot(data);
    case Kind.BULLET:
      return Bullet.fromSnapshot(data);
    case Kind.ASTEROID:
      return Asteroid.fromSnapshot(data);
    case Kind.EXPLOSION:
      return Explosion.fromSnapshot(data);
    default:
      return Entity.fromSnapshot(data);
  }
}

export class World extends EventTarget {
  /** Сховище сутностей: Map<id, Entity>. Порядок обходу = порядок додавання. */
  #entities = new Map();
  /** Гравці: Map<playerId, { id, ship, controls, respawnTimer, score }>. */
  #players = new Map();
  #primaryId = null;
  #rules;
  #rng;
  #nextId;
  #refillTimer;
  #pickupTimer;

  /**
   * @param {object} options
   * @param {number} options.width розмір арени, CSS-пікселі
   * @param {number} options.height
   * @param {number} [options.seed] seed детермінованого генератора
   * @param {object} [options.rules] перевизначення правил (arena.json + параметри кімнати)
   * @param {number} [options.firstId] перший id сутностей (світ прогнозу клієнта бере великий
   *   зсув, щоб його локальні кулі не збігались з id, які видає сервер)
   */
  constructor({ width, height, seed = 1, rules = {}, firstId = 1 }) {
    super();
    this.width = width;
    this.height = height;
    /** true - події шини не диспатчаться (повторне програвання вводу під час реконсиляції). */
    this.muted = false;
    this.#rules = mergeRules(rules);
    this.#rng = createRng(seed);
    this.#nextId = firstId;
    this.#refillTimer = this.#rules.asteroidRefillDelay;
    this.#pickupTimer = this.#rules.pickupInterval;
  }

  get rules() {
    return this.#rules;
  }

  /** Судно "головного" гравця (офлайн-режим або перший доданий гравець). */
  get player() {
    return this.#players.get(this.#primaryId)?.ship ?? null;
  }

  get score() {
    return this.#players.get(this.#primaryId)?.score ?? 0;
  }

  /** Секунди до відродження головного гравця (0, якщо він живий). */
  get respawnIn() {
    return this.#players.get(this.#primaryId)?.respawnTimer ?? 0;
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
  }

  /** Диспатчить ігрову подію шини. */
  emit(type, detail = {}) {
    if (this.muted) return;
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // --- Керування сутностями ---

  /** Додає сутність у світ. Не викликати з циклу, що ітерує сам світ. */
  spawn(entity) {
    if (!entity.id) entity.id = this.#nextId++;
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

  /** Негайно прибирає всі сутності виду `kind` (не викликати під час step). */
  removeKind(kind) {
    for (const [id, entity] of this.#entities) {
      if (entity.kind !== kind) continue;
      this.#entities.delete(id);
      entity.world = null;
    }
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

  // --- Гравці ---

  #registerPlayer(playerId, ship) {
    const player = { id: playerId, ship, controls: IDLE_CONTROLS, respawnTimer: null, score: 0 };
    this.#players.set(playerId, player);
    this.#primaryId ??= playerId;
    return player;
  }

  /** Реєструє судно "головного" гравця (офлайн-режим) й додає його у світ. */
  setPlayer(ship) {
    this.#registerPlayer(LOCAL_PLAYER_ID, ship);
    this.spawn(ship);
  }

  /**
   * Додає гравця з новим судном. Без x/y судно з'являється в безпечній точці й тимчасово невразливе.
   * @returns {{ id: string, ship: Ship, score: number, respawnTimer: number | null }}
   */
  addPlayer(playerId, { x, y } = {}) {
    if (this.#players.has(playerId)) throw new Error(`Гравець уже є у світі: ${playerId}`);
    const ship = new Ship({ x: x ?? 0, y: y ?? 0 });
    if (x === undefined || y === undefined) {
      const point = this.#findSafePoint(ship);
      ship.teleport(point.x, point.y);
    }
    ship.grantInvulnerability(this.#rules.respawnInvulnerability);
    const player = this.#registerPlayer(playerId, ship);
    this.spawn(ship);
    return player;
  }

  /** Прибирає гравця разом із судном. */
  removePlayer(playerId) {
    const player = this.#players.get(playerId);
    if (!player) return false;
    this.#players.delete(playerId);
    if (this.#entities.delete(player.ship.id)) player.ship.world = null;
    player.ship.alive = false;
    if (this.#primaryId === playerId) this.#primaryId = this.#players.keys().next().value ?? null;
    return true;
  }

  hasPlayer(playerId) {
    return this.#players.has(playerId);
  }

  getPlayer(playerId) {
    return this.#players.get(playerId);
  }

  /** Усі гравці (записи лише для читання). */
  *players() {
    yield* this.#players.values();
  }

  /** Запам'ятовує керування гравця; діє на кожному кроці, доки не прийде нове. */
  setInput(playerId, input) {
    const player = this.#players.get(playerId);
    if (player) player.controls = normalizeControls(input);
  }

  /**
   * Клієнтська реконсиляція: ставить у судно гравця авторитативний стан із сервера.
   * Судно знову потрапляє у світ, якщо воно живе, і виходить із нього, якщо знищене.
   */
  syncPlayerShip(playerId, data) {
    const player = this.#players.get(playerId);
    if (!player) return;
    const { ship } = player;
    this.#entities.delete(ship.id);
    ship.applySnapshot(data);
    player.respawnTimer = data.respawnTimer ?? null;
    if (ship.alive) {
      this.#entities.set(ship.id, ship);
      ship.world = this;
    } else {
      ship.world = null;
    }
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
   * @param {number} dt фіксований крок, секунди
   * @param {object} [input] керування "головного" гравця ({ thrust, turn, fire, missile } або
   *   старий формат { left, right, thrust }); решту гравців веде setInput
   */
  step(dt, input) {
    if (input !== undefined && this.#primaryId !== null) this.setInput(this.#primaryId, input);

    // Керування й вогонь: нові кулі з'являються ДО ітерації по світу, тож Map безпечно ітерується.
    for (const player of this.#players.values()) {
      const { ship, controls } = player;
      if (!ship.alive || ship.world !== this) continue;
      ship.controls = controls;
      if (controls.fire) ship.fire();
      if (controls.missile) ship.fireMissile();
    }

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

  // --- Знімки стану (повний, для тестів детермінізму, відкату й відладки) ---

  /** @returns {object} чисті JSON-дані: повний стан світу, включно зі станом генератора */
  toSnapshot() {
    const entities = [];
    const aliveShips = new Set();
    for (const entity of this.#entities.values()) {
      entities.push(entity.toSnapshot());
      if (entity.kind === Kind.SHIP) aliveShips.add(entity.id);
    }
    return {
      width: this.width,
      height: this.height,
      rules: { ...this.#rules },
      rng: this.#rng.getState(),
      nextId: this.#nextId,
      refillTimer: this.#refillTimer,
      pickupTimer: this.#pickupTimer,
      primaryId: this.#primaryId,
      players: [...this.#players.values()].map((player) => ({
        id: player.id,
        shipId: player.ship.id,
        controls: { ...player.controls },
        respawnTimer: player.respawnTimer,
        score: player.score,
        // Знищене судно поза Map: його стан зберігаємо окремо.
        ship: aliveShips.has(player.ship.id) ? null : player.ship.toSnapshot(),
      })),
      entities,
    };
  }

  /** Відновлює світ зі знімка: подальші кроки дають ті самі результати, що й в оригіналу. */
  static fromSnapshot(data) {
    const world = new World({
      width: data.width,
      height: data.height,
      seed: 0,
      rules: data.rules,
      firstId: data.nextId,
    });
    world.#rng.setState(data.rng);
    world.#refillTimer = data.refillTimer;
    world.#pickupTimer = data.pickupTimer;

    for (const item of data.entities) {
      const entity = entityFromSnapshot(item);
      world.#entities.set(entity.id, entity);
      entity.world = world;
    }
    for (const item of data.players) {
      const ship = world.#entities.get(item.shipId) ?? Ship.fromSnapshot(item.ship);
      world.#players.set(item.id, {
        id: item.id,
        ship,
        controls: normalizeControls(item.controls),
        respawnTimer: item.respawnTimer,
        score: item.score,
      });
    }
    world.#primaryId = data.primaryId;
    return world;
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

    pair = pick(Kind.BULLET, Kind.SHIP);
    if (pair) return this.#bulletHitsShip(...pair);

    pair = pick(Kind.SHIP, Kind.ASTEROID);
    if (pair) return this.#shipHitsAsteroid(...pair);

    pair = pick(Kind.SHIP, Kind.PICKUP);
    if (pair) return this.#shipTakesPickup(...pair);

    if (a.kind === Kind.ASTEROID && b.kind === Kind.ASTEROID) return this.#bounce(a, b);
    return undefined;
  }

  #playerByShipId(shipId) {
    for (const player of this.#players.values()) {
      if (player.ship.id === shipId) return player;
    }
    return undefined;
  }

  #bulletHitsAsteroid(bullet, asteroid) {
    bullet.alive = false;
    const destroyed = asteroid.takeDamage(bullet.damage);
    this.emit('hit', { target: asteroid, source: bullet, damage: bullet.damage, destroyed });
    if (destroyed) this.#destroyAsteroid(asteroid, this.#playerByShipId(bullet.owner));
  }

  /** Влучання кулі в чуже судно. Власні кулі своє судно не зачіпають. */
  #bulletHitsShip(bullet, ship) {
    if (bullet.owner === ship.id) return;
    bullet.alive = false;
    const destroyed = ship.takeDamage(bullet.damage);
    this.emit('hit', { target: ship, source: bullet, damage: bullet.damage, destroyed });
    if (!destroyed) return;
    this.#destroyShip(ship);
    const shooter = this.#playerByShipId(bullet.owner);
    if (shooter) this.#addScore(shooter, this.#rules.killScore);
  }

  #shipHitsAsteroid(ship, asteroid) {
    this.#bounce(ship, asteroid);
    if (ship.invulnerable > 0) return;

    const damage = this.#rules.contactDamagePerSize * asteroid.size;
    const shipDestroyed = ship.takeDamage(damage);
    this.emit('hit', { target: ship, source: asteroid, damage, destroyed: shipDestroyed });
    if (shipDestroyed) this.#destroyShip(ship);

    if (asteroid.takeDamage(this.#rules.ramDamage)) {
      this.#destroyAsteroid(asteroid, this.#playerByShipId(ship.id));
    }
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
    const impulse = (-(1 + this.#rules.bounce) * approach) / (1 / massA + 1 / massB);
    a.vel.addScaledInPlace({ x: nx, y: ny }, -impulse / massA);
    b.vel.addScaledInPlace({ x: nx, y: ny }, impulse / massB);
  }

  // --- Знищення, вибухи, очки ---

  /** Нараховує очки гравцеві; без гравця (куля без власника) очки нікому не йдуть. */
  #addScore(player, delta) {
    if (!player) return;
    player.score += delta;
    this.emit('scoreChanged', { score: player.score, delta, playerId: player.id });
  }

  #destroyAsteroid(asteroid, creditedPlayer) {
    const { x, y } = asteroid.pos;
    this.emit('exploded', { entity: asteroid, kind: Kind.ASTEROID, size: asteroid.size, x, y });
    this.#addScore(creditedPlayer, asteroid.score);
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
    const player = this.#playerByShipId(ship.id);
    if (player) player.respawnTimer = this.#rules.respawnDelay;
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
    for (const player of this.#players.values()) {
      if (player.respawnTimer === null) continue;
      player.respawnTimer -= dt;
      if (player.respawnTimer > 0) continue;

      player.respawnTimer = null;
      const point = this.#findSafePoint(player.ship);
      player.ship.respawnAt(point.x, point.y, this.#rules.respawnInvulnerability);
      this.spawn(player.ship);
    }
  }

  /** Серед кількох випадкових точок бере ту, що найдалі від усіх перешкод. */
  #findSafePoint(exceptShip) {
    const margin = 60;
    let best = new Vector2(this.width / 2, this.height / 2);
    let bestClearance = -Infinity;

    for (let i = 0; i < this.#rules.safePointCandidates; i += 1) {
      const x = margin + this.#rng() * Math.max(1, this.width - 2 * margin);
      const y = margin + this.#rng() * Math.max(1, this.height - 2 * margin);
      let clearance = Infinity;
      for (const entity of this.#entities.values()) {
        if (!entity.alive || !entity.collidable || entity === exceptShip) continue;
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
