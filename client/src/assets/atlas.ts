/**
 * Єдине джерело правди про ассети: розкладка спрайт-атласів, список звуків і маніфест.
 */

import type { AsteroidSize } from '@dogfight/shared';

export const SPRITE_SCALE = 0.5;
export const ASTEROID_VARIANTS = 3;

export interface FrameRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SpriteSheetSpec {
  readonly id: 'sprites' | 'asteroids';
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly frames: Readonly<Record<string, FrameRect>>;
}

const ASTEROID_FRAME_PX: Readonly<Record<AsteroidSize, number>> = Object.freeze({
  3: 190,
  2: 120,
  1: 65,
});
const ASTEROID_ROW_Y: Readonly<Record<AsteroidSize, number>> = Object.freeze({
  3: 0,
  2: 190,
  1: 310,
});
const ASTEROID_CELL_PITCH = 190;

export function asteroidFrameName(size: AsteroidSize, variant: number, hunter: boolean): string {
  return `ast${size}_${variant % ASTEROID_VARIANTS}${hunter ? '_h' : ''}`;
}

function buildAsteroidFrames(): Record<string, FrameRect> {
  const frames: Record<string, FrameRect> = {};
  const sizes: readonly AsteroidSize[] = [3, 2, 1];
  for (const size of sizes) {
    for (const hunter of [false, true]) {
      for (let variant = 0; variant < ASTEROID_VARIANTS; variant += 1) {
        const column = (hunter ? ASTEROID_VARIANTS : 0) + variant;
        frames[asteroidFrameName(size, variant, hunter)] = {
          x: column * ASTEROID_CELL_PITCH,
          y: ASTEROID_ROW_Y[size],
          w: ASTEROID_FRAME_PX[size],
          h: ASTEROID_FRAME_PX[size],
        };
      }
    }
  }
  return frames;
}

export const SPRITE_SHEETS: readonly SpriteSheetSpec[] = Object.freeze([
  {
    id: 'sprites',
    file: 'sprites.svg',
    width: 320,
    height: 160,
    frames: {
      ship: { x: 0, y: 0, w: 96, h: 96 },
      flame_a: { x: 96, y: 0, w: 64, h: 64 },
      flame_b: { x: 160, y: 0, w: 64, h: 64 },
      bullet: { x: 224, y: 0, w: 32, h: 32 },
      missile: { x: 256, y: 0, w: 64, h: 32 },
      pickup_heal: { x: 0, y: 96, w: 64, h: 64 },
      pickup_rapid: { x: 64, y: 96, w: 64, h: 64 },
    },
  },
  {
    id: 'asteroids',
    file: 'asteroids.svg',
    width: 6 * ASTEROID_CELL_PITCH,
    height: 375,
    frames: buildAsteroidFrames(),
  },
]);

export const SOUND_IDS = Object.freeze(['fire', 'hit', 'explosion', 'pickup'] as const);
export type SoundId = (typeof SOUND_IDS)[number];

export interface AssetManifest {
  readonly version: number;
  readonly arena: { readonly id: string; readonly url: string };
  readonly sprites: readonly {
    readonly id: 'sprites' | 'asteroids';
    readonly url: string;
    readonly width: number;
    readonly height: number;
    readonly frames: Readonly<Record<string, FrameRect>>;
  }[];
  readonly sounds: readonly { readonly id: SoundId; readonly url: string }[];
}

export function buildManifest(): AssetManifest {
  return {
    version: 1,
    arena: { id: 'arena', url: './assets/arena.json' },
    sprites: SPRITE_SHEETS.map(({ id, file, width, height, frames }) => ({
      id,
      url: `./assets/${file}`,
      width,
      height,
      frames,
    })),
    sounds: SOUND_IDS.map((id) => ({ id, url: `./assets/sounds/${id}.wav` })),
  };
}
