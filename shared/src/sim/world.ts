/**
 * Світ: сховище сутностей на Map, один крок симуляції, правила гри і шина подій.
 * Детермінований: жодного Math.random, Date.now, DOM чи node:*.
 */

import { TAU } from '../math.ts';
import { asEntityId, assertNever, type EntityId } from '../types.ts';
import { wrapEntity, wrappedDelta } from './arena.ts';
import { Asteroid, type AsteroidSize, type AsteroidSnapshot } from './asteroid.ts';
import { applyPickup, attachHoming, runBehaviors } from './behaviors.ts';
import { Bullet, type BulletSnapshot } from './bullet.ts';
import { findCollisions } from './collision.ts';
import { Entity, Kind, type EntityKind, type PickupSnapshot, type WorldHost } from './entity.ts';
import { Explosion, type ExplosionSnapshot } from './explosion.ts';
import { createPickup, PICKUP_EFFECT_TYPES } from './pickup.ts';
import { createRng, type Rng } from './rng.ts';
import {
  IDLE_CONTROLS,
  normalizeControls,
  Ship,
  type Controls,
  type RawControlsInput,
  type ShipPatchSnapshot,
  type ShipSnapshot,
} from './ship.ts';
import { Vector2 } from './vector.ts';

/** Дискриміноване об'єднання знімків усіх типів сутностей. */
export type EntitySnapshot =
  ShipSnapshot | BulletSnapshot | AsteroidSnapshot | PickupSnapshot | ExplosionSnapshot;

/** Ідентифікатор "головного" гравця в режимі однієї гри (setPlayer). */
export const LOCAL_PLAYER_ID = 'local';

export interface WorldRules {
  readonly initialAsteroids: number;
  readonly minAsteroids: number;
  readonly asteroidRefillDelay: number;
  readonly hunterChance: number;
  readonly hunter: {
    readonly turnRate: number;
    readonly range: number;
    readonly targetKinds: readonly EntityKind[];
  };
  readonly respawnDelay: number;
  readonly respawnInvulnerability: number;
  readonly safePointCandidates: number;
  readonly contactDamagePerSize: number;
  readonly ramDamage: number;
  readonly killScore: number;
  readonly pickupInterval: number;
  readonly maxPickups: number;
  readonly bounce: number;
}

export const WORLD_RULES: WorldRules = Object.freeze({
  initialAsteroids: 6,
  minAsteroids: 5,
  asteroidRefillDelay: 2.5,
  hunterChance: 0.3,
  hunter: Object.freeze({ turnRate: 0.55, range: 650, targetKinds: [Kind.SHIP] as const }),
  respawnDelay: 2,
  respawnInvulnerability: 2,
  safePointCandidates: 32,
  contactDamagePerSize: 10,
  ramDamage: 15,
  killScore: 100,
  pickupInterval: 9,
  maxPickups: 2,
  bounce: 0.8,
});

type NumericRuleKey =
  | 'initialAsteroids'
  | 'minAsteroids'
  | 'asteroidRefillDelay'
  | 'hunterChance'
  | 'respawnDelay'
  | 'respawnInvulnerability'
  | 'pickupInterval'
  | 'maxPickups';

const RULE_LIMITS: Readonly<Record<NumericRuleKey, readonly [number, number]>> = Object.freeze({
  initialAsteroids: [0, 40],
  minAsteroids: [0, 40],
  asteroidRefillDelay: [0.2, 60],
  hunterChance: [0, 1],
  respawnDelay: [0, 10],
  respawnInvulnerability: [0, 10],
  pickupInterval: [1, 120],
  maxPickups: [0, 10],
});

const RULE_KEYS: readonly NumericRuleKey[] = [
  'initialAsteroids',
  'minAsteroids',
  'asteroidRefillDelay',
  'hunterChance',
  'respawnDelay',
  'respawnInvulnerability',
  'pickupInterval',
  'maxPickups',
];

export function mergeRules(
  ...overrides: readonly (Partial<WorldRules> | Record<string, unknown> | undefined)[]
): WorldRules {
  const rules: { -readonly [K in keyof WorldRules]: WorldRules[K] } = { ...WORLD_RULES };
  for (const source of overrides) {
    if (!source || typeof source !== 'object') continue;
    const record: Record<string, unknown> = { ...source };
    for (const key of RULE_KEYS) {
      const [min, max] = RULE_LIMITS[key];
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        rules[key] = Math.min(max, Math.max(min, value));
      }
    }
  }
  return Object.freeze(rules);
}

/** Вичерпне відновлення сутності зі знімка за дискримінантом `data.kind`. */
function entityFromSnapshot(data: EntitySnapshot): Entity {
  switch (data.kind) {
    case Kind.SHIP:
      return Ship.fromSnapshot(data);
    case Kind.BULLET:
      return Bullet.fromSnapshot(data);
    case Kind.ASTEROID:
      return Asteroid.fromSnapshot(data);
    case Kind.EXPLOSION:
      return Explosion.fromSnapshot(data);
    case Kind.PICKUP:
      return Entity.fromSnapshot(data);
    default: {
      const _exhaustive: never = data;
      return assertNever(_exhaustive, 'невідомий вид сутності у знімку');
    }
  }
}

function toTypedSnapshot(entity: Entity): EntitySnapshot {
  if (entity instanceof Ship) return entity.toSnapshot();
  if (entity instanceof Bullet) return entity.toSnapshot();
  if (entity instanceof Asteroid) return entity.toSnapshot();
  if (entity instanceof Explosion) return entity.toSnapshot();
  return { ...entity.toSnapshot(), kind: Kind.PICKUP };
}

export interface PlayerRecord {
  readonly id: string;
  readonly ship: Ship;
  controls: Controls;
  respawnTimer: number | null;
  score: number;
}

export interface PlayerSnapshot {
  readonly id: string;
  readonly shipId: EntityId;
  readonly controls: Controls;
  readonly respawnTimer: number | null;
  readonly score: number;
  readonly ship: ShipSnapshot | null;
}

export interface WorldSnapshot {
  readonly width: number;
  readonly height: number;
  readonly rules: WorldRules;
  readonly rng: number;
  readonly nextId: number;
  readonly refillTimer: number;
  readonly pickupTimer: number;
  readonly primaryId: string | null;
  readonly players: readonly PlayerSnapshot[];
  readonly entities: readonly EntitySnapshot[];
}

export interface WorldOptions {
  readonly width: number;
  readonly height: number;
  readonly seed?: number;
  readonly rules?: Partial<WorldRules> | Record<string, unknown>;
  readonly firstId?: number;
}

export class World extends EventTarget implements WorldHost, Iterable<Entity> {
  #entities = new Map<EntityId, Entity>();
  #players = new Map<string, PlayerRecord>();
  #primaryId: string | null = null;
  #rules: WorldRules;
  #rng: Rng;
  #nextId: number;
  #refillTimer: number;
  #pickupTimer: number;

  width: number;
  height: number;
  muted = false;

  constructor({ width, height, seed = 1, rules = {}, firstId = 1 }: WorldOptions) {
    super();
    this.width = width;
    this.height = height;
    this.#rules = mergeRules(rules);
    this.#rng = createRng(seed);
    this.#nextId = firstId;
    this.#refillTimer = this.#rules.asteroidRefillDelay;
    this.#pickupTimer = this.#rules.pickupInterval;
  }

  get rules(): WorldRules {
    return this.#rules;
  }

  get player(): Ship | null {
    if (this.#primaryId === null) return null;
    return this.#players.get(this.#primaryId)?.ship ?? null;
  }

  get score(): number {
    if (this.#primaryId === null) return 0;
    return this.#players.get(this.#primaryId)?.score ?? 0;
  }

  get respawnIn(): number {
    if (this.#primaryId === null) return 0;
    return this.#players.get(this.#primaryId)?.respawnTimer ?? 0;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  emit(type: string, detail: Record<string, unknown> = {}): void {
    if (this.muted) return;
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // --- Керування сутностями ---

  spawn<T extends Entity>(entity: T): T {
    if (!entity.id) entity.id = asEntityId(this.#nextId++);
    this.#entities.set(entity.id, entity);
    entity.world = this;
    return entity;
  }

  despawn(id: EntityId): void {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  removeKind(kind: EntityKind): void {
    for (const [id, entity] of this.#entities) {
      if (entity.kind !== kind) continue;
      this.#entities.delete(id);
      entity.world = null;
    }
  }

  get(id: EntityId): Entity | undefined {
    const entity = this.#entities.get(id);
    return entity?.alive ? entity : undefined;
  }

  *[Symbol.iterator](): Generator<Entity> {
    yield* this.#entities.values();
  }

  *ofKind(kind: EntityKind): Generator<Entity> {
    for (const entity of this.#entities.values()) {
      if (entity.kind === kind) yield entity;
    }
  }

  // --- Гравці ---

  #registerPlayer(playerId: string, ship: Ship): PlayerRecord {
    const player: PlayerRecord = {
      id: playerId,
      ship,
      controls: IDLE_CONTROLS,
      respawnTimer: null,
      score: 0,
    };
    this.#players.set(playerId, player);
    this.#primaryId ??= playerId;
    return player;
  }

  setPlayer(ship: Ship): void {
    this.#registerPlayer(LOCAL_PLAYER_ID, ship);
    this.spawn(ship);
  }

  addPlayer(
    playerId: string,
    coords: { readonly x?: number; readonly y?: number } = {},
  ): PlayerRecord {
    if (this.#players.has(playerId)) throw new Error(`Гравець уже є у світі: ${playerId}`);
    const ship = new Ship({ x: coords.x ?? 0, y: coords.y ?? 0 });
    if (coords.x === undefined || coords.y === undefined) {
      const point = this.#findSafePoint(ship);
      ship.teleport(point.x, point.y);
    }
    ship.grantInvulnerability(this.#rules.respawnInvulnerability);
    const player = this.#registerPlayer(playerId, ship);
    this.spawn(ship);
    return player;
  }

  removePlayer(playerId: string): boolean {
    const player = this.#players.get(playerId);
    if (!player) return false;
    this.#players.delete(playerId);
    if (this.#entities.delete(player.ship.id)) player.ship.world = null;
    player.ship.alive = false;
    if (this.#primaryId === playerId) this.#primaryId = this.#players.keys().next().value ?? null;
    return true;
  }

  hasPlayer(playerId: string): boolean {
    return this.#players.has(playerId);
  }

  getPlayer(playerId: string): PlayerRecord | undefined {
    return this.#players.get(playerId);
  }

  *players(): Generator<PlayerRecord> {
    yield* this.#players.values();
  }

  setInput(playerId: string, input: RawControlsInput): void {
    const player = this.#players.get(playerId);
    if (player) player.controls = normalizeControls(input);
  }

  syncPlayerShip(playerId: string, data: ShipPatchSnapshot): void {
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

  populate(): void {
    const cx = this.width / 2;
    const cy = this.height / 2;
    for (let i = 0; i < this.#rules.initialAsteroids; i += 1) {
      let x: number;
      let y: number;
      do {
        x = this.#rng() * this.width;
        y = this.#rng() * this.height;
      } while (Math.hypot(x - cx, y - cy) < 220);
      this.spawn(this.#createAsteroid({ x, y, size: 3 }));
    }
  }

  // --- Крок симуляції ---

  step(dt: number, input?: RawControlsInput): void {
    if (input !== undefined && this.#primaryId !== null) this.setInput(this.#primaryId, input);

    for (const player of this.#players.values()) {
      const { ship, controls } = player;
      if (!ship.alive || ship.world !== this) continue;
      ship.controls = controls;
      if (controls.fire) ship.fire();
      if (controls.missile) ship.fireMissile();
    }

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

  #sweep(): void {
    const dead: Entity[] = [];
    for (const entity of this.#entities.values()) {
      if (!entity.alive) dead.push(entity);
    }
    for (const entity of dead) {
      this.#entities.delete(entity.id);
      entity.world = null;
    }
  }

  // --- Знімки стану ---

  toSnapshot(): WorldSnapshot {
    const entities: EntitySnapshot[] = [];
    const aliveShips = new Set<EntityId>();
    for (const entity of this.#entities.values()) {
      entities.push(toTypedSnapshot(entity));
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
        ship: aliveShips.has(player.ship.id) ? null : player.ship.toSnapshot(),
      })),
      entities,
    };
  }

  static fromSnapshot(data: WorldSnapshot): World {
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
      const found = world.#entities.get(item.shipId);
      let ship: Ship;
      if (found instanceof Ship) {
        ship = found;
      } else if (item.ship) {
        ship = Ship.fromSnapshot(item.ship);
      } else {
        throw new Error(`Знімок гравця ${item.id} не містить судна`);
      }
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

  #resolveCollision(a: Entity, b: Entity): void {
    if (a instanceof Bullet && b instanceof Asteroid) return this.#bulletHitsAsteroid(a, b);
    if (b instanceof Bullet && a instanceof Asteroid) return this.#bulletHitsAsteroid(b, a);

    if (a instanceof Bullet && b instanceof Ship) return this.#bulletHitsShip(a, b);
    if (b instanceof Bullet && a instanceof Ship) return this.#bulletHitsShip(b, a);

    if (a instanceof Ship && b instanceof Asteroid) return this.#shipHitsAsteroid(a, b);
    if (b instanceof Ship && a instanceof Asteroid) return this.#shipHitsAsteroid(b, a);

    if (a instanceof Ship && b.kind === Kind.PICKUP) return this.#shipTakesPickup(a, b);
    if (b instanceof Ship && a.kind === Kind.PICKUP) return this.#shipTakesPickup(b, a);

    if (a instanceof Asteroid && b instanceof Asteroid) return this.#bounce(a, b);
  }

  #playerByShipId(shipId: EntityId): PlayerRecord | undefined {
    for (const player of this.#players.values()) {
      if (player.ship.id === shipId) return player;
    }
    return undefined;
  }

  #bulletHitsAsteroid(bullet: Bullet, asteroid: Asteroid): void {
    bullet.alive = false;
    const destroyed = asteroid.takeDamage(bullet.damage);
    this.emit('hit', { target: asteroid, source: bullet, damage: bullet.damage, destroyed });
    if (destroyed) this.#destroyAsteroid(asteroid, this.#playerByShipId(bullet.owner));
  }

  #bulletHitsShip(bullet: Bullet, ship: Ship): void {
    if (bullet.owner === ship.id) return;
    bullet.alive = false;
    const destroyed = ship.takeDamage(bullet.damage);
    this.emit('hit', { target: ship, source: bullet, damage: bullet.damage, destroyed });
    if (!destroyed) return;
    this.#destroyShip(ship);
    const shooter = this.#playerByShipId(bullet.owner);
    if (shooter) this.#addScore(shooter, this.#rules.killScore);
  }

  #shipHitsAsteroid(ship: Ship, asteroid: Asteroid): void {
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

  #shipTakesPickup(ship: Ship, pickup: Entity): void {
    const component = pickup.components.pickup;
    if (!component) return;
    if (applyPickup(ship, pickup)) {
      this.emit('pickup', { collector: ship, pickup, effect: component.effect });
    }
  }

  #bounce(a: Entity, b: Entity): void {
    const dx = wrappedDelta(a.pos.x, b.pos.x, this.width);
    const dy = wrappedDelta(a.pos.y, b.pos.y, this.height);
    const distance = Math.hypot(dx, dy) || 1;
    const nx = dx / distance;
    const ny = dy / distance;
    const normal = new Vector2(nx, ny);

    const massA = a.radius * a.radius;
    const massB = b.radius * b.radius;
    const totalMass = massA + massB;

    const overlap = a.radius + b.radius - distance;
    if (overlap > 0) {
      const moveA = (overlap * massB) / totalMass;
      const moveB = (overlap * massA) / totalMass;
      a.pos = a.pos.addScaled(normal, -moveA);
      a.prevPos = a.prevPos.addScaled(normal, -moveA);
      b.pos = b.pos.addScaled(normal, moveB);
      b.prevPos = b.prevPos.addScaled(normal, moveB);
    }

    const approach = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
    if (approach >= 0) return;
    const impulse = (-(1 + this.#rules.bounce) * approach) / (1 / massA + 1 / massB);
    a.vel = a.vel.addScaled(normal, -impulse / massA);
    b.vel = b.vel.addScaled(normal, impulse / massB);
  }

  // --- Знищення, вибухи, очки ---

  #addScore(player: PlayerRecord | undefined, delta: number): void {
    if (!player) return;
    player.score += delta;
    this.emit('scoreChanged', { score: player.score, delta, playerId: player.id });
  }

  #destroyAsteroid(asteroid: Asteroid, creditedPlayer: PlayerRecord | undefined): void {
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
      const childSize: AsteroidSize = asteroid.size === 3 ? 2 : 1;
      const hunter = Boolean(asteroid.components.homing);
      const heading = this.#rng() * TAU;
      for (const direction of [heading, heading + Math.PI]) {
        const speed = 45 + this.#rng() * 45;
        const child = this.#createAsteroid({
          x: x + Math.cos(direction) * asteroid.radius * 0.5,
          y: y + Math.sin(direction) * asteroid.radius * 0.5,
          vx: asteroid.vel.x * 0.5 + Math.cos(direction) * speed,
          vy: asteroid.vel.y * 0.5 + Math.sin(direction) * speed,
          size: childSize,
          hunter,
        });
        this.spawn(child);
      }
    }
  }

  #destroyShip(ship: Ship): void {
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

  #createAsteroid(options: {
    readonly x: number;
    readonly y: number;
    readonly vx?: number;
    readonly vy?: number;
    readonly size: AsteroidSize;
    readonly hunter?: boolean;
  }): Asteroid {
    let velocityX = options.vx;
    let velocityY = options.vy;
    if (velocityX === undefined || velocityY === undefined) {
      const direction = this.#rng() * TAU;
      const speed = 30 + this.#rng() * 50;
      velocityX = Math.cos(direction) * speed;
      velocityY = Math.sin(direction) * speed;
    }
    const asteroid = new Asteroid({
      x: options.x,
      y: options.y,
      vx: velocityX,
      vy: velocityY,
      size: options.size,
      rng: this.#rng,
    });
    const isHunter = options.hunter ?? this.#rng() < this.#rules.hunterChance;
    if (isHunter) attachHoming(asteroid, this.#rules.hunter);
    return asteroid;
  }

  #countOf(kind: EntityKind): number {
    let count = 0;
    for (const entity of this.ofKind(kind)) if (entity.alive) count += 1;
    return count;
  }

  #updateSpawners(dt: number): void {
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
        const idx = Math.floor(this.#rng() * PICKUP_EFFECT_TYPES.length);
        const type = PICKUP_EFFECT_TYPES[idx] ?? 'heal';
        const margin = 60;
        const x = margin + this.#rng() * Math.max(1, this.width - 2 * margin);
        const y = margin + this.#rng() * Math.max(1, this.height - 2 * margin);
        this.spawn(createPickup(x, y, type));
      }
    }
  }

  #updateRespawn(dt: number): void {
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

  #findSafePoint(exceptShip: Ship): Vector2 {
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
