/**
 * Звук через Web Audio API. Підписується на типізовану шину подій `Bus<GameEvents>`.
 */

import type { Bus, GameEvents } from '../util/bus.ts';
import { log } from '../util/log.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAudioContext(): AudioContext | null {
  const Context = globalThis.AudioContext;
  if (!Context) return null;
  try {
    return new Context();
  } catch (error: unknown) {
    log.warn('audio', `AudioContext не створено: ${errorMessage(error)}`);
    return null;
  }
}

export interface AudioSystemOptions {
  readonly audioCtx: AudioContext | null;
  readonly sounds: Readonly<Record<string, AudioBuffer | null>>;
  readonly volume?: number;
  readonly maxVoices?: number;
  readonly random?: () => number;
}

export interface AudioSystem {
  attach(bus: Bus<GameEvents>): () => void;
  unlock(): Promise<void>;
  play(id: string, options?: { readonly rate?: number; readonly gain?: number }): boolean;
  setMuted(value: boolean): void;
  toggleMute(): boolean;
  readonly played: number;
  readonly muted: boolean;
  readonly state: AudioContextState | 'unavailable';
}

export function createAudioSystem({
  audioCtx,
  sounds,
  volume = 0.5,
  maxVoices = 16,
  random = Math.random,
}: AudioSystemOptions): AudioSystem {
  const master = audioCtx ? audioCtx.createGain() : null;
  if (master && audioCtx) {
    master.gain.value = volume;
    master.connect(audioCtx.destination);
  }

  let voices = 0;
  let played = 0;
  let muted = false;
  let detachUnlock = (): void => {};

  let unlocking: Promise<void> | null = null;
  function unlock(): Promise<void> {
    if (!audioCtx || audioCtx.state === 'running') return Promise.resolve();
    unlocking ??= audioCtx
      .resume()
      .then(() => log.info('audio', 'AudioContext розблоковано'))
      .catch((error: unknown) =>
        log.warn('audio', `не вдалося розблокувати AudioContext: ${errorMessage(error)}`),
      )
      .finally(() => {
        unlocking = null;
      });
    return unlocking;
  }

  if (audioCtx && typeof window !== 'undefined') {
    const gestures = ['pointerdown', 'keydown', 'touchstart'] as const;
    const onGesture = (): void => {
      detachUnlock();
      void unlock();
    };
    for (const type of gestures) window.addEventListener(type, onGesture, { once: true });
    detachUnlock = () => {
      for (const type of gestures) window.removeEventListener(type, onGesture);
    };
  }

  function play(
    id: string,
    { rate = 1, gain = 1 }: { readonly rate?: number; readonly gain?: number } = {},
  ): boolean {
    const buffer = sounds[id];
    if (!audioCtx || !master || !buffer) return false;
    if (audioCtx.state !== 'running' || voices >= maxVoices) return false;

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate * (0.96 + random() * 0.08);

    const voiceGain = audioCtx.createGain();
    voiceGain.gain.value = gain;
    source.connect(voiceGain);
    voiceGain.connect(master);

    voices += 1;
    source.onended = () => {
      voices -= 1;
      source.disconnect();
      voiceGain.disconnect();
    };
    source.start();
    played += 1;
    return true;
  }

  function attach(bus: Bus<GameEvents>): () => void {
    const unsubs = [
      bus.on('fired', ({ missile }) => play('fire', { rate: missile ? 0.7 : 1, gain: 0.6 })),
      bus.on('hit', ({ target, destroyed }) => {
        if (destroyed) return;
        play('hit', { rate: target.kind === 'ship' ? 0.8 : 1 });
      }),
      bus.on('exploded', ({ kind, size }) => {
        play('explosion', { rate: kind === 'ship' ? 0.75 : 1.3 - 0.15 * size });
      }),
      bus.on('pickup', () => play('pickup')),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }

  function setMuted(value: boolean): void {
    muted = value;
    if (master) master.gain.value = muted ? 0 : volume;
  }

  return {
    attach,
    unlock,
    play,
    setMuted,
    toggleMute: () => {
      setMuted(!muted);
      return muted;
    },
    get played() {
      return played;
    },
    get muted() {
      return muted;
    },
    get state() {
      return audioCtx?.state ?? 'unavailable';
    },
  };
}
