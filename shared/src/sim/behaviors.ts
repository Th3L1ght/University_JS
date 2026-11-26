/**
 * Композиція поведінок: behavior-as-data.
 */

import { clamp, shortestAngleDelta } from '../math.ts';
import { assertNever } from '../types.ts';
import { wrappedDelta } from './arena.ts';
import type { Entity, EntityKind, HomingComponent, PickupEffect } from './entity.ts';
import { Vector2 } from './vector.ts';

export interface HomingOptions {
  readonly turnRate?: number;
  readonly range?: number;
  readonly targetKinds: readonly EntityKind[];
}

export interface BehaviorWorld extends Iterable<Entity> {
  readonly width: number;
  readonly height: number;
}

export interface PickupCollector {
  heal(amount: number): void;
  addBuff(name: string, duration: number): void;
}

export function attachHoming<T extends Entity>(entity: T, options: HomingOptions): T {
  entity.components.homing = { turnRate: 3, range: 500, ...options };
  return entity;
}

export function attachPickup<T extends Entity>(entity: T, effect: PickupEffect): T {
  entity.components.pickup = { effect: { ...effect } };
  return entity;
}

export function attachLifetime<T extends Entity>(entity: T, seconds: number): T {
  entity.components.lifetime = { remaining: seconds };
  return entity;
}

function steerHoming(
  entity: Entity,
  homing: HomingComponent,
  world: BehaviorWorld,
  dt: number,
): void {
  let bestDx = 0;
  let bestDy = 0;
  let bestDistSq = homing.range * homing.range;
  let found = false;

  for (const target of world) {
    if (!target.alive || target === entity || !homing.targetKinds.includes(target.kind)) continue;
    const dx = wrappedDelta(entity.pos.x, target.pos.x, world.width);
    const dy = wrappedDelta(entity.pos.y, target.pos.y, world.height);
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestDx = dx;
      bestDy = dy;
      found = true;
    }
  }
  if (!found) return;

  const speed = entity.vel.length();
  if (speed === 0) return;

  const heading = Math.atan2(entity.vel.y, entity.vel.x);
  const wanted = shortestAngleDelta(heading, Math.atan2(bestDy, bestDx));
  const maxTurn = homing.turnRate * dt;
  const newHeading = heading + clamp(wanted, -maxTurn, maxTurn);
  entity.vel = new Vector2(Math.cos(newHeading) * speed, Math.sin(newHeading) * speed);
}

/** Виконує всі приєднані компоненти сутності. Викликається World.step перед update. */
export function runBehaviors(entity: Entity, world: BehaviorWorld, dt: number): void {
  const { lifetime, homing } = entity.components;

  if (lifetime) {
    lifetime.remaining -= dt;
    if (lifetime.remaining <= 0) {
      entity.alive = false;
      return;
    }
  }
  if (homing) steerHoming(entity, homing, world, dt);
}

/** Застосовує ефект бонусу до збирача (корабля) і гасить бонус. */
export function applyPickup(collector: PickupCollector, pickup: Entity): boolean {
  const component = pickup.components.pickup;
  if (!component || !pickup.alive) return false;
  const { effect } = component;
  switch (effect.type) {
    case 'heal':
      collector.heal(effect.amount);
      break;
    case 'rapid':
      collector.addBuff('rapid', effect.duration);
      break;
    default: {
      const _exhaustive: never = effect;
      return assertNever(_exhaustive, 'невідомий ефект бонусу');
    }
  }
  pickup.alive = false;
  return true;
}
