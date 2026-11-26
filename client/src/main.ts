/**
 * Точка входу клієнта (TypeScript).
 * Потік екранів: Loading (Canvas) -> Lobby (DOM) -> Game (Canvas).
 */

import { Ship, TICK_DT, World, type CodecNameValue } from '@dogfight/shared';
import {
  AssetDecodeError,
  ConfigError,
  HttpError,
  JsonParseError,
  NetworkError,
  loadGameAssets,
  sleep,
  type LoadedAssets,
} from './assets/loader.ts';
import { createAudioContext, createAudioSystem, type AudioSystem } from './audio/audio.ts';
import { createInput } from './input.ts';
import { defaultWsUrl, Lobby, type JoinedDetail } from './lobby/lobby.ts';
import { createLobbyUi } from './lobby/lobby_ui.ts';
import { createLoop, type LoopMetrics } from './loop.ts';
import { NetClient } from './net/net_client.ts';
import { createCanvas } from './render/canvas.ts';
import { drawFrame } from './render/draw.ts';
import { createLoadingScreen } from './render/loading_screen.ts';
import { createNetgraph } from './render/netgraph.ts';
import { createParticleSystem } from './render/particle_bridge.ts';
import { Bus, type GameEvents } from './util/bus.ts';
import { log } from './util/log.ts';

const params = new URLSearchParams(globalThis.location?.search ?? '');
const numberParam = (name: string, fallback: number): number => {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) && value >= 0 ? value : fallback;
};
const REQUEST_TIMEOUT_MS = numberParam('requestTimeout', 5000);
const LOAD_TIMEOUT_MS = numberParam('loadTimeout', 20000);
const LOBBY_POLL_MS = numberParam('lobbyPoll', 5000);
const INITIAL_CODEC: CodecNameValue = params.get('codec') === 'json' ? 'json' : 'binary';
const INITIAL_INTERP_MS = numberParam('interp', 80);
const MIN_LOADING_MS = 350;

// Реєструємо Service Worker лише по HTTP(S), щоб не зламати file:// оффлайн-режим.
if (
  (globalThis.location?.protocol === 'http:' || globalThis.location?.protocol === 'https:') &&
  'serviceWorker' in navigator
) {
  globalThis.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

function buildWsUrl(): string {
  const url = new URL(defaultWsUrl());
  for (const key of ['latency', 'jitter', 'drop']) {
    const val = params.get(key);
    if (val !== null) url.searchParams.set(key, val);
  }
  return url.href;
}

const rawCanvas = document.getElementById('game');
const rawUiRoot = document.getElementById('ui-root');
if (!(rawCanvas instanceof HTMLCanvasElement) || !(rawUiRoot instanceof HTMLElement)) {
  throw new Error('В index.html немає HTMLCanvasElement #game або HTMLElement #ui-root');
}
const canvasElement: HTMLCanvasElement = rawCanvas;
const uiRoot: HTMLElement = rawUiRoot;

const { ctx, view } = createCanvas(canvasElement);
const loading = createLoadingScreen({ ctx, view, canvas: canvasElement });
const audioCtx = createAudioContext();

function describeLoadError(error: unknown): readonly [string, string] {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return ['Час очікування вичерпано', 'Сервер не відповів вчасно (після кількох спроб)'];
  }
  if (error instanceof HttpError) return [`Сервер повернув HTTP ${error.status}`, error.url];
  if (error instanceof JsonParseError) return ['Файл пошкоджено (некоректний JSON)', error.url];
  if (error instanceof NetworkError) return ['Немає зв’язку із сервером', error.url];
  if (error instanceof ConfigError || error instanceof AssetDecodeError) return [error.message, ''];
  return [error instanceof Error ? error.message : 'Невідома помилка', ''];
}

async function loadUntilSuccess(): Promise<
  LoadedAssets & { readonly mode: 'embedded' | 'network' }
> {
  for (;;) {
    loading.showLoading();
    const startedAt = performance.now();
    try {
      const assets = await loadGameAssets({
        audioCtx,
        onProgress: loading.onProgress,
        signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      const remaining = MIN_LOADING_MS - (performance.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
      return assets;
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : 'Error';
      const msg = error instanceof Error ? error.message : String(error);
      log.error('boot', `завантаження не вдалося: ${name}: ${msg}`);
      const [message, detail] = describeLoadError(error);
      await loading.showError(message, detail);
      log.info('boot', 'Retry: повторюю завантаження');
    }
  }
}

/** Місток від EventTarget локального World до типізованої шини Bus<GameEvents>. */
function bridgeWorldEvents(world: World): Bus<GameEvents> {
  const bus = new Bus<GameEvents>();
  world.addEventListener('fired', (event) => {
    if (event instanceof CustomEvent && event.detail && typeof event.detail === 'object') {
      bus.emit('fired', { missile: Boolean(event.detail.missile) });
    }
  });
  world.addEventListener('hit', (event) => {
    if (event instanceof CustomEvent && event.detail && typeof event.detail === 'object') {
      const target = event.detail.target;
      const kind =
        target && typeof target === 'object' && 'kind' in target ? String(target.kind) : '';
      bus.emit('hit', { target: { kind }, destroyed: Boolean(event.detail.destroyed) });
    }
  });
  world.addEventListener('exploded', (event) => {
    if (event instanceof CustomEvent && event.detail && typeof event.detail === 'object') {
      bus.emit('exploded', {
        kind: String(event.detail.kind ?? 'asteroid'),
        size: typeof event.detail.size === 'number' ? event.detail.size : 1,
      });
    }
  });
  world.addEventListener('pickup', (event) => {
    if (event instanceof CustomEvent && event.detail && typeof event.detail === 'object') {
      const eff = event.detail.effect;
      const type = eff && typeof eff === 'object' && 'type' in eff ? String(eff.type) : 'heal';
      bus.emit('pickup', { effect: { type } });
    }
  });
  return bus;
}

function startOnlineMatch(detail: JoinedDetail, assets: LoadedAssets, audio: AudioSystem): void {
  if (!detail.connection) return;
  const net = new NetClient({
    connection: detail.connection,
    codec: INITIAL_CODEC,
    interpolationDelayMs: INITIAL_INTERP_MS,
  });
  audio.attach(net.bus);
  const particles = createParticleSystem();
  net.bus.on('exploded', ({ kind, size, x, y }) => {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    const isShip = kind === 'ship';
    particles.spawn({
      x,
      y,
      count: isShip ? 42 : 6 + 5 * size,
      speed: isShip ? 240 : 40 + 35 * size,
      life: isShip ? 1.1 : 0.45 + 0.2 * size,
      tint: isShip ? 'ship' : 'rock',
    });
  });
  const netgraph = createNetgraph({ container: uiRoot, net });

  const input = createInput(window);
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.code === 'KeyM' && !event.repeat) audio.toggleMute();
  });

  const active = (codes: readonly string[]): boolean =>
    codes.some((code) => input.isDown(code) || input.justPressed(code));
  const justPressed = (codes: readonly string[]): boolean =>
    codes.some((code) => input.justPressed(code));

  const readControls = () => ({
    thrust: active(['ArrowUp', 'KeyW']),
    turn: (active(['ArrowRight', 'KeyD']) ? 1 : 0) - (active(['ArrowLeft', 'KeyA']) ? 1 : 0),
    fire: active(['Space']),
    missile: justPressed(['KeyX', 'KeyE']),
  });

  const session = { nickname: detail.nickname, roomName: `${detail.room.name} (online)` };
  let lastRenderAt = performance.now();

  function simulate(): void {
    net.stepInput(readControls());
    input.endStep();
  }

  function render(alpha: number, metrics: LoopMetrics): void {
    const now = performance.now();
    const dtFrame = Math.min(0.1, Math.max(0, (now - lastRenderAt) / 1000));
    lastRenderAt = now;
    particles.step(dtFrame);
    const renderWorld = net.buildRenderWorld(alpha, dtFrame, now);
    drawFrame(ctx, view, renderWorld, alpha, metrics, now, assets.sprites, session, (c) =>
      particles.draw(c),
    );
    netgraph.update(now);
  }

  net.start();
  log.info('game', `мережевий матч розпочато: «${detail.room.name}», пілот ${detail.nickname}`);
  createLoop({ step: TICK_DT, simulate, render }).start();
}

function startLocalMatch(detail: JoinedDetail, assets: LoadedAssets, audio: AudioSystem): void {
  const seed = detail.room.arena.seed;
  const world = new World({
    width: view.width,
    height: view.height,
    seed: typeof seed === 'number' && Number.isFinite(seed) ? seed : 1,
    rules: { ...assets.arena.rules, ...detail.room.arena },
  });
  const ship = new Ship({ x: view.width / 2, y: view.height / 2 });
  world.setPlayer(ship);
  world.populate();
  audio.attach(bridgeWorldEvents(world));
  const netgraph = createNetgraph({ container: uiRoot, net: null });

  const input = createInput(window);
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.code === 'KeyM' && !event.repeat) audio.toggleMute();
  });

  const active = (codes: readonly string[]): boolean =>
    codes.some((code) => input.isDown(code) || input.justPressed(code));
  const justPressed = (codes: readonly string[]): boolean =>
    codes.some((code) => input.justPressed(code));

  const readControls = () => ({
    thrust: active(['ArrowUp', 'KeyW']),
    turn: (active(['ArrowRight', 'KeyD']) ? 1 : 0) - (active(['ArrowLeft', 'KeyA']) ? 1 : 0),
    fire: active(['Space']),
    missile: justPressed(['KeyX', 'KeyE']),
  });

  const session = { nickname: detail.nickname, roomName: detail.room.name };

  function simulate(dt: number): void {
    world.setSize(view.width, view.height);
    world.step(dt, readControls());
    input.endStep();
  }

  function render(alpha: number, metrics: LoopMetrics): void {
    const now = performance.now();
    drawFrame(ctx, view, world, alpha, metrics, now, assets.sprites, session);
    netgraph.update(now);
  }

  log.info('game', `локальний матч розпочато: «${detail.room.name}», пілот ${detail.nickname}`);
  createLoop({ simulate, render }).start();
}

async function main(): Promise<void> {
  loading.start();
  const assets = await loadUntilSuccess();
  if (assets.failedSounds.length) {
    log.warn('boot', `гра запускається без звуків: ${assets.failedSounds.join(', ')}`);
  }
  const audio = createAudioSystem({ audioCtx, sounds: assets.sounds });

  loading.showBackdrop();
  const lobby = new Lobby({
    pollMs: LOBBY_POLL_MS,
    embedded: assets.mode === 'embedded',
    wsUrl: buildWsUrl,
  });
  const ui = createLobbyUi({ container: uiRoot, lobby, onBeforeJoin: () => void audio.unlock() });

  lobby.addEventListener('joined', (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: JoinedDetail = event.detail;
    ui.destroy();
    loading.destroy();
    if (detail.connection) startOnlineMatch(detail, assets, audio);
    else startLocalMatch(detail, assets, audio);
  });

  await lobby.refresh();
  lobby.startPolling();
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  log.error('boot', `неочікувана помилка: ${msg}`, error);
});
