/**
 * Резервний режим для file://: вбудовані спрайти (data-URI SVG), синтезовані звуки та arena.
 */

import { SOUND_IDS, SPRITE_SHEETS, type FrameRect, type SoundId } from './atlas.ts';
import { DEFAULT_ARENA, type ArenaConfig } from './defaults.ts';
import { SOUND_SAMPLE_RATE, synthSound } from './sound_synth.ts';
import { buildSpriteSheetSvg, svgToDataUri } from './sprite_art.ts';

export interface LoadableManifest {
  readonly version: number;
  readonly embedded?: boolean;
  readonly arena: {
    readonly id: string;
    readonly url?: string;
    readonly inline?: ArenaConfig;
  };
  readonly sprites: readonly {
    readonly id: 'sprites' | 'asteroids';
    readonly url: string;
    readonly width: number;
    readonly height: number;
    readonly frames: Readonly<Record<string, FrameRect>>;
  }[];
  readonly sounds: readonly {
    readonly id: SoundId;
    readonly url?: string;
    readonly synth?: boolean;
  }[];
}

export function buildEmbeddedManifest(): LoadableManifest {
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

export function synthAudioBuffer(audioCtx: BaseAudioContext, id: SoundId): AudioBuffer {
  const samples = synthSound(id);
  const buffer = audioCtx.createBuffer(1, samples.length, SOUND_SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  channel.set(samples);
  return buffer;
}
