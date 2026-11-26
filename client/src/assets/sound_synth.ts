/**
 * Процедурний синтез коротких ефектів. Повертає PCM-семпли (Float32Array, моно).
 */

import { createRng } from '@dogfight/shared';
import type { SoundId } from './atlas.ts';

export const SOUND_SAMPLE_RATE = 22050;
const FADE_SECONDS = 0.005;

function render(
  duration: number,
  rate: number,
  sampleAt: (t: number, i: number) => number,
): Float32Array {
  const length = Math.floor(duration * rate);
  const samples = new Float32Array(length);
  const fade = Math.max(1, Math.floor(FADE_SECONDS * rate));
  for (let i = 0; i < length; i += 1) {
    let value = sampleAt(i / rate, i);
    value = Math.max(-1, Math.min(1, value));
    const tail = length - i;
    samples[i] = tail < fade ? value * (tail / fade) : value;
  }
  return samples;
}

const SYNTHS: Readonly<Record<SoundId, (rate: number) => Float32Array>> = {
  fire(rate) {
    let phase = 0;
    return render(0.16, rate, (t) => {
      const frequency = 180 + 700 * Math.exp(-t * 18);
      phase += (Math.PI * 2 * frequency) / rate;
      const tone = (Math.sin(phase) > 0 ? 1 : -1) * 0.5 + Math.sin(phase) * 0.5;
      return tone * Math.exp(-t * 20) * 0.45;
    });
  },

  hit(rate) {
    const rng = createRng(11);
    let filtered = 0;
    return render(0.12, rate, (t) => {
      filtered += 0.35 * (rng() * 2 - 1 - filtered);
      const thump = Math.sin(Math.PI * 2 * 220 * t) * 0.5 * Math.exp(-t * 40);
      return (filtered * 1.6 + thump) * Math.exp(-t * 28) * 0.8;
    });
  },

  explosion(rate) {
    const rng = createRng(23);
    let filtered = 0;
    return render(0.8, rate, (t) => {
      filtered += 0.08 * (rng() * 2 - 1 - filtered);
      const rumble = filtered * 4 * Math.exp(-t * 4.5);
      const boom = Math.sin(Math.PI * 2 * 55 * t * (1 - t * 0.5)) * 0.6 * Math.exp(-t * 3.5);
      return (rumble + boom) * 0.9;
    });
  },

  pickup(rate) {
    const notes = [660, 880, 1320];
    return render(0.3, rate, (t) => {
      const index = Math.min(notes.length - 1, Math.floor(t / 0.1));
      const local = t - index * 0.1;
      const note = notes[index] ?? 660;
      return Math.sin(Math.PI * 2 * note * local) * Math.exp(-local * 14) * 0.4;
    });
  },
};

export function synthSound(id: SoundId, rate = SOUND_SAMPLE_RATE): Float32Array {
  return SYNTHS[id](rate);
}
