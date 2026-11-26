/**
 * Точка входу. Потік екранів: Loading (Canvas) -> Lobby (DOM) -> Game (Canvas).
 * Тут з'єднуються шари: ассети, звук, лобі, симуляція, рендер, цикл.
 */

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
import { Lobby } from './lobby/lobby.js';
import { createLobbyUi } from './lobby/lobby_ui.js';
import { createLoop } from './loop.js';
import { createCanvas } from './render/canvas.js';
import { drawFrame } from './render/draw.js';
import { createLoadingScreen } from './render/loading_screen.js';
import { Ship } from './sim/ship.js';
import { World } from './sim/world.js';
import { log } from './util/log.js';

// Параметри налагодження з адресного рядка: ?requestTimeout=800&loadTimeout=3000&lobbyPoll=1000&debug
const params = new URLSearchParams(globalThis.location?.search ?? '');
const numberParam = (name, fallback) => {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) && value > 0 ? value : fallback;
};
const REQUEST_TIMEOUT_MS = numberParam('requestTimeout', 5000);
const LOAD_TIMEOUT_MS = numberParam('loadTimeout', 20000);
const LOBBY_POLL_MS = numberParam('lobbyPoll', 5000);
const MIN_LOADING_MS = 350; // щоб екран завантаження встигав з'явитись навіть за миттєвого кешу

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

/** Запускає матч за параметрами вибраної кімнати. */
function startMatch({ room, nickname }, assets, audio) {
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

  const input = createInput(window);
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyM' && !event.repeat) audio.toggleMute();
  });

  // Клавіша вважається активною, якщо її утримують або натиснули від минулого кроку:
  // так короткий тап між двома кроками симуляції не губиться.
  const active = (codes) => codes.some((code) => input.isDown(code) || input.justPressed(code));
  const justPressed = (codes) => codes.some((code) => input.justPressed(code));

  // Таблиця прив'язок "клавіша -> дія". `run` викликається як `binding.run()`, тобто з
  // this === binding. Тому методи судна передаються лише завдяки прив'язці в конструкторі
  // Ship: без неї this усередині fire() був би об'єктом-прив'язкою, а не судном.
  const bindings = [
    { codes: ['Space'], held: true, run: ship.fire },
    { codes: ['KeyX', 'KeyE'], held: false, run: ship.fireMissile },
  ];

  const readControls = () => ({
    left: active(['ArrowLeft', 'KeyA']),
    right: active(['ArrowRight', 'KeyD']),
    thrust: active(['ArrowUp', 'KeyW']),
  });

  const session = { nickname, roomName: room.name };

  function simulate(dt) {
    for (const binding of bindings) {
      if (binding.held ? active(binding.codes) : justPressed(binding.codes)) binding.run();
    }
    world.setSize(view.width, view.height);
    world.step(dt, readControls());
    input.endStep();
  }

  function render(alpha, metrics) {
    drawFrame(ctx, view, world, alpha, metrics, performance.now(), assets.sprites, session);
  }

  if (params.has('debug')) globalThis.__dogfight = { world, audio, assets, ship };
  log.info('game', `матч розпочато: «${room.name}», пілот ${nickname}`);
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
  const lobby = new Lobby({ pollMs: LOBBY_POLL_MS, embedded: assets.mode === 'embedded' });
  const ui = createLobbyUi({ container: uiRoot, lobby, onBeforeJoin: audio.unlock });

  lobby.addEventListener('joined', (event) => {
    ui.destroy();
    loading.destroy(); // тло лобі більше не потрібне: далі малює ігровий цикл
    startMatch(event.detail, assets, audio);
  });

  await lobby.refresh();
  lobby.startPolling();
  if (params.has('debug')) globalThis.__lobby = lobby;
}

main().catch((error) => log.error('boot', `неочікувана помилка: ${error.message}`, error));
