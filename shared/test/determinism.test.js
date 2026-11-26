import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRng, TICK_DT, World, worldHash } from '@dogfight/shared';

/** Скриптований ввід: власний генератор, незалежний від світу. */
function makeInputs(seed, count) {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => ({
    thrust: rng() < 0.7,
    turn: Math.floor(rng() * 3) - 1,
    fire: rng() < 0.4,
    missile: rng() < 0.03,
  }));
}

/** 1000 кроків із двома гравцями; повертає хеш і підсумок. */
function run({ seed, steps = 1000, restoreAt = null }) {
  let world = new World({ width: 1280, height: 720, seed });
  world.addPlayer('a');
  world.addPlayer('b');
  world.populate();
  const inputsA = makeInputs(11, steps);
  const inputsB = makeInputs(22, steps);

  for (let i = 0; i < steps; i += 1) {
    if (restoreAt === i) {
      // Відновлення зі знімка посеред симуляції (через JSON, як по мережі/з диска).
      world = World.fromSnapshot(JSON.parse(JSON.stringify(world.toSnapshot())));
    }
    world.setInput('a', inputsA[i]);
    world.setInput('b', inputsB[i]);
    world.step(TICK_DT);
  }
  return { hash: worldHash(world), entities: [...world].length, world };
}

describe('детермінізм симуляції', () => {
  test('1000 кроків з однаковим seed і вводом дають ідентичний хеш', () => {
    const first = run({ seed: 1234 });
    const second = run({ seed: 1234 });
    assert.equal(first.hash, second.hash);
    assert.equal(first.entities, second.entities);
  });

  test('інший seed дає інший світ', () => {
    assert.notEqual(run({ seed: 1234 }).hash, run({ seed: 4321 }).hash);
  });

  test('ввід впливає на стан (хеш не вироджений)', () => {
    const world = new World({ width: 1280, height: 720, seed: 5 });
    world.addPlayer('a');
    const before = worldHash(world);
    world.setInput('a', { thrust: true, turn: 1, fire: true, missile: false });
    world.step(TICK_DT);
    assert.notEqual(worldHash(world), before);
  });

  test('світ, відновлений зі знімка, далі еволюціонує тотожно', () => {
    const straight = run({ seed: 99 });
    const restored = run({ seed: 99, restoreAt: 400 });
    assert.equal(restored.hash, straight.hash);
  });

  test('знімок серіалізується в чистий JSON (без втрат і посилань)', () => {
    const { world } = run({ seed: 3, steps: 200 });
    const snapshot = world.toSnapshot();
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  });

  test('id сутностей належать світові: два світи видають однакові id', () => {
    const a = run({ seed: 8, steps: 100 }).world;
    const b = run({ seed: 8, steps: 100 }).world;
    assert.deepEqual(
      [...a].map((entity) => entity.id),
      [...b].map((entity) => entity.id),
    );
  });

  test('судно гравця можна відновити зі знімка (toSnapshot / fromSnapshot)', async () => {
    const { world } = run({ seed: 21, steps: 150 });
    const { Ship } = await import('@dogfight/shared');
    const player = world.getPlayer('a');
    const clone = Ship.fromSnapshot(player.ship.toSnapshot());
    assert.deepEqual(clone.toSnapshot(), player.ship.toSnapshot());
  });
});
