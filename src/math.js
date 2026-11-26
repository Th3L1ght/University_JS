/** Дрібні чисті математичні помічники. Без залежностей від DOM. */

export const TAU = Math.PI * 2;

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Зводить кут до діапазону (-PI, PI]. */
export function wrapAngle(angle) {
  const wrapped = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

/** Найкоротша знакова різниця кутів from -> to, у діапазоні (-PI, PI]. */
export function shortestAngleDelta(from, to) {
  return wrapAngle(to - from);
}

/** Лінійна інтерполяція кутів за найкоротшою дугою (через межу -PI/PI). */
export function lerpAngle(from, to, t) {
  return from + shortestAngleDelta(from, to) * t;
}
