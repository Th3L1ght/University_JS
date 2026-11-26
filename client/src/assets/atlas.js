/**
 * Єдине джерело правди про ассети: розкладка спрайт-атласів, список звуків і маніфест.
 * Модуль чистий (без DOM), тому його використовують і рантайм гри, і Node-скрипт
 * scripts/generate_assets.mjs, який створює файли в public/assets/.
 */

/** Кадри в атласах намальовані у 2× роздільності; на екран їх виводять із масштабом 0.5. */
export const SPRITE_SCALE = 0.5;

export const ASTEROID_VARIANTS = 3;

const ASTEROID_FRAME_PX = Object.freeze({ 3: 190, 2: 120, 1: 65 });
const ASTEROID_ROW_Y = Object.freeze({ 3: 0, 2: 190, 1: 310 });
const ASTEROID_CELL_PITCH = 190;

/** Ім'я кадру астероїда: розмір, варіант форми, чи це «мисливець». */
export function asteroidFrameName(size, variant, hunter) {
  return `ast${size}_${variant % ASTEROID_VARIANTS}${hunter ? '_h' : ''}`;
}

function buildAsteroidFrames() {
  const frames = {};
  for (const size of [3, 2, 1]) {
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

/** Спрайт-листи. Усі координати - у пікселях листа. */
export const SPRITE_SHEETS = Object.freeze([
  {
    id: 'sprites',
    file: 'sprites.svg',
    width: 320,
    height: 160,
    frames: {
      ship: { x: 0, y: 0, w: 96, h: 96 }, // ніс спрямований уздовж +X
      flame_a: { x: 96, y: 0, w: 64, h: 64 }, // полум'я: основа праворуч, язик ліворуч
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

export const SOUND_IDS = Object.freeze(['fire', 'hit', 'explosion', 'pickup']);

/** Маніфест, що лежить у public/assets/manifest.json. */
export function buildManifest() {
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
