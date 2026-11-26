/**
 * Резервний режим для file://. Коли гру відкрито подвійним кліком, браузер вважає сторінку
 * джерелом "null" і блокує fetch до сусідніх файлів. Тому ассети тут не читаються, а будуються:
 *  - спрайти - SVG-текст з sprite_art.js, переданий як data-URI (new Image працює і з file://);
 *  - звуки - семпли з sound_synth.js, з яких напряму створюється AudioBuffer;
 *  - конфіг арени - константа DEFAULT_ARENA.
 */

import { SOUND_IDS, SPRITE_SHEETS } from './atlas.js';
import { DEFAULT_ARENA } from './defaults.js';
import { buildSpriteSheetSvg, svgToDataUri } from './sprite_art.js';
import { SOUND_SAMPLE_RATE, synthSound } from './sound_synth.js';

/** Маніфест тієї самої форми, що й public/assets/manifest.json, але без жодного запиту. */
export function buildEmbeddedManifest() {
  return {
    version: 1,
    embedded: true,
    arena: { id: 'arena', inline: DEFAULT_ARENA },
    sprites: SPRITE_SHEETS.map(({ id, width, height, frames }) => ({
      id,
      url: svgToDataUri(buildSpriteSheetSvg(id)),
      width,
      height,
      frames,
    })),
    sounds: SOUND_IDS.map((id) => ({ id, synth: true })),
  };
}

/** Створює AudioBuffer із синтезованих семплів. */
export function synthAudioBuffer(audioCtx, id) {
  const samples = synthSound(id);
  const buffer = audioCtx.createBuffer(1, samples.length, SOUND_SAMPLE_RATE);
  buffer.copyToChannel(samples, 0);
  return buffer;
}
