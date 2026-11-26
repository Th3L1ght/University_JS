/**
 * Геометрія арени: вона тороїдальна - краї "склеєні" (wrap-around).
 */

import { Vector2 } from './vector.ts';

export interface WrappableEntity {
  pos: Vector2;
  prevPos: Vector2;
}

/**
 * Повертає сутність у прямокутник [0, width) x [0, height).
 * prevPos зсувається на той самий вектор, щоб інтерполяція не тягнула сутність через увесь екран.
 */
export function wrapEntity(entity: WrappableEntity, width: number, height: number): void {
  let shiftX = 0;
  let shiftY = 0;
  if (width > 0) shiftX = Math.floor(entity.pos.x / width) * width;
  if (height > 0) shiftY = Math.floor(entity.pos.y / height) * height;
  if (shiftX !== 0 || shiftY !== 0) {
    entity.pos = new Vector2(entity.pos.x - shiftX, entity.pos.y - shiftY);
    entity.prevPos = new Vector2(entity.prevPos.x - shiftX, entity.prevPos.y - shiftY);
  }
}

/**
 * Найкоротша знакова різниця координат `to - from` на тороїдальній осі розміру `size`.
 */
export function wrappedDelta(from: number, to: number, size: number): number {
  const delta = to - from;
  if (size <= 0) return delta;
  const half = size / 2;
  if (delta > half) return delta - size;
  if (delta < -half) return delta + size;
  return delta;
}
