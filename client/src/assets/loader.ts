/**
 * Асинхронний завантажувач ассетів із типізованими помилками, ретраями та підтримкою file://.
 */

import type { LoadedSpriteSheet } from '../render/sprites.ts';
import { backoffDelay } from '../util/backoff.ts';
import { log } from '../util/log.ts';
import type { ArenaConfig } from './defaults.ts';
import { buildEmbeddedManifest, synthAudioBuffer, type LoadableManifest } from './fallback.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;

  constructor(status: number, url: string, statusText = '', body: unknown = null) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}: ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class NetworkError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Мережевий збій: ${url}`, { cause });
    this.name = 'NetworkError';
    this.url = url;
  }
}

export class JsonParseError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Пошкоджений JSON: ${url}`, { cause });
    this.name = 'JsonParseError';
    this.url = url;
  }
}

export class AssetDecodeError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Не вдалося декодувати ассет: ${url}`, { cause });
    this.name = 'AssetDecodeError';
    this.url = url;
  }
}

export class ImageLoadError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Не вдалося завантажити зображення (сервер відповідає): ${url}`, { cause });
    this.name = 'ImageLoadError';
    this.url = url;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function errorName(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.name : 'Error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.message : String(error);
}

export function isAbortLike(error: unknown): boolean {
  const name = errorName(error);
  return name === 'AbortError' || name === 'TimeoutError';
}

export function isRetryable(error: unknown): boolean {
  if (!error) return false;
  const name = errorName(error);
  if (name === 'AbortError') return false;
  if (name === 'TimeoutError') return true;
  if (error instanceof HttpError) return error.status >= 500;
  return error instanceof NetworkError || error instanceof ImageLoadError;
}

export const isFileProtocol = (): boolean => globalThis.location?.protocol === 'file:';

export function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function anySignal(signals: readonly (AbortSignal | undefined | null)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => Boolean(s));
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

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
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

async function fetchOk(url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error: unknown) {
    if (isAbortLike(error) || init.signal?.aborted) throw error;
    throw new NetworkError(url, error);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new HttpError(response.status, url, response.statusText, body);
  }
  return response;
}

export async function fetchJson(
  url: string,
  { signal, json }: { readonly signal?: AbortSignal; readonly json?: unknown } = {},
): Promise<unknown> {
  const init: RequestInit =
    json === undefined
      ? { signal }
      : {
          signal,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(json),
        };
  const response = await fetchOk(url, init);
  try {
    return await response.json();
  } catch (error: unknown) {
    if (isAbortLike(error) || signal?.aborted) throw error;
    throw new JsonParseError(url, error);
  }
}

async function classifyImageFailure(url: string, signal?: AbortSignal): Promise<unknown> {
  if (url.startsWith('data:')) return new AssetDecodeError(url.slice(0, 40), null);
  try {
    const response = await fetch(url, { method: 'HEAD', signal });
    if (!response.ok) return new HttpError(response.status, url, response.statusText);
    return new ImageLoadError(url, null);
  } catch (error: unknown) {
    if (isAbortLike(error) || signal?.aborted) return error;
    return new NetworkError(url, error);
  }
}

export function loadImage(
  url: string,
  { signal }: { readonly signal?: AbortSignal } = {},
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const image = new Image();
    const cleanup = (): void => {
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onLoad = (): void => {
      cleanup();
      resolve(image);
    };
    const onError = (): void => {
      cleanup();
      void classifyImageFailure(url, signal).then(reject);
    };
    const onAbort = (): void => {
      cleanup();
      image.removeAttribute('src');
      reject(abortReason(signal));
    };

    image.addEventListener('load', onLoad);
    image.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    image.src = url;
  });
}

export async function loadAudio(
  audioCtx: BaseAudioContext,
  url: string,
  { signal }: { readonly signal?: AbortSignal } = {},
): Promise<AudioBuffer> {
  const response = await fetchOk(url, { signal });

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (error: unknown) {
    if (isAbortLike(error) || signal?.aborted) throw error;
    throw new NetworkError(url, error);
  }

  let buffer: AudioBuffer;
  try {
    buffer = await audioCtx.decodeAudioData(bytes);
  } catch (error: unknown) {
    throw new AssetDecodeError(url, error);
  }
  if (signal?.aborted) throw abortReason(signal);
  return buffer;
}

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseMs?: number;
  readonly signal?: AbortSignal;
  readonly random?: () => number;
  readonly onRetry?: (info: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: unknown;
  }) => void;
  readonly shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  {
    attempts = 3,
    baseMs = 200,
    signal,
    random = Math.random,
    onRetry,
    shouldRetry = isRetryable,
  }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await fn(attempt);
    } catch (error: unknown) {
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      const delayMs = backoffDelay(attempt, { baseMs }, random);
      log.warn(
        'retry',
        `спроба ${attempt}/${attempts} невдала (${errorName(error)}: ${errorMessage(error)}); повтор через ${delayMs} мс`,
      );
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}

const RULE_KEYS = [
  'initialAsteroids',
  'minAsteroids',
  'asteroidRefillDelay',
  'hunterChance',
  'respawnDelay',
  'respawnInvulnerability',
  'pickupInterval',
  'maxPickups',
] as const;

export function validateArenaConfig(config: unknown, url = 'arena.json'): ArenaConfig {
  if (!config || typeof config !== 'object' || !('rules' in config)) {
    throw new ConfigError(`Некоректний конфіг арени (немає об'єкта rules): ${url}`);
  }
  const rawRules = config.rules;
  if (!rawRules || typeof rawRules !== 'object') {
    throw new ConfigError(`Некоректний конфіг арени (немає об'єкта rules): ${url}`);
  }
  const rulesObj: Record<string, unknown> = { ...rawRules };
  const rules: Record<string, number> = {};
  for (const key of RULE_KEYS) {
    if (key in rulesObj) {
      const value = rulesObj[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ConfigError(`Некоректний конфіг арени: rules.${key} має бути числом (${url})`);
      }
      rules[key] = value;
    }
  }
  const version = 'version' in config && typeof config.version === 'number' ? config.version : 1;
  return { version, rules };
}

export interface LoadProgress {
  readonly done: number;
  readonly total: number;
  readonly ratio: number;
  readonly failed: number;
  readonly active: readonly string[];
  readonly last?: {
    readonly id: string;
    readonly status: 'ok' | 'failed';
    readonly error?: unknown;
  };
}

export interface LoadedAssets {
  readonly arena: ArenaConfig;
  readonly sprites: Readonly<Record<string, LoadedSpriteSheet & { width: number; height: number }>>;
  readonly sounds: Readonly<Record<string, AudioBuffer | null>>;
  readonly failedSounds: readonly string[];
}

export interface LoadAllOptions {
  readonly audioCtx?: BaseAudioContext | null;
  readonly onProgress?: (progress: LoadProgress) => void;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
  readonly retry?: RetryOptions;
  readonly sequential?: boolean;
}

const YIELD = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function isLoadableManifest(data: unknown): data is LoadableManifest {
  return (
    data !== null &&
    typeof data === 'object' &&
    'arena' in data &&
    'sprites' in data &&
    Array.isArray(data.sprites) &&
    'sounds' in data &&
    Array.isArray(data.sounds)
  );
}

export async function loadAll(
  manifest: LoadableManifest,
  {
    audioCtx = null,
    onProgress,
    signal,
    requestTimeoutMs = 5000,
    retry = {},
    sequential = false,
  }: LoadAllOptions = {},
): Promise<LoadedAssets> {
  const internal = new AbortController();
  const linked = anySignal([signal, internal.signal]);
  const attemptSignal = (): AbortSignal =>
    anySignal([linked, AbortSignal.timeout(requestTimeoutMs)]);
  const retryOptions: RetryOptions = { ...retry, signal: linked };

  const total = 1 + manifest.sprites.length + manifest.sounds.length;
  const active = new Set<string>();
  let done = 0;
  let failed = 0;
  const report = (last?: LoadProgress['last']): void =>
    onProgress?.({
      done,
      total,
      ratio: total ? done / total : 1,
      failed,
      active: [...active],
      last,
    });

  function track<T>(
    id: string,
    work: () => Promise<T>,
    { critical }: { critical: boolean },
  ): () => Promise<T> {
    return async () => {
      active.add(id);
      report();
      try {
        const value = await work();
        active.delete(id);
        done += 1;
        report({ id, status: 'ok' });
        log.info('loader', `✓ ${id}`);
        return value;
      } catch (error: unknown) {
        active.delete(id);
        if (internal.signal.aborted && isAbortLike(error)) {
          log.info('loader', `⊘ ${id}: скасовано`);
          throw error;
        }
        if (!critical) {
          done += 1;
          failed += 1;
        }
        report({ id, status: 'failed', error });
        log[critical ? 'error' : 'warn'](
          'loader',
          `✗ ${id}: ${errorName(error)}: ${errorMessage(error)}`,
        );
        throw error;
      }
    };
  }

  const arenaEntry = manifest.arena;
  const arenaTask = track(
    arenaEntry.id,
    () =>
      arenaEntry.inline
        ? YIELD().then(() => validateArenaConfig(arenaEntry.inline, 'embedded'))
        : withRetry(async () => {
            const url = arenaEntry.url ?? './assets/arena.json';
            return validateArenaConfig(await fetchJson(url, { signal: attemptSignal() }), url);
          }, retryOptions),
    { critical: true },
  );

  const spriteTasks = manifest.sprites.map((entry) =>
    track(
      entry.id,
      () => withRetry(() => loadImage(entry.url, { signal: attemptSignal() }), retryOptions),
      { critical: true },
    ),
  );

  const soundTasks = manifest.sounds.map((entry) =>
    track(
      entry.id,
      async (): Promise<AudioBuffer | null> => {
        if (!audioCtx) return null;
        if (entry.synth) {
          await YIELD();
          return synthAudioBuffer(audioCtx, entry.id);
        }
        const url = entry.url ?? '';
        return withRetry(() => loadAudio(audioCtx, url, { signal: attemptSignal() }), retryOptions);
      },
      { critical: false },
    ),
  );

  let arena: ArenaConfig;
  let images: HTMLImageElement[];
  let soundSettled: PromiseSettledResult<AudioBuffer | null>[];
  try {
    if (sequential) {
      arena = await arenaTask();
      images = [];
      for (const task of spriteTasks) images.push(await task());
      soundSettled = [];
      for (const task of soundTasks) {
        soundSettled.push(
          await task().then(
            (value): PromiseFulfilledResult<AudioBuffer | null> => ({ status: 'fulfilled', value }),
            (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason }),
          ),
        );
      }
    } else {
      const [criticalRes, settled] = await Promise.all([
        Promise.all([arenaTask(), Promise.all(spriteTasks.map((t) => t()))]),
        Promise.allSettled(soundTasks.map((task) => task())),
      ]);
      arena = criticalRes[0];
      images = criticalRes[1];
      soundSettled = settled;
    }
  } catch (error: unknown) {
    internal.abort(new DOMException('Критичний ассет не завантажився', 'AbortError'));
    throw error;
  }

  const sprites: Record<string, LoadedSpriteSheet & { width: number; height: number }> = {};
  manifest.sprites.forEach((entry, index) => {
    const img = images[index];
    if (!img) throw new ConfigError(`Не завантажено спрайт ${entry.id}`);
    sprites[entry.id] = {
      image: img,
      frames: entry.frames,
      width: entry.width,
      height: entry.height,
    };
  });

  const sounds: Record<string, AudioBuffer | null> = {};
  const failedSounds: string[] = [];
  manifest.sounds.forEach((entry, index) => {
    const result = soundSettled[index];
    if (!result) return;
    sounds[entry.id] = result.status === 'fulfilled' ? result.value : null;
    if (result.status === 'rejected') failedSounds.push(entry.id);
  });

  return { arena, sprites, sounds, failedSounds };
}

export async function loadGameAssets({
  manifestUrl = './assets/manifest.json',
  forceEmbedded,
  ...options
}: LoadAllOptions & {
  readonly manifestUrl?: string;
  readonly forceEmbedded?: boolean;
} = {}): Promise<LoadedAssets & { readonly mode: 'embedded' | 'network' }> {
  const embedded = forceEmbedded ?? isFileProtocol();
  let manifest: LoadableManifest;

  if (embedded) {
    log.info('loader', 'Режим file:// - fetch недоступний, використовую вбудовані ресурси');
    manifest = buildEmbeddedManifest();
  } else {
    const raw = await withRetry(
      () =>
        fetchJson(manifestUrl, {
          signal: anySignal([
            options.signal,
            AbortSignal.timeout(options.requestTimeoutMs ?? 5000),
          ]),
        }),
      { ...options.retry, signal: options.signal },
    );
    if (!isLoadableManifest(raw)) {
      throw new ConfigError(`Некоректний маніфест ассетів: ${manifestUrl}`);
    }
    manifest = raw;
    log.info(
      'loader',
      `Маніфест завантажено: ${manifest.sprites.length} спрайт-листів, ${manifest.sounds.length} звуків`,
    );
  }

  const assets = await loadAll(manifest, options);
  return { ...assets, mode: embedded ? 'embedded' : 'network' };
}
