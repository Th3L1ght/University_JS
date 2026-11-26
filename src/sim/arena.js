/**
 * Межі арени: безшовний перенос (wrap-around) через краї.
 */

/**
 * Повертає судно в прямокутник [0, width) x [0, height).
 *
 * prevX/prevY зсуваються на той самий вектор, що й x/y. Тоді відрізок prev -> current лишається
 * коротким, і інтерполяція в render не протягує судно через увесь екран за один кадр.
 * Працює і за великого виходу за межу (наприклад, після зменшення вікна).
 *
 * @param {{ x: number, y: number, prevX: number, prevY: number }} ship змінюється на місці
 * @param {number} width
 * @param {number} height
 */
export function wrapShip(ship, width, height) {
  if (width > 0) {
    const shiftX = Math.floor(ship.x / width) * width;
    if (shiftX !== 0) {
      ship.x -= shiftX;
      ship.prevX -= shiftX;
    }
  }
  if (height > 0) {
    const shiftY = Math.floor(ship.y / height) * height;
    if (shiftY !== 0) {
      ship.y -= shiftY;
      ship.prevY -= shiftY;
    }
  }
}
