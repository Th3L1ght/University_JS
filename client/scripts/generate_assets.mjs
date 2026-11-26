/**
 * Генератор статичних ассетів гри: SVG-спрайти, WAV-звуки, маніфест, конфіг арени, кімнати лобі.
 * Запуск: npm run assets:generate
 *
 * Усе будується з тих самих модулів, які гра використовує як резервні дані для file://,
 * тому файли в public/ і вбудовані дані завжди узгоджені.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { buildManifest, SOUND_IDS, SPRITE_SHEETS } from '../src/assets/atlas.ts';
import { buildSpriteSheetSvg } from '../src/assets/sprite_art.ts';
import { SOUND_SAMPLE_RATE, synthSound } from '../src/assets/sound_synth.ts';
import { DEFAULT_ARENA, DEFAULT_ROOMS } from '../src/assets/defaults.ts';

const publicDir = new URL('../public/', import.meta.url);

/** Кодує моно-семпли як 16-бітний PCM WAV. */
function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // розмір блоку fmt
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // канали
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // байт/с
  buffer.writeUInt16LE(2, 32); // вирівнювання блоку
  buffer.writeUInt16LE(16, 34); // біт на семпл
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  }
  return buffer;
}

const writeJson = (relativePath, value) =>
  writeFileSync(new URL(relativePath, publicDir), `${JSON.stringify(value, null, 2)}\n`, 'utf8');

mkdirSync(new URL('assets/sounds/', publicDir), { recursive: true });
mkdirSync(new URL('api/', publicDir), { recursive: true });

for (const sheet of SPRITE_SHEETS) {
  writeFileSync(new URL(`assets/${sheet.file}`, publicDir), buildSpriteSheetSvg(sheet.id), 'utf8');
}

for (const id of SOUND_IDS) {
  const wav = encodeWav(synthSound(id), SOUND_SAMPLE_RATE);
  writeFileSync(new URL(`assets/sounds/${id}.wav`, publicDir), wav);
}

writeJson('assets/manifest.json', buildManifest());
writeJson('assets/arena.json', DEFAULT_ARENA);
writeJson('api/rooms.json', DEFAULT_ROOMS);

console.log('Ассети згенеровано в public/: SVG, WAV, manifest.json, arena.json, rooms.json');
