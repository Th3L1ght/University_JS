# Dogfight (`v1.0.0`)

Багатокористувацький 2D arena-shooter у реальному часі з авторитативним Node.js-сервером, клієнтським передбаченням і узгодженням (prediction & reconciliation), бінарним мережевим протоколом (`ArrayBuffer` + `DataView`), суворим TypeScript, оптимізацією гарячих шляхів V8 (`SpatialHash`, `ObjectPool`, Web Worker), Prometheus-метриками, Docker-контейнеризацією та PWA.

---

## Швидкий старт

### Локальний запуск (3 команди)

```bash
npm ci
npm run build
npm start
```

Відкрийте `http://127.0.0.1:3000`. Для режиму розробки з Vite HMR: `npm run dev`.

### Запуск у Docker

```bash
docker compose up --build
```

Сервер піднімається на `http://127.0.0.1:3000` з `HEALTHCHECK` на `/health`, персистентним томом логів `dogfight_logs` і коректним `SIGTERM` shutdown.

### Автономний офлайн-режим (`file://`)

Після `npm run build` клієнт (`client/dist/index.html`) зібрано з `base: './'`: його можна відкривати напряму через `file://` без вебсервера — Service Worker і Web Worker безпечно деградують, а вбудована симуляція дозволяє грати локально.

---

## Керування

| Клавіша           | Дія                                                        |
| ----------------- | ---------------------------------------------------------- |
| `←` `→` / `A` `D` | Поворот корабля                                            |
| `↑` / `W`         | Тяга вперед                                                |
| `Пробіл`          | Стрільба (основна гармата)                                 |
| `X` / `E`         | Ракета / спецпостріл                                       |
| `M`               | Увімкнути / вимкнути звук                                  |
| `Tab` / `F3`      | Netgraph (RTT, кодек JSON/Binary, емуляція втрат/затримки) |

---

## Архітектура монорепозиторію

```text
workspace/
├── shared/     # @dogfight/shared — чиста детермінована симуляція (30 Гц, mulberry32),
│               # SpatialHash, ObjectPool, Zod-схеми протоколу, JSON і Binary (DataView) кодеки
├── server/     # dogfight-server — node:http + ws, кімнати, авторитативний Match (30 Гц),
│               # боти, NDJSON-журнали, pino JSON-логи, prom-client /metrics, /health, /ready
├── client/     # dogfight-client — Vite + Canvas 2D + Web Audio, prediction & reconciliation,
│               # entity interpolation, Web Worker (Float32Array Transferable), Netgraph, PWA
├── e2e/        # Playwright E2E-тести (офлайн, мультиплеєр 2 вкладки, боти)
├── Dockerfile  # Multi-stage node:22-alpine (< 200 MB, USER node, HEALTHCHECK)
└── .github/workflows/ci.yml  # CI/CD: typecheck, lint, tests, chaos, Docker size gate, GHCR release
```

---

## Production Observability & Hardening

- **Структуровані логи (`pino`):** JSON у `stdout`, рівень керується `LOG_LEVEL` (за замовчуванням `info`), автоматичне маскування чутливих полів (`authorization`, `cookie`, `password`, `token`, `secret`, `chatText`). Логуються події `room.created`, `player.joined`, `player.left`, `ws.rejected`, `server.shutdown`, `server.fatal`.
- **Health & Readiness probes:**
  - `GET /health` — liveness-проба (`status: "ok"`, `version`, `uptimeSec`, `rooms`, `connections`, `tick`, `memory`).
  - `GET /ready` — readiness-проба (`200` коли бандл клієнта готовий і сервер не вимикається; `503` під час graceful shutdown).
- **Метрики Prometheus (`GET /metrics`):** `dogfight_players_connected`, `dogfight_rooms_active`, `dogfight_ws_messages_total`, `dogfight_ws_bytes_total`, `dogfight_tick_duration_p99_ms`, `dogfight_event_loop_utilization`, `dogfight_process_rss_bytes`, `dogfight_ws_rejected_total{reason=...}`.
- **Захист та ліміти (`Zod`-валідація env у `server/src/config.ts`):**
  - перевірка `Origin` при WS handshake (`ALLOWED_ORIGINS`, код закриття `4008`);
  - обмеження з'єднань з одного IP (`MAX_CONNECTIONS_PER_IP`, код `1013`);
  - token-bucket rate limiter на повідомлення і ввід (`4005`), валідація payload (`4003`);
  - graceful shutdown (`SIGTERM`/`SIGINT`): `/ready` → `503`, розсилка `{ type: "shutdown" }`, закриття WS із `1001`, завершення NDJSON-журналів і `logger.flush()` за `< 5 c`; fail-fast при `uncaughtException`/`unhandledRejection` з кодом `1`.
- **Хаос-тест (`npm run chaos`):** перевіряє флуд 1000 битими фреймами/с від атакуючого клієнта без деградації `tick p99` сусідньої кімнати та коректне завершення/перепідключення.

---

## Бенчмарки семестру

### 1. Мережевий протокол: JSON vs Binary (`DataView`, Lab 5)

_Сценарій: 4 гравці, 30 Гц снапшоти + 30 Гц інпути._

| Метрика                             |        JSON | Binary (`DataView`) |         Приріст |
| ----------------------------------- | ----------: | ------------------: | --------------: |
| Розмір снапшота                     |     2 606 B |           **533 B** |  **4.9× менше** |
| Розмір кадру вводу                  |       267 B |            **21 B** | **12.7× менше** |
| Вхідний трафік (1 гравець)          |  76.35 KB/s |      **15.62 KB/s** |  **4.9× менше** |
| Сумарний вихідний трафік (4 гравці) | 305.39 KB/s |      **62.46 KB/s** |  **4.9× менше** |
| Час encode + decode                 |     27.7 µs |          **4.2 µs** | **6.6× швидше** |

### 2. Оптимізація симуляції V8: `SpatialHash` + `ObjectPool` (Lab 7)

_Сценарій: 600 тиків, порівняння O(N²) перевірки колізій без пулів проти SpatialHash + ObjectPool._

| Сценарій                     | Метрика                         |      До (Before) |        Після (After) |                  Ефект |
| ---------------------------- | ------------------------------- | ---------------: | -------------------: | ---------------------: |
| 16 гравців (81 сутність)     | `World.step` p50 / p99          | 0.102 / 0.706 ms | **0.062 / 0.582 ms** |        **−39% / −18%** |
| 16 гравців (81 сутність)     | Колізії p50 / p99               | 0.054 / 0.215 ms | **0.017 / 0.084 ms** | **3.2× / 2.6× швидше** |
| 64 гравці (207 сутностей)    | Колізії p50 / p99               | 0.358 / 0.478 ms | **0.053 / 0.087 ms** | **6.8× / 5.5× швидше** |
| Пули об'єктів (`ObjectPool`) | Перевикористання куль / вибухів |               0% |    **94.2% / 86.0%** |    мінімум GC-алокацій |

### 3. Навантажувальне тестування сервера (`npm run loadtest`, Lab 7)

_Сценарій: `N` підключених клієнтів в одній кімнаті, 30 Гц авторитативні снапшоти (Binary)._

| Клієнтів (`N`) | Tick `p99` | Event Loop Utilization | RSS пам'ять | Вихідний трафік |
| -------------: | ---------: | ---------------------: | ----------: | --------------: |
|              8 |    2.10 ms |                   4.2% |     92.2 MB |      211.5 KB/s |
|             32 |    1.65 ms |                   8.3% |     99.3 MB |      2 526 KB/s |
|             64 |    2.62 ms |                  15.4% |    107.0 MB |      9 032 KB/s |
|            128 |    4.48 ms |                  32.3% |    139.9 MB |     36 405 KB/s |

_Вузьке місце:_ `O(N²)` розсилка повного стану кімнати кожному підключеному клієнту (прогнозована межа ~220–250 гравців в одній кімнаті до перевищення бюджету 33.3 мс).

---

## Known Limitations & Architecture Trade-offs

- **Однопроцесна пам'ять (in-memory rooms):** стан кімнат і матчів живе в одному процесі Node.js без Redis/sticky-session кластеризації — це дає мінімальну затримку (< 5 мс `p99` на 128 гравців), але обмежує горизонтальне масштабування без зовнішнього брокера.
- **Повні снапшоти замість delta-compression:** бінарний протокол зменшує кадр у 4.9×, проте при 128+ гравцях в одній кімнаті відсутність interest management (AOI) і delta-кодування призводить до зростання трафіку як `O(N²)`.
- **Проста автентифікація за нікнеймом:** немає OAuth/JWT-акаунтів або персистентної бази лідербордів; реплеї пишуться в локальні NDJSON-файли (`LOG_DIR`).
- **Node.js native TypeScript execution:** сервер запускається напряму (`node server/src/index.ts`) з використанням лише стираного синтаксису (`erasableSyntaxOnly`), що прибирає крок компіляції сервера, але вимагає Node.js `>= 22.18` (або `24+`).

## What I'd Do Next

1. **Delta-compression + Area of Interest (AOI):** надсилати клієнту лише змінені поля сутностей у радіусі видимості камери, щоб знизити трафік з `O(N²)` до `O(N)`.
2. **Lag compensation (server rewind) для стрільби:** перевірка влучань за історією позицій на момент пострілу гравця з урахуванням його RTT.
3. **Горизонтальне масштабування кімнат:** виділення matchmaker-сервісу та маршрутизація кімнат по воркерах/нодах з експортом метрик у Grafana.
4. **Плеєр реплеїв у клієнті:** відтворення збережених NDJSON-журналів (`GET /api/replays/:id`) із таймлайном і перемотуванням.

---

## Еволюція проєкту (`Lab_1` — `Lab_8`)

| Етап      | Ключові результати                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lab 1** | Базовий ігровий цикл (fixed timestep), фізика корабля, Canvas 2D рендеринг, керування.                                                                                                                                             |
| **Lab 2** | Сутності (кулі, астероїди, вибухи, підсилювачі), колізії, поведінки, локальний HUD.                                                                                                                                                |
| **Lab 3** | Асинхронний завантажувач ресурсів, процедурний Web Audio, екран завантаження, лобі-UI, офлайн-сумісність.                                                                                                                          |
| **Lab 4** | Власний сервер (`node:http` + `ws`), кімнати, чат, NDJSON-журнали матчів, graceful shutdown.                                                                                                                                       |
| **Lab 5** | Пакет `@dogfight/shared`, авторитативний сервер 30 Гц, prediction & reconciliation, інтерполяція, бінарний кодек `DataView`, Netgraph.                                                                                             |
| **Lab 6** | Повна міграція на суворий TypeScript (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`), Zod-валідація протоколу й конфігу, CI.                                                                  |
| **Lab 7** | Vitest + `fast-check` + Playwright E2E, `SpatialHash`, `ObjectPool`, Web Worker для частинок (`Float32Array`), серверні боти, навантажувальний тест до 128 клієнтів.                                                               |
| **Lab 8** | Production-сервер (`pino`, `prom-client` `/metrics`, `/health`, `/ready`), захист (`Origin`, per-IP ліміт, chaos-тест), multi-stage `Dockerfile` + `docker-compose.yml`, Release CI/CD (`ghcr.io`), PWA, фінальний реліз `v1.0.0`. |

---

## Prove It To Yourself — Результати експериментів

_Перевірено на `Node.js v26.13.1`, `dogfight-server v1.0.0`, `Dockerfile` та `server/scripts/chaos_test.mjs`._

### 1. Сигнал `SIGTERM`, Graceful Shutdown і пастка `CMD npm start`

- Після отримання `SIGTERM` сервер негайно переводить `GET /ready` у `503`, розсилає клієнтам `{ type: 'shutdown', reason: 'server_shutting_down' }`, закриває WebSocket-з'єднання з кодом **`1001` (`GOING_AWAY`)**, завершує запис NDJSON-журналів, скидає буфер `pino` (`logger.flush()`) і виходить із кодом **`0`** за `< 5 c` (підтверджено `npm run chaos`: `gracefulShutdown=1001 reconnect=OK`).
- **Чому не можна писати `CMD npm start` у shell-формі:** shell (`/bin/sh -c`) і процес `npm` стають PID 1 та часто не передають `SIGTERM` дочірньому `node`, через що Docker чекає весь `stop_grace_period` і завершує сервер через `SIGKILL` (обриваючи журнали та сокети). У нашому `Dockerfile` використано exec-форму `CMD ["node", "server/src/index.ts"]`, тому `node` сам є PID 1.

### 2. Кешування шарів Docker (`COPY package*.json` до `COPY . .`)

У multi-stage [Dockerfile](./Dockerfile) спершу копіюються лише `package.json`, `package-lock.json` та маніфести workspace-пакетів, далі виконується `npm ci` (і `npm ci --omit=dev` у `runtime`-шарі), і лише потім копіюються вихідні файли (`shared/src`, `server/src`, `client/dist`). За правки вихідного коду кеш шару `npm ci` не інвалідується, що скорочує час перезбірки образу з десятків секунд до ~1–2 с.

### 3. Mixed Content: `ws://` зі сторінки `https://`

Браузери блокують незашифрований `ws://` під час відкриття сторінки по `https://` (`SecurityError: Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS`). У `client/src/lobby/lobby.ts` функція `defaultWsUrl()` автоматично обирає `wss:` для `https:` і `ws:` для `http:`.

### 4. Відхилення WebSocket із чужого `Origin` (`4008`)

Перевірено інтеграційним тестом у `server/test/server.spec.ts`: за `ALLOWED_ORIGINS=https://dogfight.example` спроба підключення з `Origin: https://evil.example` негайно відхиляється з кодом **`4008` (`FORBIDDEN_ORIGIN`)**, а в `GET /metrics` інкрементується `dogfight_ws_rejected_total{reason="origin"} 1`.

### 5. Стрибок `eventLoopUtilization` під час блокування циклу подій

Фактичний замір `performance.eventLoopUtilization()` у Node.js `v26.13.1` під час синхронного блокування event loop на 150 мс:

```text
ELU_SPIKE: { utilization: 0.7156, activeMs: 150.44, idleMs: 59.78 }
```

**Висновок:** синхронне навантаження миттєво відображається стрибком метрики `dogfight_event_loop_utilization` (до `71.56%` в експерименті, проти `4.2%` у штатній роботі на 8 гравцях), що дозволяє алертам Prometheus/Grafana вчасно виявляти деградацію ігрового тику.
