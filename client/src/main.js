/**
 * Точка входу. Потік екранів: Loading (Canvas) -> Lobby (DOM) -> Game (Canvas).
 * Підтримує два режими гри:
 *   - мережевий (авторитативний сервер 30 Гц, Client-Side Prediction, Reconciliation,
 *     Entity Interpolation, бінарний/JSON протокол, Netgraph по Tab/F3);
 *   - офлайн (file:// або статичний хостинг: локальна симуляція з @dogfight/shared).
 */

import { Ship, TICK_DT, World } from '@dogfight/shared';
import {
  AssetDecodeError,
  ConfigError,
  HttpError,
  JsonParseError,
  NetworkError,
  loadGameAssets,
  sleep,
} from './assets/loader.js';
import { createAudioContext, createAudioSystem } from './audio/audio.js';
import { createInput } from './input.js';
import { defaultWsUrl, Lobby } from './lobby/lobby.js';
import { createLobbyUi } from './lobby/lobby_ui.js';
import { createLoop } from './loop.js';
import { NetClient } from './net/net_client.js';
import { createCanvas } from './render/canvas.js';
import { drawFrame } from './render/draw.js';
import { createLoadingScreen } from './render/loading_screen.js';
import { createNetgraph } from './render/netgraph.js';
import { log } from './util/log.js';

// Параметри налагодження з адресного рядка:
// ?requestTimeout=800&loadTimeout=3000&lobbyPoll=1000&codec=json&interp=80&latency=100&jitter=30&drop=0.02&debug
const params = new URLSearchParams(globalThis.location?.search ?? '');
const numberParam = (name, fallback) => {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) && value >= 0 ? value : fallback;
};
const REQUEST_TIMEOUT_MS = numberParam('requestTimeout', 5000);
const LOAD_TIMEOUT_MS = numberParam('loadTimeout', 20000);
const LOBBY_POLL_MS = numberParam('lobbyPoll', 5000);
const INITIAL_CODEC = params.get('codec') === 'json' ? 'json' : 'binary';
const INITIAL_INTERP_MS = numberParam('interp', 80);
const MIN_LOADING_MS = 350; // щоб екран завантаження встигав з'явитись навіть за миттєвого кешу

/** Передає query-параметри емуляції мережі (?latency=...&jitter=...&drop=...) у /ws. */
function buildWsUrl() {
  const url = new URL(defaultWsUrl());
  for (const key of ['latency', 'jitter', 'drop']) {
    if (params.has(key)) url.searchParams.set(key, params.get(key));
  }
  return url.href;
}

const canvasElement = document.getElementById('game');
const uiRoot = document.getElementById('ui-root');
if (!canvasElement || !uiRoot) throw new Error('В index.html немає #game або #ui-root');

const { ctx, view } = createCanvas(canvasElement);
const loading = createLoadingScreen({ ctx, view, canvas: canvasElement });
const audioCtx = createAudioContext(); // створюється "призупиненим": ресурси можна декодувати вже зараз

/** Людський опис помилки завантаження: [заголовок, деталі]. */
function describeLoadError(error) {
  if (error?.name === 'TimeoutError') {
    return ['Час очікування вичерпано', 'Сервер не відповів вчасно (після кількох спроб)'];
  }
  if (error instanceof HttpError) return [`Сервер повернув HTTP ${error.status}`, error.url];
  if (error instanceof JsonParseError) return ['Файл пошкоджено (некоректний JSON)', error.url];
  if (error instanceof NetworkError) return ['Немає зв’язку із сервером', error.url];
  if (error instanceof ConfigError || error instanceof AssetDecodeError) return [error.message, ''];
  return [error?.message ?? 'Невідома помилка', ''];
}

/** Вантажить ассети, поки не вийде: після кожної помилки чекає на Retry. */
async function loadUntilSuccess() {
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
    } catch (error) {
      log.error('boot', `завантаження не вдалося: ${error.name}: ${error.message}`);
      const [message, detail] = describeLoadError(error);
      await loading.showError(message, detail); // чекаємо натискання Retry
      log.info('boot', 'Retry: повторюю завантаження');
    }
  }
}

/** Запускає мережевий матч із авторитативним сервером (30 Гц, prediction + interpolation). */
function startOnlineMatch({ room, nickname, connection }, assets, audio) {
  const net = new NetClient({
    connection,
    codec: INITIAL_CODEC,
    interpolationDelayMs: INITIAL_INTERP_MS,
  });
  audio.attach(net);
  const netgraph = createNetgraph({ container: uiRoot, net });

  const input = createInput(window);
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyM' && !event.repeat) audio.toggleMute();
  });

  const active = (codes) => codes.some((code) => input.isDown(code) || input.justPressed(code));
  const justPressed = (codes) => codes.some((code) => input.justPressed(code));

  const readControls = () => ({
    thrust: active(['ArrowUp', 'KeyW']),
    turn: (active(['ArrowRight', 'KeyD']) ? 1 : 0) - (active(['ArrowLeft', 'KeyA']) ? 1 : 0),
    fire: active(['Space']),
    missile: justPressed(['KeyX', 'KeyE']),
  });

  const session = { nickname, roomName: `${room.name} (online)` };
  let lastRenderAt = performance.now();

  function simulate() {
    net.stepInput(readControls());
    input.endStep();
  }

  function render(alpha, metrics) {
    const now = performance.now();
    const dtFrame = Math.min(0.1, Math.max(0, (now - lastRenderAt) / 1000));
    lastRenderAt = now;
    const renderWorld = net.buildRenderWorld(alpha, dtFrame, now);
    drawFrame(ctx, view, renderWorld, alpha, metrics, now, assets.sprites, session);
    netgraph.update(now);
  }

  net.start();
  if (params.has('debug')) globalThis.__dogfight = { net, connection, audio, assets, netgraph };
  log.info('game', `мережевий матч розпочато: «${room.name}», пілот ${nickname}`);
  createLoop({ step: TICK_DT, simulate, render }).start();
}

/** Запускає локальний (офлайн) матч: працює при відкритті client/dist/index.html по file://. */
function startLocalMatch({ room, nickname }, assets, audio) {
  const world = new World({
    width: view.width,
    height: view.height,
    seed: Number.isFinite(room.arena.seed) ? room.arena.seed : 1,
    rules: { ...assets.arena.rules, ...room.arena }, // база з arena.json + параметри кімнати
  });
  const ship = new Ship({ x: view.width / 2, y: view.height / 2 });
  world.setPlayer(ship);
  world.populate();
  audio.attach(world); // звук підписується на шину подій світу
  const netgraph = createNetgraph({ container: uiRoot, net: null });

  const input = createInput(window);
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyM' && !event.repeat) audio.toggleMute();
  });

  const active = (codes) => codes.some((code) => input.isDown(code) || input.justPressed(code));
  const justPressed = (codes) => codes.some((code) => input.justPressed(code));

  const readControls = () => ({
    thrust: active(['ArrowUp', 'KeyW']),
    turn: (active(['ArrowRight', 'KeyD']) ? 1 : 0) - (active(['ArrowLeft', 'KeyA']) ? 1 : 0),
    fire: active(['Space']),
    missile: justPressed(['KeyX', 'KeyE']),
  });

  const session = { nickname, roomName: room.name };

  function simulate(dt) {
    world.setSize(view.width, view.height);
    world.step(dt, readControls());
    input.endStep();
  }

  function render(alpha, metrics) {
    const now = performance.now();
    drawFrame(ctx, view, world, alpha, metrics, now, assets.sprites, session);
    netgraph.update(now);
  }

  if (params.has('debug')) globalThis.__dogfight = { world, audio, assets, ship, netgraph };
  log.info('game', `локальний матч розпочато: «${room.name}», пілот ${nickname}`);
  createLoop({ simulate, render }).start();
}

async function main() {
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
  const ui = createLobbyUi({ container: uiRoot, lobby, onBeforeJoin: audio.unlock });

  lobby.addEventListener('joined', (event) => {
    ui.destroy();
    loading.destroy(); // тло лобі більше не потрібне: далі малює ігровий цикл
    if (event.detail.connection) startOnlineMatch(event.detail, assets, audio);
    else startLocalMatch(event.detail, assets, audio);
  });

  await lobby.refresh();
  lobby.startPolling();
  if (params.has('debug')) globalThis.__lobby = lobby;
}

main().catch((error) => log.error('boot', `неочікувана помилка: ${error.message}`, error));
