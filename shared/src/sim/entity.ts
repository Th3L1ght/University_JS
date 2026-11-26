/**
 * Базова сутність світу. Усі ігрові об'єкти - це Entity або її прямі нащадки
 * (рівно один рівень успадкування). Додаткову поведінку (самонаведення, підбір бонусу, час життя)
 * підключають через композицію: дані в `entity.components`, логіка - у `behaviors.ts`.
 */

import { asEntityId, type EntityId } from '../types.ts';
import { Vector2 } from './vector.ts';

/** Імена видів сутностей (erasable-сумісний `as const` замість enum). */
export const Kind = {
  SHIP: 'ship',
  BULLET: 'bullet',
  ASTEROID: 'asteroid',
  PICKUP: 'pickup',
  EXPLOSION: 'explosion',
} as const;

export type EntityKind = (typeof Kind)[keyof typeof Kind];

export interface HomingComponent {
  readonly turnRate: number;
  readonly range: number;
  readonly targetKinds: readonly EntityKind[];
}

export type PickupEffect =
  | { readonly type: 'heal'; readonly amount: number }
  | { readonly type: 'rapid'; readonly duration: number };

export interface PickupComponent {
  readonly effect: PickupEffect;
}

export interface LifetimeComponent {
  remaining: number;
}

export interface EntityComponents {
  homing?: HomingComponent;
  pickup?: PickupComponent;
  lifetime?: LifetimeComponent;
}

/** Спільні поля знімка для всіх варіантів дискримінованого об'єднання EntitySnapshot. */
export interface BaseEntitySnapshot {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly radius: number;
  readonly alive: boolean;
  readonly collidable: boolean;
  readonly components: EntityComponents;
}

export interface PickupSnapshot extends BaseEntitySnapshot {
  readonly kind: typeof Kind.PICKUP;
}

/** Мінімальний контракт світу, необхідний сутностям (розриває циклічну залежність). */
export interface WorldHost {
  readonly width: number;
  readonly height: number;
  spawn<T extends Entity>(entity: T): T;
  emit(type: string, detail?: Record<string, unknown>): void;
}

export interface EntityOptions {
  readonly kind: EntityKind;
  readonly x?: number;
  readonly y?: number;
  readonly angle?: number;
  readonly radius?: number;
  readonly collidable?: boolean;
}

function cloneComponents(components: EntityComponents): EntityComponents {
  const out: EntityComponents = {};
  if (components.homing) {
    out.homing = {
      turnRate: components.homing.turnRate,
      range: components.homing.range,
      targetKinds: [...components.homing.targetKinds],
    };
  }
  if (components.pickup) {
    out.pickup = { effect: { ...components.pickup.effect } };
  }
  if (components.lifetime) {
    out.lifetime = { remaining: components.lifetime.remaining };
  }
  return out;
}

export class Entity {
  /** 0 - ще не додано у світ; id виставляє World.spawn. */
  id: EntityId = asEntityId(0);
  readonly kind: EntityKind;
  pos: Vector2;
  prevPos: Vector2;
  vel: Vector2;
  angle: number;
  prevAngle: number;
  radius: number;
  alive: boolean;
  collidable: boolean;
  components: EntityComponents;
  world: WorldHost | null;

  constructor({ kind, x = 0, y = 0, angle = 0, radius = 1, collidable = true }: EntityOptions) {
    this.kind = kind;
    this.pos = new Vector2(x, y);
    this.prevPos = new Vector2(x, y);
    this.vel = Vector2.ZERO;
    this.angle = angle;
    this.prevAngle = angle;
    this.radius = radius;
    this.alive = true;
    this.collidable = collidable;
    this.components = {};
    this.world = null;
  }

  /** Запам'ятовує поточний стан як "попередній". Викликати на початку update. */
  savePrev(): void {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  /** Один крок руху з постійною швидкістю. Нащадки перевизначають і викликають super.update. */
  update(dt: number): void {
    this.savePrev();
    this.pos = this.pos.addScaled(this.vel, dt);
  }

  /** Миттєве переміщення без інтерполяційного "шлейфу". */
  teleport(x: number, y: number): void {
    const point = new Vector2(x, y);
    this.pos = point;
    this.prevPos = point;
  }

  /** @returns серіалізований стан сутності */
  toSnapshot(): BaseEntitySnapshot {
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
      components: cloneComponents(this.components),
    };
  }

  /** Записує спільні поля знімка в існуючу сутність (prev* вирівнюються з поточним станом). */
  applyBaseSnapshot(data: {
    readonly id: EntityId;
    readonly x: number;
    readonly y: number;
    readonly vx: number;
    readonly vy: number;
    readonly angle: number;
    readonly alive: boolean;
    readonly components?: EntityComponents;
  }): this {
    this.id = asEntityId(data.id);
    const point = new Vector2(data.x, data.y);
    this.pos = point;
    this.prevPos = point;
    this.vel = new Vector2(data.vx, data.vy);
    this.angle = data.angle;
    this.prevAngle = data.angle;
    this.alive = data.alive;
    this.components = data.components ? cloneComponents(data.components) : {};
    return this;
  }

  /** Відновлює базову сутність (наприклад, бонус) зі знімка. */
  static fromSnapshot(data: BaseEntitySnapshot): Entity {
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
