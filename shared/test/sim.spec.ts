import { describe, expect, it } from 'vitest';
import {
  asEntityId,
  Asteroid,
  ASTEROID_SIZES,
  attachHoming,
  attachLifetime,
  Bullet,
  circlesOverlap,
  clamp,
  createPickup,
  createRng,
  Entity,
  Explosion,
  findCollisions,
  findCollisionsNaive,
  integrate,
  Kind,
  lerp,
  lerpAngle,
  mergeRules,
  ObjectPool,
  Ship,
  SHIP_PARAMS,
  shortestAngleDelta,
  SpatialHashGrid,
  TAU,
  TICK_DT,
  Vector2,
  World,
  worldHash,
  wrapAngle,
  wrapEntity,
  wrappedDelta,
} from '@dogfight/shared';

describe('Vector2 і математика', () => {
  it('базові операції Vector2 незмінні (readonly x, y)', () => {
    const a = new Vector2(3, 4);
    const b = new Vector2(1, -2);
    expect(a.length()).toBe(5);
    expect(a.add(b)).toEqual(new Vector2(4, 2));
    expect(a.sub(b)).toEqual(new Vector2(2, 6));
    expect(a.scale(2)).toEqual(new Vector2(6, 8));
    expect(a.addScaled(b, 3)).toEqual(new Vector2(6, -2));
    expect(a.dot(b)).toBe(-5);
    expect(a.clone()).toEqual(a);
    expect(a.x).toBe(3);
    expect(a.y).toBe(4);
  });

  it('normalize, rotate, fromAngle', () => {
    expect(Vector2.ZERO.normalize()).toEqual(Vector2.ZERO);
    const n = new Vector2(0, 10).normalize();
    expect(n.x).toBeCloseTo(0);
    expect(n.y).toBeCloseTo(1);
    const r = new Vector2(1, 0).rotate(Math.PI / 2);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(1);
    const f = Vector2.fromAngle(0, 5);
    expect(f.x).toBeCloseTo(5);
    expect(f.y).toBeCloseTo(0);
  });

  it('integrate виконує чистий крок Ейлера', () => {
    const next = integrate({ x: 10, y: 20 }, { x: 60, y: -30 }, 0.5);
    expect(next.x).toBe(40);
    expect(next.y).toBe(5);
  });

  it('lerp, clamp, wrapAngle, shortestAngleDelta, lerpAngle', () => {
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(shortestAngleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI);
    expect(TAU).toBeCloseTo(Math.PI * 2);
  });

  it('wrapEntity і wrappedDelta працюють на тороїдальній арені', () => {
    const e = new Entity({ kind: Kind.SHIP, x: -5, y: 725, radius: 10 });
    wrapEntity(e, 1280, 720);
    expect(e.pos.x).toBe(1275);
    expect(e.pos.y).toBe(5);
    expect(wrappedDelta(1270, 10, 1280)).toBe(20);
    expect(wrappedDelta(10, 1270, 1280)).toBe(-20);
  });
});

describe('Колізії: граничні випадки та SpatialHashGrid O(n)', () => {
  it('дотик (tangent), перетин (overlap) і промах (miss)', () => {
    const a = new Entity({ kind: Kind.ASTEROID, x: 100, y: 100, radius: 10 });
    const tangent = new Entity({ kind: Kind.ASTEROID, x: 120, y: 100, radius: 10 });
    const overlap = new Entity({ kind: Kind.ASTEROID, x: 119, y: 100, radius: 10 });
    const miss = new Entity({ kind: Kind.ASTEROID, x: 120.01, y: 100, radius: 10 });

    expect(circlesOverlap(a, tangent, 1280, 720)).toBe(true);
    expect(circlesOverlap(a, overlap, 1280, 720)).toBe(true);
    expect(circlesOverlap(a, miss, 1280, 720)).toBe(false);
  });

  it('перетин через край арени (wrap-around)', () => {
    const left = new Entity({ kind: Kind.SHIP, x: 4, y: 300, radius: 10 });
    const right = new Entity({ kind: Kind.ASTEROID, x: 1276, y: 300, radius: 10 });
    expect(circlesOverlap(left, right, 1280, 720)).toBe(true);
  });

  it('швидка куля: дискретний крок і граничний випадок тунелювання', () => {
    // На TICK_DT = 1/30 куля зі швидкістю 640 пкс/с проходить ~21.3 пкс < 2*(13+3) = 32 пкс -> тунелювання немає.
    const stepDist = SHIP_PARAMS.bulletSpeed * TICK_DT;
    const minTargetDiameter = (ASTEROID_SIZES[1].radius + 3) * 2;
    expect(stepDist).toBeLessThan(minTargetDiameter);

    // А екстремально швидка куля (3000 пкс/с) може перестрибнути малу ціль без swept-тесту.
    const bullet = new Bullet({
      pos: { x: 50, y: 100 },
      vel: { x: 3000, y: 0 },
      owner: asEntityId(1),
      damage: 10,
      ttl: 1,
    });
    const target = new Entity({ kind: Kind.ASTEROID, x: 100, y: 100, radius: 13 });
    expect(circlesOverlap(bullet, target, 1280, 720)).toBe(false);
    bullet.update(TICK_DT); // x = 150 (перестрибнула 100)
    expect(circlesOverlap(bullet, target, 1280, 720)).toBe(false);
  });

  it('SpatialHashGrid повертає рівно ті самі пари зіткнень, що й наївний O(n²)', () => {
    const world = new World({
      width: 1280,
      height: 720,
      seed: 17,
      rules: { initialAsteroids: 30, minAsteroids: 30 },
    });
    for (let i = 0; i < 12; i += 1) world.addPlayer(`p${i}`);
    world.populate();
    for (let t = 0; t < 30; t += 1) world.step(TICK_DT);

    const hashPairs = findCollisions(world)
      .map(([a, b]) => `${a.id}:${b.id}`)
      .sort();
    const naivePairs = findCollisionsNaive(world)
      .map(([a, b]) => `${a.id}:${b.id}`)
      .sort();
    expect(hashPairs).toEqual(naivePairs);

    const grid = new SpatialHashGrid(64);
    expect(grid.queryPairs([], 1280, 720)).toEqual([]);
  });
});

describe('ObjectPool і оптимізація пам’яті', () => {
  it('перевикористовує звільнені об’єкти й дотримується maxSize', () => {
    let created = 0;
    const pool = new ObjectPool(() => ({ id: ++created }), { maxSize: 2, preallocate: 1 });
    expect(pool.stats.allocated).toBe(1);

    const a = pool.acquire();
    const b = pool.acquire();
    expect(pool.stats.recycled).toBe(1);
    expect(pool.stats.allocated).toBe(2);

    pool.release(a);
    pool.release(b);
    pool.release({ id: 999 }); // понад maxSize
    expect(pool.stats.available).toBe(2);

    const c = pool.acquire();
    expect(c).toBe(b);
    expect(pool.stats.recycled).toBe(2);
  });

  it('World перевикористовує кулі та вибухи через пули під час бою', () => {
    const world = new World({ width: 1280, height: 720, seed: 9 });
    world.addPlayer('p1');
    world.populate();
    for (let i = 0; i < 180; i += 1) {
      world.setInput('p1', { thrust: true, turn: i % 10 < 5 ? 1 : -1, fire: true, missile: false });
      world.step(TICK_DT);
    }
    expect(world.poolStats.bullets.recycled).toBeGreaterThan(0);
    expect(world.poolStats.bullets.allocated).toBeLessThan(world.poolStats.bullets.acquired);
  });
});

describe('World.step: детермінізм, правила, поведінки, знімки', () => {
  it('1000 кроків з однаковим seed дають ідентичний worldHash', () => {
    const run = () => {
      const w = new World({ width: 1280, height: 720, seed: 777 });
      w.addPlayer('a');
      w.addPlayer('b');
      w.populate();
      const rng = createRng(13);
      for (let i = 0; i < 1000; i += 1) {
        w.setInput('a', {
          thrust: rng() < 0.7,
          turn: Math.floor(rng() * 3) - 1,
          fire: rng() < 0.3,
        });
        w.setInput('b', {
          thrust: rng() < 0.5,
          turn: Math.floor(rng() * 3) - 1,
          fire: rng() < 0.4,
        });
        w.step(TICK_DT);
      }
      return worldHash(w);
    };
    expect(run()).toBe(run());
  });

  it('відновлення World.fromSnapshot зберігає подальшу еволюцію', () => {
    const a = new World({ width: 1280, height: 720, seed: 55 });
    a.addPlayer('p1');
    a.populate();
    for (let i = 0; i < 100; i += 1) {
      a.setInput('p1', { thrust: true, turn: 1, fire: i % 5 === 0, missile: i === 20 });
      a.step(TICK_DT);
    }
    const b = World.fromSnapshot(JSON.parse(JSON.stringify(a.toSnapshot())));
    for (let i = 0; i < 100; i += 1) {
      a.step(TICK_DT);
      b.step(TICK_DT);
    }
    expect(worldHash(a)).toBe(worldHash(b));
  });

  it('mergeRules клампить межі та ігнорує невалідні значення', () => {
    const rules = mergeRules({ initialAsteroids: 999, hunterChance: -5, unknown: 123 });
    expect(rules.initialAsteroids).toBe(40);
    expect(rules.hunterChance).toBe(0);
  });

  it('бонуси heal/rapid, ракети homing, пошкодження та респаун', () => {
    const world = new World({
      width: 800,
      height: 600,
      seed: 3,
      rules: { initialAsteroids: 0, minAsteroids: 0, respawnDelay: 0.1 },
    });
    const ship = new Ship({ x: 400, y: 300 });
    world.setPlayer(ship);

    // Отримання шкоди й лікування бонусом heal.
    expect(ship.takeDamage(40)).toBe(false);
    expect(ship.hp).toBe(60);
    const heal = createPickup(400, 300, 'heal');
    world.spawn(heal);
    world.step(TICK_DT);
    expect(ship.hp).toBe(95);

    // Бонус rapid.
    const rapid = createPickup(400, 300, 'rapid');
    world.spawn(rapid);
    world.step(TICK_DT);
    expect(ship.hasBuff('rapid')).toBe(true);

    // Ракета з homing.
    const ast = new Asteroid({ x: 500, y: 300, vx: 0, vy: 0, size: 1, rng: createRng(1) });
    world.spawn(ast);
    const missile = ship.fireMissile();
    expect(missile).not.toBeNull();
    expect(missile?.components.homing).toBeDefined();

    // Lifetime + Explosion + homing helper.
    const temp = attachLifetime(new Entity({ kind: Kind.PICKUP, x: 10, y: 10 }), 0.01);
    attachHoming(temp, { targetKinds: [Kind.SHIP] });
    world.spawn(temp);
    const exp = new Explosion({ x: 10, y: 10, rng: createRng(2), count: 5, life: 0.05 });
    world.spawn(exp);
    for (let i = 0; i < 10; i += 1) world.step(TICK_DT);
    expect(temp.alive).toBe(false);
    expect(exp.alive).toBe(false);
  });

  it('Ship: перезарядка, rapid-fire, невразливість і респаун', () => {
    const world = new World({
      width: 800,
      height: 600,
      seed: 2,
      rules: { initialAsteroids: 0, minAsteroids: 0, respawnDelay: 0.05 },
    });
    const ship = new Ship({ x: 400, y: 300 });
    world.setPlayer(ship);

    expect(ship.fire()).not.toBeNull();
    expect(ship.fire()).toBeNull(); // cooldown активний
    ship.grantInvulnerability(1);
    expect(ship.takeDamage(50)).toBe(false);
    expect(ship.hp).toBe(SHIP_PARAMS.maxHp);

    ship.respawnAt(100, 100, 0);
    expect(ship.takeDamage(200)).toBe(true);
    expect(ship.alive).toBe(false);
  });

  it('Asteroid: отримання шкоди, знищення і розкол на менші уламки', () => {
    const rng = createRng(4);
    const ast = new Asteroid({ x: 100, y: 100, vx: 10, vy: 0, size: 3, rng });
    expect(ast.hp).toBe(ASTEROID_SIZES[3].hp);
    expect(ast.takeDamage(10)).toBe(false);
    expect(ast.takeDamage(25)).toBe(true);
    expect(ast.alive).toBe(false);
    const cloned = Asteroid.fromSnapshot(ast.toSnapshot());
    expect(cloned.size).toBe(3);
  });

  it('Bullet: кут відповідає швидкості, закінчення TTL деактивує кулю', () => {
    const b = new Bullet({
      pos: { x: 0, y: 0 },
      vel: { x: 0, y: 100 },
      owner: asEntityId(1),
      damage: 10,
      ttl: 0.05,
    });
    b.update(0.02);
    expect(b.angle).toBeCloseTo(Math.PI / 2);
    expect(b.alive).toBe(true);
    b.update(0.05);
    expect(b.alive).toBe(false);
  });

  it('Entity.fromSnapshot і World: get, despawn, removeKind, removePlayer', () => {
    const world = new World({
      width: 800,
      height: 600,
      seed: 8,
      rules: { initialAsteroids: 0, minAsteroids: 0 },
    });
    const p = world.addPlayer('u1');
    expect(world.hasPlayer('u1')).toBe(true);
    expect(world.get(p.ship.id)).toBe(p.ship);

    const pick = createPickup(50, 50, 'heal');
    world.spawn(pick);
    const restored = Entity.fromSnapshot(pick.toSnapshot());
    expect(restored.kind).toBe(Kind.PICKUP);

    world.removeKind(Kind.PICKUP);
    expect([...world.ofKind(Kind.PICKUP)].length).toBe(0);

    world.despawn(p.ship.id);
    expect(world.get(p.ship.id)).toBeUndefined();
    expect(world.removePlayer('u1')).toBe(true);
    expect(world.removePlayer('u1')).toBe(false);
  });

  it('createRng: збереження й відновлення стану getState / setState', () => {
    const rng = createRng(12345);
    rng();
    rng();
    const saved = rng.getState();
    const expected = [rng(), rng(), rng()];
    rng.setState(saved);
    expect([rng(), rng(), rng()]).toEqual(expected);
  });

  it('Explosion.fromSnapshot відновлює частинки без втрат', () => {
    const exp = new Explosion({ x: 20, y: 30, rng: createRng(7), count: 4, tint: 'ship' });
    const clone = Explosion.fromSnapshot(exp.toSnapshot());
    expect(clone.tint).toBe('ship');
    expect(clone.particles.length).toBe(4);
  });

  it('World: влучання кулі у вороже судно нараховує killScore, власні кулі ігноруються', () => {
    const world = new World({
      width: 800,
      height: 600,
      seed: 12,
      rules: { initialAsteroids: 0, minAsteroids: 0 },
    });
    const a = world.addPlayer('a', { x: 200, y: 300 });
    const b = world.addPlayer('b', { x: 240, y: 300 });
    a.ship.respawnAt(200, 300, 0);
    b.ship.respawnAt(240, 300, 0);
    // Куля від a знищує b (100 шкоди).
    const lethal = new Bullet({
      pos: { x: 240, y: 300 },
      vel: { x: 10, y: 0 },
      owner: a.ship.id,
      damage: 100,
      ttl: 1,
    });
    world.spawn(lethal);
    world.step(TICK_DT);
    expect(b.ship.alive).toBe(false);
    expect(a.score).toBe(world.rules.killScore);
  });

  it('World.addPlayer кидає помилку при дублюванні playerId', () => {
    const world = new World({ width: 800, height: 600, seed: 1 });
    world.addPlayer('dup');
    expect(() => world.addPlayer('dup')).toThrow();
  });

  it('Ship.heal і takeDamage ігнорують недодатні значення й мертве судно', () => {
    const ship = new Ship({ x: 0, y: 0 });
    ship.heal(-10);
    expect(ship.hp).toBe(100);
    expect(ship.takeDamage(0)).toBe(false);
    expect(ship.takeDamage(100)).toBe(true);
    ship.heal(50);
    expect(ship.hp).toBe(0);
  });

  it('Bullet.fromSnapshot відновлює owner, damage, ttl', () => {
    const b = new Bullet({
      pos: { x: 10, y: 20 },
      vel: { x: 30, y: 40 },
      owner: asEntityId(9),
      damage: 25,
      ttl: 1.5,
    });
    const c = Bullet.fromSnapshot(b.toSnapshot());
    expect(c.owner).toBe(9);
    expect(c.damage).toBe(25);
    expect(c.ttl).toBe(1.5);
  });

  it('World: пружне зіткнення астероїдів (#bounce) змінює вектори швидкості', () => {
    const world = new World({
      width: 800,
      height: 600,
      seed: 1,
      rules: { initialAsteroids: 0, minAsteroids: 0 },
    });
    const rng = createRng(1);
    const a1 = new Asteroid({ x: 300, y: 300, vx: 60, vy: 0, size: 2, rng });
    const a2 = new Asteroid({ x: 330, y: 300, vx: -60, vy: 0, size: 2, rng });
    world.spawn(a1);
    world.spawn(a2);
    world.step(TICK_DT);
    expect(a1.vel.x).toBeLessThan(0);
    expect(a2.vel.x).toBeGreaterThan(0);
  });
});
