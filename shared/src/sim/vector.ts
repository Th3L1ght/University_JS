/**
 * Незмінний двовимірний вектор (readonly x, readonly y).
 *
 * Усі операції повертають новий Vector2, тому випадкове розділення посилання між сутностями
 * не може зіпсувати координати чи швидкість іншого об'єкта.
 */

export interface Vec2Like {
  readonly x: number;
  readonly y: number;
}

export class Vector2 implements Vec2Like {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static readonly ZERO = new Vector2(0, 0);

  /** Одиничний (або довжини `length`) вектор напрямку `angle`. */
  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static from(other: Vec2Like): Vector2 {
    return new Vector2(other.x, other.y);
  }

  clone(): Vector2 {
    return new Vector2(this.x, this.y);
  }

  add(other: Vec2Like): Vector2 {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  addScaled(other: Vec2Like, factor: number): Vector2 {
    return new Vector2(this.x + other.x * factor, this.y + other.y * factor);
  }

  sub(other: Vec2Like): Vector2 {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  scale(factor: number): Vector2 {
    return new Vector2(this.x * factor, this.y * factor);
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  /** Одиничний вектор того ж напрямку; для нульового вектора повертає нульовий. */
  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? Vector2.ZERO : new Vector2(this.x / len, this.y / len);
  }

  /** Поворот навколо початку координат на `angle` радіанів. */
  rotate(angle: number): Vector2 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  dot(other: Vec2Like): number {
    return this.x * other.x + this.y * other.y;
  }
}
