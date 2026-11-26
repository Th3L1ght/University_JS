/**
 * Серверні ШІ-боти. Використовують ТОЧНО ТОЙ САМИЙ інтерфейс вводу (`match.submitInput`),
 * що й живі гравці: переслідування, ухиляння від астероїдів і прицільна стрільба.
 */

import {
  asSeq,
  Kind,
  shortestAngleDelta,
  wrappedDelta,
  type Entity,
  type Seq,
} from '@dogfight/shared';
import type { Match } from './match.ts';

export interface BotInfo {
  readonly id: string;
  readonly nickname: string;
}

interface BotState {
  readonly id: string;
  readonly nickname: string;
  seq: Seq;
}

export class BotManager {
  #bots = new Map<string, BotState[]>(); // roomId -> BotState[]
  #nextBotNum = 1;

  addBots(match: Match, count: number): BotInfo[] {
    const list = this.#bots.get(match.roomId) ?? [];
    if (!this.#bots.has(match.roomId)) this.#bots.set(match.roomId, list);

    const added: BotInfo[] = [];
    for (let i = 0; i < count; i += 1) {
      const num = this.#nextBotNum++;
      const id = `bot-${num}`;
      const nickname = `Bot-${num}`;
      match.addPlayer(id, {
        nickname,
        codec: 'binary',
        send: () => {
          /* ботам не потрібно відправляти мережеві кадри */
        },
      });
      list.push({ id, nickname, seq: asSeq(0) });
      added.push({ id, nickname });
    }
    return added;
  }

  /** Обчислює й подає команди всіх ботів кімнати через стандартний `match.submitInput`. */
  stepBots(match: Match): void {
    const list = this.#bots.get(match.roomId);
    if (!list || list.length === 0) return;

    const world = match.world;
    for (const bot of list) {
      const player = world.getPlayer(bot.id);
      if (!player || !player.ship.alive) continue;

      const ship = player.ship;
      let nearestTarget: Entity | null = null;
      let nearestDistSq = Infinity;
      let threat: Entity | null = null;
      let threatDistSq = 130 * 130;

      for (const entity of world) {
        if (!entity.alive || entity === ship) continue;
        if (entity.kind !== Kind.SHIP && entity.kind !== Kind.ASTEROID) continue;
        const dx = wrappedDelta(ship.pos.x, entity.pos.x, world.width);
        const dy = wrappedDelta(ship.pos.y, entity.pos.y, world.height);
        const distSq = dx * dx + dy * dy;

        if (entity.kind === Kind.ASTEROID && distSq < threatDistSq) {
          threatDistSq = distSq;
          threat = entity;
        }
        // Пріоритет цілей: інші кораблі, інакше астероїди.
        const weighted = entity.kind === Kind.SHIP ? distSq * 0.6 : distSq;
        if (weighted < nearestDistSq) {
          nearestDistSq = weighted;
          nearestTarget = entity;
        }
      }

      let turn = 0;
      let thrust = false;
      let fire = false;

      if (threat) {
        // Ухиляння від близького астероїда: розворот від нього й тяга.
        const dx = wrappedDelta(threat.pos.x, ship.pos.x, world.width);
        const dy = wrappedDelta(threat.pos.y, ship.pos.y, world.height);
        const awayAngle = Math.atan2(dy, dx);
        const delta = shortestAngleDelta(ship.angle, awayAngle);
        turn = Math.abs(delta) < 0.15 ? 0 : delta > 0 ? 1 : -1;
        thrust = Math.abs(delta) < 1.1;
      } else if (nearestTarget) {
        const dx = wrappedDelta(ship.pos.x, nearestTarget.pos.x, world.width);
        const dy = wrappedDelta(ship.pos.y, nearestTarget.pos.y, world.height);
        const targetAngle = Math.atan2(dy, dx);
        const delta = shortestAngleDelta(ship.angle, targetAngle);
        turn = Math.abs(delta) < 0.08 ? 0 : delta > 0 ? 1 : -1;
        const dist = Math.hypot(dx, dy);
        thrust = dist > 180 && Math.abs(delta) < 0.9;
        fire = Math.abs(delta) < 0.28 && dist < 560;
      }

      bot.seq = asSeq(bot.seq + 1);
      match.submitInput(bot.id, {
        seq: bot.seq,
        tick: match.tick,
        thrust,
        turn,
        fire,
        missile: false,
        prev: [],
      });
    }
  }

  removeRoom(roomId: string): void {
    this.#bots.delete(roomId);
  }

  count(roomId: string): number {
    return this.#bots.get(roomId)?.length ?? 0;
  }
}
