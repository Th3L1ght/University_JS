/**
 * Геометрія арени: вона тороїдальна - краї "склеєні" (wrap-around).
 */

/**
 * Повертає сутність у прямокутник [0, width) x [0, height).
 *
 * prevPos зсувається на той самий вектор, що й pos. Тоді відрізок prevPos -> pos лишається
 * коротким, і інтерполяція в render не протягує сутність через увесь екран за один кадр.
 * Працює і за великого виходу за межу (наприклад, після зменшення вікна).
 *
 * @param {{ pos: { x: number, y: number }, prevPos: { x: number, y: number } }} entity
 * @param {number} width
 * @param {number} height
 */
export function wrapEntity(entity, width, height) {
  if (width > 0) {
    const shiftX = Math.floor(entity.pos.x / width) * width;
    if (shiftX !== 0) {
      entity.pos.x -= shiftX;
      entity.prevPos.x -= shiftX;
    }
  }
  if (height > 0) {
    const shiftY = Math.floor(entity.pos.y / height) * height;
    if (shiftY !== 0) {
      entity.pos.y -= shiftY;
      entity.prevPos.y -= shiftY;
    }
  }
}

/**
 * Найкоротша знакова різниця координат `to - from` на тороїдальній осі розміру `size`.
 * Потрібна, щоб об'єкти по різні боки краю бачили одне одного сусідами.
 */
export function wrappedDelta(from, to, size) {
  const delta = to - from;
  if (size <= 0) return delta;
  const half = size / 2;
  if (delta > half) return delta - size;
  if (delta < -half) return delta + size;
  return delta;
}
