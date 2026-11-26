/**
 * Малювання кадрів із завантажених спрайт-листів (ctx.drawImage із source-прямокутниками).
 */

import { SPRITE_SCALE } from '../assets/atlas.js';

/**
 * Малює кадр листа так, щоб його центр опинився в точці (dx, dy) поточної системи координат.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ image: CanvasImageSource, frames: Record<string, {x:number,y:number,w:number,h:number}> }} sheet
 * @param {string} frameName
 * @param {{ dx?: number, dy?: number, scale?: number }} [options] scale - додатковий множник розміру
 */
export function drawSprite(ctx, sheet, frameName, { dx = 0, dy = 0, scale = 1 } = {}) {
  const frame = sheet.frames[frameName];
  if (!frame) throw new Error(`Немає кадру "${frameName}" у спрайт-листі`);
  const width = frame.w * SPRITE_SCALE * scale;
  const height = frame.h * SPRITE_SCALE * scale;
  ctx.drawImage(
    sheet.image,
    frame.x,
    frame.y,
    frame.w,
    frame.h,
    dx - width / 2,
    dy - height / 2,
    width,
    height,
  );
}
