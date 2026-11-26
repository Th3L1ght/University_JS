/**
 * Збирання мережевого знімка зі світу й зворотне перетворення станів для клієнта.
 *
 * Мережевий знімок - це не повний стан світу (World#toSnapshot), а те, що потрібно клієнту для
 * відображення й реконсиляції: судна всіх гравців (також знищені: для HUD і таймера респауну),
 * астероїди, кулі, бонуси й одноразові події (вибухи). Вибухи-частинки не передаються: клієнт
 * створює їх локально за подією.
 */

import { Kind } from './sim/entity.js';

const EFFECT_NAMES = ['heal', 'rapid'];

/**
 * @param {import('./sim/world.js').World} world
 * @param {{ tick: number, events?: object[] }} meta
 * @returns {object} логічне повідомлення `snapshot` (lastProcessedSeq = 0, виставляє сервер)
 */
export function buildSnapshotMessage(world, { tick, events = [] }) {
  const ships = [];
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

  const asteroids = [];
  for (const a of world.ofKind(Kind.ASTEROID)) {
    asteroids.push({
      id: a.id,
      x: a.pos.x,
      y: a.pos.y,
      vx: a.vel.x,
      vy: a.vel.y,
      angle: a.angle,
      size: a.size,
      hunter: Boolean(a.components.homing),
    });
  }

  const bullets = [];
  for (const b of world.ofKind(Kind.BULLET)) {
    bullets.push({
      id: b.id,
      x: b.pos.x,
      y: b.pos.y,
      vx: b.vel.x,
      vy: b.vel.y,
      owner: b.owner,
      missile: Boolean(b.components.homing),
    });
  }

  const pickups = [];
  for (const p of world.ofKind(Kind.PICKUP)) {
    pickups.push({
      id: p.id,
      x: p.pos.x,
      y: p.pos.y,
      effect: p.components.pickup.effect.type,
      remaining: p.components.lifetime?.remaining ?? 0,
    });
  }

  return {
    type: 'snapshot',
    tick,
    lastProcessedSeq: 0,
    ships,
    asteroids,
    bullets,
    pickups,
    events,
  };
}

/** Номер ефекту бонусу для бінарного кодека. */
export const effectToCode = (effect) => Math.max(0, EFFECT_NAMES.indexOf(effect));
export const codeToEffect = (code) => EFFECT_NAMES[code] ?? EFFECT_NAMES[0];

/**
 * Перетворює запис судна з мережевого знімка у формат Ship#applySnapshot / World#syncPlayerShip.
 * Кулдаун ракет клієнту невідомий (ракети не прогнозуються), тому він нульовий.
 */
export function shipStateFromNet(record) {
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
