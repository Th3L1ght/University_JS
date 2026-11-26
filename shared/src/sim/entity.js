/**
 * Базова сутність світу. Усі ігрові об'єкти - це Entity або її прямі нащадки
 * (рівно один рівень успадкування). Додаткову поведінку (самонаведення, підбір бонусу, час життя)
 * підключають через композицію: дані в `entity.components`, логіка - у `behaviors.js`.
 *
 * Ідентифікатор сутності видає світ під час `world.spawn` (лічильник живе у World, а не глобально):
 * так сервер і клієнт, що виконують однакові кроки, отримують однакові id, а знімок світу
 * можна відновити без побічних ефектів.
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

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

export class Entity {
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
    /** 0 - ще не додано у світ; id виставляє World.spawn. */
    this.id = 0;
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

  // --- Знімки (чисті JSON-дані: без посилань на світ і без методів) ---

  /** @returns {object} серіалізований стан сутності */
  toSnapshot() {
    return {
      id: this.id,
      kind: this.kind,
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      angle: this.angle,
      radius: this.radius,
      alive: this.alive,
      collidable: this.collidable,
      components: cloneJson(this.components),
    };
  }

  /** Записує спільні поля знімка в існуючу сутність (prev* вирівнюються з поточним станом). */
  applyBaseSnapshot(data) {
    this.id = data.id;
    this.pos.set(data.x, data.y);
    this.prevPos.set(data.x, data.y);
    this.vel.set(data.vx, data.vy);
    this.angle = data.angle;
    this.prevAngle = data.angle;
    this.alive = data.alive;
    this.components = cloneJson(data.components ?? {});
    return this;
  }

  /** Відновлює базову сутність (наприклад, бонус) зі знімка. */
  static fromSnapshot(data) {
    const entity = new Entity({
      kind: data.kind,
      x: data.x,
      y: data.y,
      angle: data.angle,
      radius: data.radius,
      collidable: data.collidable,
    });
    return entity.applyBaseSnapshot(data);
  }
}
