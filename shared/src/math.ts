/** Дрібні чисті математичні помічники. Без залежностей від DOM. */

export const TAU = Math.PI * 2;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Зводить кут до діапазону (-PI, PI]. */
export function wrapAngle(angle: number): number {
  const wrapped = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

/** Найкоротша знакова різниця кутів from -> to, у діапазоні (-PI, PI]. */
export function shortestAngleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Лінійна інтерполяція кутів за найкоротшою дугою (через межу -PI/PI). */
export function lerpAngle(from: number, to: number, t: number): number {
  return from + shortestAngleDelta(from, to) * t;
}
