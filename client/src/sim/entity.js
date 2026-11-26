/**
 * Базова сутність світу. Усі ігрові об'єкти - це Entity або її прямі нащадки
 * (рівно один рівень успадкування). Додаткову поведінку (самонаведення, підбір бонусу, час життя)
 * підключають через композицію: дані в `entity.components`, логіка - у `behaviors.js`.
 */

import { Vector2 } from './vector.js';

/** Імена видів сутностей. */
export const Kind = Object.freeze({
  SHIP: 'ship',
  BULLET: 'bullet',
  ASTEROID: 'asteroid',
  PICKUP: 'pickup',
  EXPLOSION: 'explosion',
});

export class Entity {
  static #nextId = 1;
  #id = Entity.#nextId++;

  /**
   * @param {object} options
   * @param {string} options.kind вид сутності (Kind.*)
   * @param {number} [options.x]
   * @param {number} [options.y]
   * @param {number} [options.angle]
   * @param {number} [options.radius] радіус кола зіткнень
   * @param {boolean} [options.collidable] чи бере участь у зіткненнях
   */
  constructor({ kind, x = 0, y = 0, angle = 0, radius = 1, collidable = true }) {
    this.kind = kind;
    this.pos = new Vector2(x, y);
    this.prevPos = new Vector2(x, y); // позиція попереднього кроку - для інтерполяції в render
    this.vel = new Vector2(0, 0);
    this.angle = angle;
    this.prevAngle = angle;
    this.radius = radius;
    this.alive = true;
    this.collidable = collidable;
    /** Композиційні компоненти-дані: { homing, pickup, lifetime, ... }. Див. behaviors.js. */
    this.components = {};
    /** Світ, у якому сутність зараз живе. Виставляє World.spawn, скидає очищення мертвих. */
    this.world = null;
  }

  get id() {
    return this.#id;
  }

  /** Запам'ятовує поточний стан як "попередній". Викликати на початку update. */
  savePrev() {
    this.prevPos.copyFrom(this.pos);
    this.prevAngle = this.angle;
  }

  /** Один крок руху з постійною швидкістю. Нащадки перевизначають і викликають super.update. */
  update(dt) {
    this.savePrev();
    this.pos.addScaledInPlace(this.vel, dt);
  }

  /** Миттєве переміщення без інтерполяційного "шлейфу". */
  teleport(x, y) {
    this.pos.set(x, y);
    this.prevPos.set(x, y);
  }
}
