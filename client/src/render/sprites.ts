/**
 * Малювання кадрів із завантажених спрайт-листів.
 */

import { SPRITE_SCALE, type FrameRect } from '../assets/atlas.ts';

export interface LoadedSpriteSheet {
  readonly image: CanvasImageSource;
  readonly frames: Readonly<Record<string, FrameRect>>;
}

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sheet: LoadedSpriteSheet,
  frameName: string,
  {
    dx = 0,
    dy = 0,
    scale = 1,
  }: { readonly dx?: number; readonly dy?: number; readonly scale?: number } = {},
): void {
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
