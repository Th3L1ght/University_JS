/**
 * Двовимірний вектор.
 *
 * Методи add, sub, scale, normalize, rotate - чисті (immutable): повертають новий Vector2 і не
 * змінюють `this`. Для гарячих шляхів є мутуючі *InPlace-методи та set/copyFrom: вони не
 * створюють нових об'єктів, тому не навантажують збирач сміття на кожному кроці симуляції.
 */
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  /** Одиничний (або довжини `length`) вектор напрямку `angle`. */
  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  clone() {
    return new Vector2(this.x, this.y);
  }

  add(other) {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  sub(other) {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  scale(factor) {
    return new Vector2(this.x * factor, this.y * factor);
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  /** Одиничний вектор того ж напрямку; для нульового вектора повертає нульовий. */
  normalize() {
    const len = this.length();
    return len === 0 ? new Vector2(0, 0) : new Vector2(this.x / len, this.y / len);
  }

  /** Поворот навколо початку координат на `angle` радіанів. */
  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  dot(other) {
    return this.x * other.x + this.y * other.y;
  }

  // --- Мутуючі методи для гарячих шляхів ---

  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }

  copyFrom(other) {
    this.x = other.x;
    this.y = other.y;
    return this;
  }

  addInPlace(other) {
    this.x += other.x;
    this.y += other.y;
    return this;
  }

  /** this += other * factor, без проміжного вектора. */
  addScaledInPlace(other, factor) {
    this.x += other.x * factor;
    this.y += other.y * factor;
    return this;
  }

  scaleInPlace(factor) {
    this.x *= factor;
    this.y *= factor;
    return this;
  }
}
