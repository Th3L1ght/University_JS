/**
 * Звук через Web Audio API. Модуль підписується на шину подій світу (EventTarget) і відтворює
 * ефекти через AudioBufferSourceNode. Симуляція про звук нічого не знає: залежність спрямована
 * лише від audio -> шина подій.
 */

import { log } from '../util/log.js';

/** Створює AudioContext або повертає null, якщо Web Audio недоступний. */
export function createAudioContext() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Context) return null;
  try {
    return new Context();
  } catch (error) {
    log.warn('audio', `AudioContext не створено: ${error.message}`);
    return null;
  }
}

/**
 * @param {object} options
 * @param {BaseAudioContext | null} options.audioCtx
 * @param {Record<string, AudioBuffer | null>} options.sounds декодовані звуки за id
 * @param {number} [options.volume] загальна гучність 0..1
 * @param {number} [options.maxVoices] ліміт одночасних звуків
 * @param {() => number} [options.random] джерело [0, 1) для невеликого розкиду висоти
 */
export function createAudioSystem({
  audioCtx,
  sounds,
  volume = 0.5,
  maxVoices = 16,
  random = Math.random,
}) {
  const master = audioCtx ? audioCtx.createGain() : null;
  if (master) {
    master.gain.value = volume;
    master.connect(audioCtx.destination);
  }

  let voices = 0;
  let played = 0; // скільки звуків запущено за весь час (для діагностики)
  let muted = false;
  let detachUnlock = () => {};

  /**
   * Розблоковує AudioContext. Браузери дозволяють це лише після жесту користувача, тому
   * викликається з обробника кліку (кнопка Join) та одноразових слухачів нижче.
   */
  let unlocking = null; // спільний проміс: паралельні виклики не розблоковують двічі
  function unlock() {
    if (!audioCtx || audioCtx.state === 'running') return Promise.resolve();
    unlocking ??= audioCtx
      .resume()
      .then(() => log.info('audio', 'AudioContext розблоковано'))
      .catch((error) => log.warn('audio', `не вдалося розблокувати AudioContext: ${error.message}`))
      .finally(() => {
        unlocking = null;
      });
    return unlocking;
  }

  // Перший жест користувача (клік, дотик, клавіша) теж розблоковує звук.
  if (audioCtx && typeof window !== 'undefined') {
    const gestures = ['pointerdown', 'keydown', 'touchstart'];
    const onGesture = () => {
      detachUnlock();
      unlock();
    };
    for (const type of gestures) window.addEventListener(type, onGesture, { once: true });
    detachUnlock = () => {
      for (const type of gestures) window.removeEventListener(type, onGesture);
    };
  }

  /**
   * @param {string} id
   * @param {{ rate?: number, gain?: number }} [options]
   * @returns {boolean} true, якщо звук запущено
   */
  function play(id, { rate = 1, gain = 1 } = {}) {
    const buffer = sounds[id];
    if (!audioCtx || !master || !buffer) return false;
    // Не накопичуємо звуки, поки контекст призупинений: після розблокування вони б вибухнули разом.
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

  /** Обробники подій шини -> звуки. */
  const handlers = {
    fired: (event) => play('fire', { rate: event.detail.missile ? 0.7 : 1, gain: 0.6 }),
    hit: (event) => {
      if (event.detail.destroyed) return; // для знищення є окремий звук вибуху
      play('hit', { rate: event.detail.target.kind === 'ship' ? 0.8 : 1 });
    },
    exploded: (event) => {
      const { kind, size } = event.detail;
      play('explosion', { rate: kind === 'ship' ? 0.75 : 1.3 - 0.15 * size });
    },
    pickup: () => play('pickup'),
  };

  /**
   * Підписується на шину подій (World або будь-який EventTarget).
   * @param {EventTarget} bus
   * @returns {() => void} функція відписки
   */
  function attach(bus) {
    for (const [type, handler] of Object.entries(handlers)) bus.addEventListener(type, handler);
    return () => {
      for (const [type, handler] of Object.entries(handlers))
        bus.removeEventListener(type, handler);
    };
  }

  function setMuted(value) {
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
