/**
 * Збирання мережевого знімка зі світу й зворотне перетворення станів для клієнта.
 */

import type {
  NetAsteroid,
  NetBullet,
  NetExplosionEvent,
  NetPickup,
  NetShip,
  SnapshotMessage,
} from './protocol.ts';
import { Asteroid } from './sim/asteroid.ts';
import { Bullet } from './sim/bullet.ts';
import { Kind } from './sim/entity.ts';
import type { PickupEffectType } from './sim/pickup.ts';
import type { ShipPatchSnapshot } from './sim/ship.ts';
import type { World } from './sim/world.ts';
import { asSeq, type Tick } from './types.ts';

const EFFECT_NAMES: readonly PickupEffectType[] = ['heal', 'rapid'];

export function buildSnapshotMessage(
  world: World,
  { tick, events = [] }: { readonly tick: Tick; readonly events?: readonly NetExplosionEvent[] },
): SnapshotMessage {
  const ships: NetShip[] = [];
  for (const player of world.players()) {
    const { ship } = player;
    ships.push({
      id: ship.id,
      x: ship.pos.x,
      y: ship.pos.y,
      vx: ship.vel.x,
      vy: ship.vel.y,
      angle: ship.angle,
      hp: ship.hp,
      alive: ship.alive,
      thrust: ship.thrust === 1,
      rapid: ship.hasBuff('rapid'),
      invulnerable: ship.invulnerable,
      fireCooldown: ship.fireCooldown,
      rapidLeft: ship.buffRemaining('rapid'),
      respawnIn: player.respawnTimer ?? 0,
      score: player.score,
    });
  }

  const asteroids: NetAsteroid[] = [];
  for (const entity of world.ofKind(Kind.ASTEROID)) {
    if (!(entity instanceof Asteroid)) continue;
    asteroids.push({
      id: entity.id,
      x: entity.pos.x,
      y: entity.pos.y,
      vx: entity.vel.x,
      vy: entity.vel.y,
      angle: entity.angle,
      size: entity.size,
      hunter: Boolean(entity.components.homing),
    });
  }

  const bullets: NetBullet[] = [];
  for (const entity of world.ofKind(Kind.BULLET)) {
    if (!(entity instanceof Bullet)) continue;
    bullets.push({
      id: entity.id,
      x: entity.pos.x,
      y: entity.pos.y,
      vx: entity.vel.x,
      vy: entity.vel.y,
      owner: entity.owner,
      missile: Boolean(entity.components.homing),
    });
  }

  const pickups: NetPickup[] = [];
  for (const entity of world.ofKind(Kind.PICKUP)) {
    const effect = entity.components.pickup?.effect.type ?? 'heal';
    pickups.push({
      id: entity.id,
      x: entity.pos.x,
      y: entity.pos.y,
      effect,
      remaining: entity.components.lifetime?.remaining ?? 0,
    });
  }

  return {
    type: 'snapshot',
    tick,
    lastProcessedSeq: asSeq(0),
    ships,
    asteroids,
    bullets,
    pickups,
    events: [...events],
  };
}

export const effectToCode = (effect: PickupEffectType): number =>
  Math.max(0, EFFECT_NAMES.indexOf(effect));

export const codeToEffect = (code: number): PickupEffectType => EFFECT_NAMES[code] ?? 'heal';

export function shipStateFromNet(record: NetShip): ShipPatchSnapshot {
  return {
    id: record.id,
    x: record.x,
    y: record.y,
    vx: record.vx,
    vy: record.vy,
    angle: record.angle,
    alive: record.alive,
    hp: record.hp,
    thrust: record.thrust,
    invulnerable: record.invulnerable,
    fireCooldown: record.fireCooldown,
    missileCooldown: 0,
    buffs: record.rapid ? [['rapid', record.rapidLeft]] : [],
    respawnTimer: record.alive ? null : record.respawnIn,
  };
}
