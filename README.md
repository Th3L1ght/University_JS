# Dogfight - Лабораторна робота №7: Engines, Memory, and Tests (V8 Performance, Pooling, Spatial Hash, Workers & Testing)

![CI](https://img.shields.io/badge/CI-typecheck%20%7C%20lint%20%7C%20vitest%20%7C%20build%20%7C%20playwright-brightgreen)

Сьомий етап гри Dogfight: професійний тестовий контур (**Vitest + V8 coverage + fast-check + Playwright**),
інструментування продуктивності (`performance.mark`/`measure`, `p50`/`p95`/`p99`, `eventLoopUtilization`),
оптимізація гарячих шляхів (**Object Pooling + Spatial Hash Grid $O(n)$ + стабільні V8 Hidden Classes**),
**Web Worker із Transferable `Float32Array`** (з автоматичним fallback на `file://`), серверні ШІ-боти та
навантажувальне тестування.

## Швидкий старт і команди

```bash
npm install               # встановлення залежностей (Vitest, fast-check, Playwright, Zod, TS)
npm run typecheck         # tsc --noEmit по всіх 3 workspaces
npm run lint              # ESLint + @typescript-eslint/no-floating-promises + no-explicit-any
npm run format:check      # Prettier
npm test                  # 62 unit & property-based тести (Vitest)
npm run test:coverage     # Vitest + @vitest/coverage-v8 (покриття shared/ ≥ 85%)
npm run test:node         # додаткові інтеграційні node:test (HTTP, WS, NDJSON, Lobby)
npm run build             # збірка клієнта Vite у client/dist (base: './', сумісно з file://)
npm run test:e2e          # Playwright E2E (2 браузерні контексти проти реального сервера)
npm run loadtest          # навантажувальний тест N = 8, 32, 64, 128 клієнтів
```

## Тестова архітектура

1. **Unit-тести (Vitest, `shared/test/sim.spec.ts`, `server/test/server.spec.ts`, `client/test/client.spec.ts`):**
   - Математика `Vector2` (незмінність), `integrate`, `wrapAngle` / `wrappedDelta`.
   - Граничні випадки колізій: дотик (`tangent`), перетин (`overlap`), промах (`miss`), перетин через край арени, тунелювання швидких куль та еквівалентність `SpatialHashGrid` $O(n)$ до еталонного $O(n^2)$.
   - `ObjectPool` (перевикористання, `maxSize`, `world.poolStats`), детермінізм `World.step` (1000 кроків), `World.fromSnapshot`.
   - `TokenBucket`, `BotManager`, `NetClient` reconciliation + interpolation, `Bus<GameEvents>`, та **фейкові таймери (`vi.useFakeTimers()`)** для акумулятора `createLoop`, 30 Гц `Match`, `NetSim`, `RoomManager` TTL і heartbeat.
2. **Property-based тести (`fast-check`, `shared/test/properties.spec.ts`, 5 властивостей):**
   - Round-trip бінарного кодека `decode(encode(msg))` у межах точності квантування `Int16` (`≤ 0.0005` рад, `≤ 0.05` пкс/с).
   - Точна відповідність `encode(msg).byteLength` формулі бінарної специфікації.
   - Довільні биті буфери `Uint8Array` (300 прогонів) викликають лише `BinaryFormatError` без падіння процесу.
   - Корабель не покидає межі арени `[0, 1280) × [0, 720)` за 1000 випадкових кроків.
   - `parseClientMessage` приймає згенеровані валідні повідомлення й відхиляє невалідні мутації (чужа версія, зайві поля).
3. **E2E-тест (`e2e/multiplayer.spec.ts`, `playwright.config.ts`):**
   - Автоматично піднімає сервер (`webServer`), відкриває два незалежні контексти Chromium, заводить обох гравців у одну кімнату, перевіряє `roster`, чат, старт матчу та керування кораблем із підтвердженням оновлення стану `< 500` мс.
4. **Покриття `@dogfight/shared` (`@vitest/coverage-v8`):** **94.48% statements | 96.35% functions | 96.86% lines** (поріг ≥ 85% закріплений у `vitest.config.ts` і CI).

## Профілювання та оптимізація: До і Після

Виміряно на цій машині (Node.js v26.13.1, V8) на сцені активного бою (16 гравців / 81 сутність, 600 тіків, та важка сцена 64 гравці / 207 сутностей, 300 тіків):

| Метрика                                      | До оптимізації ($O(n^2)$, без пулів) | Після оптимізації (Spatial Hash $O(n)$ + `ObjectPool`) |                  Зміна |
| -------------------------------------------- | -----------------------------------: | -----------------------------------------------------: | ---------------------: |
| `World.step` p50 (16 гравців)                |                             0.102 мс |                                           **0.062 мс** |               **−39%** |
| `World.step` p95 (16 гравців)                |                             0.396 мс |                                           **0.343 мс** |               **−13%** |
| `World.step` p99 (16 гравців)                |                             0.706 мс |                                           **0.582 мс** |               **−18%** |
| Колізії p50 / p99 (16 гравців, 81 сутність)  |                     0.054 / 0.215 мс |                                   **0.017 / 0.084 мс** | **3.2× / 2.6× швидше** |
| Колізії p50 / p99 (64 гравці, 207 сутностей) |                     0.358 / 0.478 мс |                                   **0.053 / 0.087 мс** | **6.8× / 5.5× швидше** |
| Алокації `Bullet` (600 тіків, 16 гравців)    |                 1 406 нових об'єктів |                       **81 алокація (94.2% recycled)** |    **−94.2% алокацій** |
| Алокації `Explosion` (600 тіків, 16 гравців) |                    292 нових об'єкти |                       **41 алокація (86.0% recycled)** |    **−86.0% алокацій** |

- **Топ-аллокатори до оптимізації**: створення нових `Bullet`, масивів частинок `Explosion` і тимчасових масивів `dead[]`/`candidates[]` на кожному кроці `World.step`.
- **Що зроблено**: перевикористовувані `ObjectPool<Bullet>` та `ObjectPool<Explosion>` (із `reset()` та фіксованим порядком полів для стабільних V8 Hidden Classes), багаторазові scratch-буфери (`#deadScratch`, `scratchCandidates`), та `SpatialHashGrid` із очищенням лише «брудних» комірок.

## Експеримент із Web Worker (Transferable `Float32Array`)

Модулі `client/src/workers/particle_worker.ts` і `client/src/render/particle_bridge.ts` виносять фізику візуальних
частинок вибухів (до 2048 частинок, 5 `float32` на частинку = 40 КБ) у фоновий Web Worker із подвійною буферизацією
та **zero-copy передачею** `[buffer.buffer]`.

- **Виграш на головному потоці:** при масових вибухах (500–2000 частинок) цикл інтегрування й затухання частинок повністю зникає з main thread, звільняючи бюджет 16.6 мс кадру під рендер Canvas і обробку вводу.
- **Накладні витрати:** один `postMessage` із Transferable передає лише вказівник на `ArrayBuffer` (O(1), ~0.02–0.05 мс), але додає 1 кадр асинхронної затримки для візуальних іскор (непомітно для ока). Для малої кількості частинок (< 50) накладні витрати пересилки співмірні з розрахунком, тому виграш максимальний саме у «гарячих» боях із десятками вибухів.
- **Офлайн-сумісність:** при відкритті `client/dist/index.html` по `file://` (де браузер блокує `new Worker` через null-origin) `createParticleSystem()` автоматично вмикає fallback у головному потоці.

## Навантажувальне тестування (`server/scripts/load_test.mjs`)

Запущено на цій машині (Node.js v26.13.1, одна кімната, 30 Гц, бінарний протокол, активна стрільба й рух, 3 с на сценарій):

| Клієнтів (`N`) | `tick avg` (мс) | `tick p99` (мс) | `ELU` (%) | `RSS` (МБ) | Downlink (КБ/с) | Uplink (КБ/с) | У бюджеті 33.3 мс? |
| -------------: | --------------: | --------------: | --------: | ---------: | --------------: | ------------: | :----------------: |
|          **8** |           0.555 |           2.096 |      4.2% |       92.2 |           211.5 |           2.8 |        Так         |
|         **32** |           1.083 |           1.654 |      8.3% |       99.3 |         2 526.0 |          11.4 |        Так         |
|         **64** |           1.713 |           2.615 |     15.4% |      107.0 |         9 032.2 |          23.9 |        Так         |
|        **128** |           3.177 |           4.483 |     32.3% |      139.9 |        36 404.6 |          50.7 |        Так         |

**Висновок щодо ємності та вузького місця:**
Завдяки `SpatialHashGrid` $O(n)$ та `ObjectPool` сама симуляція легко витримує **128 одночасних клієнтів** в одній
кімнаті (`tick p99 = 4.48 мс` при бюджеті `33.3 мс`, `ELU = 32.3%`, `RSS = 139.9 МБ`). Головним вузьким місцем
масштабування в одній кімнаті є **мережева розсилка $O(N^2)$**: кожен із `N` клієнтів отримує повний знімок усіх `N`
кораблів і їхніх куль, через що при `N = 128` вихідний трафік сягає **35.5 МБ/с** (`36 405 КБ/с`). Розрахункова
межа однієї кімнати без Interest Management (AOI) та дельта-стиснення становить **~220–250 гравців** (насичення
мережевої серіалізації та Event Loop).

## Знімок `Lab_7`

Повний знімок монорепозиторію збережено в `JavaScript_Labs/Lab_7` (включно з `e2e/`, `vitest.config.ts`,
`playwright.config.ts`, `.github/`, `client/dist/`) без `node_modules/`, `logs/`, `coverage/`, `playwright-report/`,
`test-results/` та `.DS_Store`.

---

## Prove It To Yourself — Результати експериментів

_Усі заміри виконано в Node.js `v26.13.1` (V8) на цільовій машині._

### 1. Оптимізація та деоптимізація V8 (`--allow-natives-syntax`)

Для `function add(a, b) { return a + b; }`:

```text
До 'a', 'b' (після прогріву числами):
  %GetOptimizationStatus(add) = 41 (0x29 = 0b101001 = kIsFunction | kOptimized | kTurboFanned)
Після виклику add('a', 'b'):
  %GetOptimizationStatus(add) = 65 (0x41 = 0b1000001 = kIsFunction | kInterpreted)
```

**Висновок:** зміна типу аргументів (Smi → String) негайно спричинила деоптимізацію скомпільованого TurboFan-коду назад до інтерпретатора Ignition.

### 2. Hidden Classes: мономорфний vs поліморфний масив vs `Float32Array` (`1 000 000` елементів)

| Структура даних (сума `.x` по `1e6` елементах) | Середній час | Відносно `Float32Array` |
| ---------------------------------------------- | -----------: | ----------------------: |
| Мономорфний масив `{ x, y }`                   | **4.455 ms** |        4.79× повільніше |
| Поліморфний масив (кожен 10-й із полем `.z`)   | **4.848 ms** |        5.21× повільніше |
| Плаский `Float32Array` (SoA / щільний буфер)   | **0.930 ms** |        **1.00× (база)** |

**Висновок:** єдина форма об'єктів (Hidden Class) прискорює inline-cache доступ, а перехід на щільний `Float32Array` (як у `particle_worker.ts`) дає прискорення у **4.8–5.2×** завдяки локальності кешу CPU та відсутності обходу вказівників.

### 3. Передача `50 MB` `ArrayBuffer` у Worker: Clone vs `Transferable`

| Спосіб `postMessage` (`52 428 800 B`)    |                   Час передачі |   `buf.byteLength` у відправника після надсилання |
| ---------------------------------------- | -----------------------------: | ------------------------------------------------: |
| Structured Clone (`postMessage(buf)`)    |                   **25.98 ms** |                        `52 428 800` (скопійовано) |
| Transferable (`postMessage(buf, [buf])`) | **0.47 ms** (**55.3× швидше**) | **`0`** (буфер передано без копіювання, detached) |

### 4. Property-based тестування (`fast-check`): `fc.float()` vs `fc.double()`

Перевірка властивості `Math.fround(x) === x` (`seed: 42`):

```text
fc.float({ noNaN: true })  -> failed: false (усі 32-бітні float проходять)
fc.double({ noNaN: true }) -> failed: true
  shrunk counterexample: [ 5e-324 ] (Number.MIN_VALUE)
  Math.fround(5e-324) === 0 !== 5e-324
```

**Висновок:** `fast-check` автоматично знаходить і стискає (shrink) мінімальний контрприклад (`5e-324`), підтверджуючи необхідність явного врахування 32-бітної точності (`Float32`) у бінарному кодеку.
