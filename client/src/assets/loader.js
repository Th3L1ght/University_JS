/**
 * Асинхронний завантажувач ассетів.
 *
 * Принципи:
 *  - кожна операція приймає AbortSignal і негайно завершується, коли його скасовано;
 *  - помилки типізовані (HttpError, NetworkError, JsonParseError, AssetDecodeError), тому
 *    withRetry повторює лише мережеві збої, таймаути та відповіді 5xx, але ніколи не 4xx;
 *  - критичні ассети (спрайти, конфіг арени) вантажаться через Promise.all, некритичні (звуки) -
 *    через Promise.allSettled: відсутній звук не зупиняє запуск гри;
 *  - у режимі file:// fetch заборонено браузером, тому використовуються вбудовані дані
 *    (див. fallback.js).
 */

import { backoffDelay } from '../util/backoff.js';
import { log } from '../util/log.js';
import { buildEmbeddedManifest, synthAudioBuffer } from './fallback.js';

// --- Помилки ---

export class HttpError extends Error {
  /** @param {unknown} [body] розібране JSON-тіло відповіді з помилкою (якщо воно було) */
  constructor(status, url, statusText = '', body = null) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}: ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class NetworkError extends Error {
  constructor(url, cause) {
    super(`Мережевий збій: ${url}`, { cause });
    this.name = 'NetworkError';
    this.url = url;
  }
}

export class JsonParseError extends Error {
  constructor(url, cause) {
    super(`Пошкоджений JSON: ${url}`, { cause });
    this.name = 'JsonParseError';
    this.url = url;
  }
}

export class AssetDecodeError extends Error {
  constructor(url, cause) {
    super(`Не вдалося декодувати ассет: ${url}`, { cause });
    this.name = 'AssetDecodeError';
    this.url = url;
  }
}

/**
 * Зображення не завантажилось, хоча сервер на запит-діагностику відповідає успішно. Причину
 * з боку браузера не видно: це може бути збій на льоту (тоді повтор допоможе) або битий файл
 * (тоді після вичерпання спроб користувач побачить помилку). Тому такий збій повторюваний.
 */
export class ImageLoadError extends Error {
  constructor(url, cause) {
    super(`Не вдалося завантажити зображення (сервер відповідає): ${url}`, { cause });
    this.name = 'ImageLoadError';
    this.url = url;
  }
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Скасування користувачем (AbortError) або таймаут сигналу (TimeoutError). */
export function isAbortLike(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

/**
 * Чи варто повторити операцію. Повторюємо мережеві збої, таймаути та HTTP 5xx.
 * Ніколи не повторюємо: скасування (AbortError), HTTP 4xx, пошкоджений JSON, помилки декодування.
 */
export function isRetryable(error) {
  if (!error || error.name === 'AbortError') return false;
  if (error.name === 'TimeoutError') return true;
  if (error instanceof HttpError) return error.status >= 500;
  return error instanceof NetworkError || error instanceof ImageLoadError;
}

export const isFileProtocol = () => globalThis.location?.protocol === 'file:';

// --- Допоміжні функції для сигналів і пауз ---

export function abortReason(signal) {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Сигнал, що спрацьовує, коли спрацює будь-який із переданих (AbortSignal.any з запасним шляхом). */
export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);

  const controller = new AbortController();
  for (const source of list) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

/** Пауза, що переривається сигналом. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// --- Мережеві утиліти ---

async function fetchOk(url, { signal, ...init } = {}) {
  let response;
  try {
    response = await fetch(url, { signal, ...init });
  } catch (error) {
    if (isAbortLike(error) || signal?.aborted) throw error;
    throw new NetworkError(url, error);
  }
  if (!response.ok) {
    // Сервер зазвичай пояснює відмову в JSON ({ error, message, details }) - зберігаємо це тіло.
    const body = await response.json().catch(() => null);
    throw new HttpError(response.status, url, response.statusText, body);
  }
  return response;
}

/**
 * GET і розбір JSON. HTTP-помилки (404, 500, ...) перетворюються на HttpError зі статусом,
 * зламаний JSON - на JsonParseError.
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function fetchJson(url, { signal, json } = {}) {
  // json !== undefined -> POST із JSON-тілом (створення кімнати); інакше звичайний GET.
  const init =
    json === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(json),
        };
  const response = await fetchOk(url, { signal, ...init });
  try {
    return await response.json();
  } catch (error) {
    if (isAbortLike(error) || signal?.aborted) throw error;
    throw new JsonParseError(url, error);
  }
}

/**
 * Після помилки завантаження зображення (подія error не містить статусу) з'ясовує причину
 * запитом HEAD: 4xx/5xx -> HttpError, немає зв'язку -> NetworkError, сервер відповідає, але
 * зображення не відкрилось -> ImageLoadError (повторюваний). Для data:-URI запиту немає:
 * вбудовані дані або валідні, або зламані назавжди -> AssetDecodeError.
 */
async function classifyImageFailure(url, signal) {
  if (url.startsWith('data:')) return new AssetDecodeError(url.slice(0, 40), null);
  try {
    const response = await fetch(url, { method: 'HEAD', signal });
    if (!response.ok) return new HttpError(response.status, url, response.statusText);
    return new ImageLoadError(url, null);
  } catch (error) {
    if (isAbortLike(error) || signal?.aborted) return error;
    return new NetworkError(url, error);
  }
}

/**
 * Обгортка над `new Image()`. Слухачі подій знімаються і після успіху, і після помилки, і після
 * скасування, тому «осиротілих» обробників не лишається.
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const image = new Image();
    const cleanup = () => {
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onLoad = () => {
      cleanup();
      resolve(image);
    };
    const onError = () => {
      cleanup();
      classifyImageFailure(url, signal).then(reject);
    };
    const onAbort = () => {
      cleanup();
      image.removeAttribute('src'); // припиняє завантаження
      reject(abortReason(signal));
    };

    image.addEventListener('load', onLoad);
    image.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    image.src = url;
  });
}

/**
 * Завантажує файл і декодує його через audioCtx.decodeAudioData.
 *
 * @param {BaseAudioContext} audioCtx
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<AudioBuffer>}
 */
export async function loadAudio(audioCtx, url, { signal } = {}) {
  const response = await fetchOk(url, { signal });

  let bytes;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    if (isAbortLike(error) || signal?.aborted) throw error;
    throw new NetworkError(url, error);
  }

  let buffer;
  try {
    buffer = await audioCtx.decodeAudioData(bytes);
  } catch (error) {
    throw new AssetDecodeError(url, error);
  }
  // decodeAudioData не вміє скасовуватися: перевіряємо сигнал після нього.
  if (signal?.aborted) throw abortReason(signal);
  return buffer;
}

/**
 * Виконує `fn` із повторами: експоненційний backoff з джитером («рівний джитер»:
 * половина затримки фіксована, половина випадкова).
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.attempts] загальна кількість спроб
 * @param {number} [options.baseMs] база затримки: перед спробою n+1 чекаємо ~baseMs · 2^(n-1)
 * @param {AbortSignal} [options.signal]
 * @param {() => number} [options.random] джерело [0, 1) для джитера
 * @param {(info: { attempt: number, delayMs: number, error: Error }) => void} [options.onRetry]
 * @param {(error: Error) => boolean} [options.shouldRetry]
 * @returns {Promise<T>}
 */
export async function withRetry(
  fn,
  {
    attempts = 3,
    baseMs = 200,
    signal,
    random = Math.random,
    onRetry,
    shouldRetry = isRetryable,
  } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      const delayMs = backoffDelay(attempt, { baseMs }, random);
      log.warn(
        'retry',
        `спроба ${attempt}/${attempts} невдала (${error.name}: ${error.message}); повтор через ${delayMs} мс`,
      );
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}

// --- Конфіг арени ---

const RULE_KEYS = [
  'initialAsteroids',
  'minAsteroids',
  'asteroidRefillDelay',
  'hunterChance',
  'respawnDelay',
  'respawnInvulnerability',
  'pickupInterval',
  'maxPickups',
];

/** Перевіряє форму arena.json: об'єкт `rules` із числовими полями. */
export function validateArenaConfig(config, url = 'arena.json') {
  if (!config || typeof config !== 'object' || typeof config.rules !== 'object' || !config.rules) {
    throw new ConfigError(`Некоректний конфіг арени (немає об'єкта rules): ${url}`);
  }
  for (const key of RULE_KEYS) {
    if (key in config.rules && !Number.isFinite(config.rules[key])) {
      throw new ConfigError(`Некоректний конфіг арени: rules.${key} має бути числом (${url})`);
    }
  }
  return config;
}

// --- Завантаження всього ---

const YIELD = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * @param {object} manifest маніфест (див. atlas.js buildManifest або вбудований варіант)
 * @param {object} [options]
 * @param {BaseAudioContext | null} [options.audioCtx]
 * @param {(progress: object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.requestTimeoutMs] таймаут одного запиту (на кожну спробу)
 * @param {object} [options.retry] параметри withRetry
 * @param {boolean} [options.sequential] вантажити ПОСЛІДОВНО (лише для порівняння в README)
 */
export async function loadAll(
  manifest,
  {
    audioCtx = null,
    onProgress,
    signal,
    requestTimeoutMs = 5000,
    retry = {},
    sequential = false,
  } = {},
) {
  const internal = new AbortController();
  const linked = anySignal([signal, internal.signal]);
  const attemptSignal = () => anySignal([linked, AbortSignal.timeout(requestTimeoutMs)]);
  const retryOptions = { ...retry, signal: linked };

  const total = 1 + manifest.sprites.length + manifest.sounds.length;
  const active = new Set();
  let done = 0;
  let failed = 0;
  const report = (last) =>
    onProgress?.({
      done,
      total,
      ratio: total ? done / total : 1,
      failed,
      active: [...active],
      last,
    });

  /** Обгортає завантаження ассету підрахунком прогресу. */
  const track =
    (id, work, { critical }) =>
    async () => {
      active.add(id);
      report();
      try {
        const value = await work();
        active.delete(id);
        done += 1;
        report({ id, status: 'ok' });
        log.info('loader', `✓ ${id}`);
        return value;
      } catch (error) {
        active.delete(id);
        if (internal.signal.aborted && isAbortLike(error)) {
          // Скасовано, бо інший критичний ассет уже не завантажився: це не власний збій ассету.
          log.info('loader', `⊘ ${id}: скасовано`);
          throw error;
        }
        if (!critical) {
          done += 1;
          failed += 1;
        }
        report({ id, status: 'failed', error });
        log[critical ? 'error' : 'warn']('loader', `✗ ${id}: ${error.name}: ${error.message}`);
        throw error;
      }
    };

  const arenaEntry = manifest.arena;
  const arenaTask = track(
    arenaEntry.id,
    () =>
      arenaEntry.inline
        ? YIELD().then(() => validateArenaConfig(arenaEntry.inline, 'embedded'))
        : withRetry(
            async () =>
              validateArenaConfig(
                await fetchJson(arenaEntry.url, { signal: attemptSignal() }),
                arenaEntry.url,
              ),
            retryOptions,
          ),
    { critical: true },
  );

  const spriteTasks = manifest.sprites.map((entry) =>
    track(
      entry.id,
      () => withRetry(() => loadImage(entry.url, { signal: attemptSignal() }), retryOptions),
      {
        critical: true,
      },
    ),
  );

  const soundTasks = manifest.sounds.map((entry) =>
    track(
      entry.id,
      async () => {
        if (!audioCtx) return null; // Web Audio недоступний: гра без звуку
        if (entry.synth) {
          await YIELD();
          return synthAudioBuffer(audioCtx, entry.id);
        }
        return withRetry(
          () => loadAudio(audioCtx, entry.url, { signal: attemptSignal() }),
          retryOptions,
        );
      },
      { critical: false },
    ),
  );

  const criticalTasks = [arenaTask, ...spriteTasks];
  let criticalValues;
  let soundSettled;
  try {
    if (sequential) {
      criticalValues = [];
      for (const task of criticalTasks) criticalValues.push(await task());
      soundSettled = [];
      for (const task of soundTasks) {
        soundSettled.push(
          await task().then(
            (value) => ({ status: 'fulfilled', value }),
            (reason) => ({ status: 'rejected', reason }),
          ),
        );
      }
    } else {
      [criticalValues, soundSettled] = await Promise.all([
        Promise.all(criticalTasks.map((task) => task())),
        Promise.allSettled(soundTasks.map((task) => task())),
      ]);
    }
  } catch (error) {
    // Критичний ассет не завантажився: скасовуємо все, що ще летить.
    internal.abort(new DOMException('Критичний ассет не завантажився', 'AbortError'));
    throw error;
  }

  const [arena, ...images] = criticalValues;
  const sprites = {};
  manifest.sprites.forEach((entry, index) => {
    sprites[entry.id] = {
      image: images[index],
      frames: entry.frames,
      width: entry.width,
      height: entry.height,
    };
  });

  const sounds = {};
  const failedSounds = [];
  manifest.sounds.forEach((entry, index) => {
    const result = soundSettled[index];
    sounds[entry.id] = result.status === 'fulfilled' ? result.value : null;
    if (result.status === 'rejected') failedSounds.push(entry.id);
  });

  return { arena, sprites, sounds, failedSounds };
}

/**
 * Повний цикл: маніфест -> loadAll. У режимі file:// і для явного forceEmbedded використовує
 * вбудовані дані; інакше читає ./assets/manifest.json.
 *
 * @param {object} [options] як у loadAll, плюс:
 * @param {string} [options.manifestUrl]
 * @param {boolean} [options.forceEmbedded]
 */
export async function loadGameAssets({
  manifestUrl = './assets/manifest.json',
  forceEmbedded,
  ...options
} = {}) {
  const embedded = forceEmbedded ?? isFileProtocol();
  let manifest;

  if (embedded) {
    log.info('loader', 'Режим file:// - fetch недоступний, використовую вбудовані ресурси');
    manifest = buildEmbeddedManifest();
  } else {
    manifest = await withRetry(
      () =>
        fetchJson(manifestUrl, {
          signal: anySignal([
            options.signal,
            AbortSignal.timeout(options.requestTimeoutMs ?? 5000),
          ]),
        }),
      { ...options.retry, signal: options.signal },
    );
    log.info(
      'loader',
      `Маніфест завантажено: ${manifest.sprites.length} спрайт-листів, ${manifest.sounds.length} звуків`,
    );
  }

  const assets = await loadAll(manifest, options);
  return { ...assets, mode: embedded ? 'embedded' : 'network' };
}
