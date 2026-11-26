# Dogfight - Лабораторна робота №5: Real-Time Networking (Authoritative Server, Prediction, Binary Protocols)

П'ятий етап гри Dogfight: монорепозиторій (`client`, `server`, `shared`) із **авторитативним сервером** на 30 Гц,
спільною детермінованою симуляцією (`@dogfight/shared`), бінарним протоколом поверх `ArrayBuffer` + `DataView`,
**Client-Side Prediction & Server Reconciliation**, **Entity Interpolation**, емулятором поганої мережі
(`Latency / Jitter / Drop`) та живим оверлеєм **Netgraph** (`Tab` або `F3`).

## Швидкий старт

Потрібен Node.js ≥22 (`.nvmrc`).

```bash
npm install            # встановлює залежності всіх workspaces (client, server, shared)
npm run build          # збірка клієнта в client/dist (base: './', сумісно з file://)
npm start              # сервер: http://localhost:3000 (статика, REST, WebSocket)
```

```bash
npm run dev            # Node-сервер (--watch) + Vite (кросплатформенно, Windows npm.cmd + macOS/Linux)
npm test               # тести всіх трьох пакетів (node:test): shared, server, client
npm run lint           # ESLint по всьому монорепозиторію
npm run format:check   # Prettier
npm run bench --workspace=@dogfight/shared   # бенчмарк JSON vs Binary (DataView)
```

**Офлайн-режим (`file://`)**: подвійний клік по `client/dist/index.html` без запущеного сервера, як і раніше,
відкриває локальний матч із вбудованими даними й тією ж симуляцією з `@dogfight/shared`.

## Архітектура монорепозиторію

```
package.json                 workspaces: ["client", "server", "shared"]
scripts/dev.mjs              dev: Node-сервер + Vite (підтримка Windows npm.cmd і POSIX)
shared/                      @dogfight/shared: чиста детермінована симуляція без DOM і node:*
  src/sim/                   world.js, ship.js, bullet.js, asteroid.js, explosion.js, pickup.js,
                             entity.js, arena.js, collision.js, behaviors.js, vector.js, rng.js
                             (mulberry32, фіксований dt, toSnapshot / static fromSnapshot)
  src/protocol.js            TICK_RATE = 30, типи повідомлень, validateInput, expandInputMessage
  src/net_snapshot.js        buildSnapshotMessage, shipStateFromNet
  src/codec/binary_codec.js  бінарний кодек на ArrayBuffer + DataView (little-endian)
  src/codec/json_codec.js    JSON-кодек для порівняння трафіку й налагодження
  src/hash.js                FNV-1a worldHash для тестів детермінізму
  scripts/bench_codec.mjs    замір JSON vs Binary на 30 Гц (4 гравці)
server/                      авторитативний сервер на node:http + ws
  src/match.js               Match (30 Гц setTimeout без дрейфу setInterval, метрики тіка/джиттера)
  src/netsim.js              NetSim (Latency / Jitter / Packet Drop injector на з'єднання)
  src/ws.js                  бінарні кадри (INPUT/SNAPSHOT/PING/PONG) + керувальний JSON (ready/codec/netsim)
  src/http.js                GET /health (з tick-метриками), GET /api/stats, /api/rooms, /api/replays/:id
client/                      Vite + Canvas + Netcode
  src/net/connection.js      WebSocket із socket.binaryType = "arraybuffer", облік bytesIn/bytesOut
  src/net/net_client.js      Prediction, Reconciliation (+ smoothing ~100 мс), Entity Interpolation
  src/render/netgraph.js     оверлей Netgraph (Tab / F3) зі sparkline-графіком і повзунками
```

## HTTP API та керувальні повідомлення WebSocket

| Ендпоінт / повідомлення                                                   | Призначення                                                                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                             | стан сервера, uptime, кімнати, з'єднання, пам'ять і зведені `tick`-метрики (`avg/max` тривалість і джиттер)                      |
| `GET /api/stats`                                                          | детальна статистика активних матчів: тік, сутності, `tickDurationMs`, `tickJitterMs` (`avg/p99/max`), лічильники вводу й трафіку |
| `GET/POST /api/rooms`, `GET /api/replays/:id`                             | створення/список кімнат і потокова віддача NDJSON-журналів (`pipeline`)                                                          |
| `WS /ws?latency=100&jitter=30&drop=0.02`                                  | підключення з початковою емуляцією поганої мережі                                                                                |
| `ready { codec? }`, `codec { codec }`, `netsim { latency, jitter, drop }` | керувальні JSON-повідомлення входу в матч, перемикання `binary`/`json` і живої зміни емуляції мережі                             |

## Специфікація бінарного протоколу (`ArrayBuffer` + `DataView`)

Усі багатобайтові числа кодуються строго в **little-endian (`true`)**. Кожен кадр починається з 4-байтного заголовка:

| Зсув | Розмір | Тип     | Поле       | Опис                                                |
| ---- | ------ | ------- | ---------- | --------------------------------------------------- |
| `0`  | 1      | `Uint8` | `magic`    | `0xD6` (сигнатура Dogfight)                         |
| `1`  | 1      | `Uint8` | `version`  | `1` (версія розкладки)                              |
| `2`  | 1      | `Uint8` | `type`     | `1 = INPUT`, `2 = SNAPSHOT`, `3 = PING`, `4 = PONG` |
| `3`  | 1      | `Uint8` | `reserved` | `0`                                                 |

### `INPUT` (клієнт → сервер, `15 + 2·count` байт; при `count = 3` — 21 байт)

- `4`: `Uint32 seq` — порядковий номер команди.
- `8`: `Uint32 tick` — оцінка поточного тіка сервера.
- `12`: `Uint8 count` — кількість попередніх команд у пакеті (`0..4`, надлишковість проти втрат).
- `13`: `Uint8 flags` — біт 0 `thrust`, біт 1 `fire`, біт 2 `missile`.
- `14`: `Int8 turn` — поворот `[-1, 1] → [-127, 127]`.
- `15 + 2·i`: `count` попередніх команд `{ Uint8 flags, Int8 turn }` (`seq-1, seq-2, ...`).

### `PING` (12 байт) / `PONG` (16 байт)

- `PING`: `4: Float64 clientTime`.
- `PONG`: `4: Float64 clientTime`, `12: Uint32 serverTick`.

### `SNAPSHOT` (сервер → клієнт, `19 + записи`)

- `4`: `Uint32 tick`
- `8`: `Uint32 lastProcessedSeq` — остання оброблена команда **цього** клієнта (фіксований зсув дозволяє серверу кодувати знімок один раз і підставляти 4 байти на одержувача).
- `12`: `Uint8 nShips`, `13`: `Uint16 nAsteroids`, `15`: `Uint16 nBullets`, `17`: `Uint8 nPickups`, `18`: `Uint8 nEvents`.
- **Запис судна (32 байти)**: `u32 id`, `f32 x`, `f32 y`, `f32 vx`, `f32 vy`, `i16 angle` (**квантування в 1/1000 рад**, похибка ≤ 0.0005 рад), `u8 hp`, `u8 flags` (`alive | thrust | rapid`), `u8 invulnerable` (0.1 с), `u8 fireCooldown` (мс), `u8 rapidLeft` (0.1 с), `u8 respawnIn` (0.1 с), `u32 score`.
- **Запис астероїда (19 байт)**: `u32 id`, `f32 x`, `f32 y`, `i16 vx`, `i16 vy` (0.1 пкс/с), `i16 angle` (1/1000 рад), `u8 flags` (`size | hunter`).
- **Запис кулі (21 байт)**: `u32 id`, `f32 x`, `f32 y`, `i16 vx`, `i16 vy` (0.1 пкс/с), `u32 owner`, `u8 flags` (`missile`).
- **Запис бонусу (14 байт)**: `u32 id`, `f32 x`, `f32 y`, `u8 effect`, `u8 remaining` (с).
- **Запис події вибуху (11 байт)**: `u8 type`, `u8 kind`, `u8 size`, `f32 x`, `f32 y`.

## Порівняння JSON vs Binary (`DataView`)

Виміряно скриптом `npm run bench --workspace=@dogfight/shared` (Node.js, 10 000 ітерацій, реальна сцена: **4 гравці, 30 Гц**, 4 судна, 3 астероїди, 15 куль, 1 бонус):

| Формат                  | Bytes / snapshot |   Bytes / input | KB/s down (1 гравець / 4 гравці) | KB/s up (1 гравець / 4 гравці) | Encode + Decode (µs) |
| ----------------------- | ---------------: | --------------: | -------------------------------: | -----------------------------: | -------------------: |
| **JSON**                |          2 606 B |           267 B |              76.35 / 305.39 KB/s |              7.82 / 31.29 KB/s |              27.7 µs |
| **Binary (`DataView`)** |        **533 B** |        **21 B** |           **15.62 / 62.46 KB/s** |           **0.62 / 2.46 KB/s** |           **4.2 µs** |
| **Виграш Binary**       |   **4.9× менше** | **12.7× менше** |               **−79.5% трафіку** |             **−92.1% трафіку** |      **6.6× швидше** |

## Архітектура Netcode

Мережевий екшн реального часу розв'язує три фундаментальні проблеми, які суперечать одна одній:

1. **Затримка (Latency).** Між натисканням клавіші й відповіддю сервера минає `RTT` (40–250 мс). Чекати підтвердження сервера перед поворотом або пострілом неможливо — керування відчуватиметься «киселем». У Dogfight локальне судно реагує **миттєво** завдяки **Client-Side Prediction**: клієнт виконує той самий крок фізики з `@dogfight/shared` на частоті 30 Гц, локально породжує власні кулі (поки їхній `seq` не підтверджено сервером) і паралельно відправляє команду вводу із `seq` та 3 попередніми командами (надлишковість маскує поодинокі втрати пакетів).
2. **Консистентність (Consistency).** Усі гравці мають бачити узгоджений світ, попри те, що кожен клієнт іде попереду сервера на `~RTT/2`, а чужі пакети приходять із джиттером. Сервер веде єдиний авторитативний `World` у точному циклі **30 Гц** через `setTimeout` до абсолютного часу `nextTick += 1000 / 30` (без накопичувального дрейфу `setInterval`) і розсилає кожному клієнту знімок із його `lastProcessedSeq`.
3. **Захист від читерства (Anti-Cheat).** Клієнт ніколи не передає координати, швидкість чи влучання — лише наміри `{ seq, tick, thrust, turn, fire }`. Сервер перевіряє межі (`validateInput`: `|turn| ≤ 1`, валідні прапорці, `tick` не в майбутньому), знімає **рівно одну** команду за тік (захист від спід-хаку), обмежує частоту пакетів (`TokenBucket`) і сам рахує всі зіткнення, шкоду, перезарядку та очки.

### Як працює Server Reconciliation і чому критичний детермінізм

Щоразу, коли надходить серверний `SNAPSHOT`, клієнт виконує звірку для свого судна:

1. Відкидає з буфера всі підтверджені команди (`seq <= lastProcessedSeq`) і прибирає відповідні локальні кулі (їх замінюють серверні).
2. Ставить у локальний корабель авторитативний стан із сервера (`syncPlayerShip`).
3. Повторно програє (`replay`) всі неподтверджені команди, що залишилися в буфері, із фіксованим кроком `TICK_DT = 1/30` с.
4. Різницю між старою візуальною позицією і новою скоригованою додає до `smoothOffset`, який експоненційно згасає за **~100 мс** (`τ = 45 мс`), а при великому стрибку (респаун, >160 пкс) робить миттєвий snap.

**Детермінізм** (`@dogfight/shared` без `Math.random`, `Date.now`, DOM і `node:*`, із `mulberry32` і однаковим `TICK_DT`) гарантує, що за відсутності несподіваних зовнішніх зіткнень повторне програвання дає **нульову** похибку коррекції — корабель не смикається навіть при 150 мс затримки.

### Компроміс вибору `interpolationDelay`

Чужі судна, астероїди й серверні кулі рендеряться **в минулому** (`renderTime = now - interpolationDelay`) шляхом інтерполяції між двома сусідніми знімками з буфера (з урахуванням тороїдального wrap-around через `wrappedDelta` і `lerpAngle`):

- **Замалий `interpolationDelay` (< 33–50 мс на 30 Гц):** за будь-якого джиттера чи втрати одного знімка буфер вичерпується, клієнт змушений екстраполювати, і чужі кораблі починають «телепортуватися» або смикатися.
- **Завеликий `interpolationDelay` (> 150–200 мс):** рух ідеально плавний, але гравець бачить супротивників із відчутним відставанням у часі, що ускладнює прицілювання.
- **Оптимальний баланс для 30 Гц (~33.3 мс між знімками):** **66–100 мс** (за замовчуванням **80 мс**, тобто 2–3 інтервали знімків). Це покриває один втрачений пакет або помірний джиттер без помітного лагу; повзунок у Netgraph (`Tab` / `F3`) дозволяє перевірити цей компроміс наживо.

## Структура знімка `Lab_5` та якість коду

У `JavaScript_Labs/Lab_5` зберігається повний знімок монорепозиторію (`package.json`, `package-lock.json`, `shared/`, `client/` із зібраним `client/dist/`, `server/`, `scripts/`, конфіги, `.env.example`, `README.md`) без `node_modules/`, `logs/` і `.DS_Store`.

- `npm test`: **184 тести пройдено** (`shared`: 29, `server`: 122 + 1 skipped на Windows без прав на симлінки, `client`: 33).
- `npm run lint`: 0 помилок, 0 попереджень.
- `npm run build --workspace=client`: чиста збірка з `base: './'`, працює як через Node-сервер, так і по `file://`.
- Кодування всіх файлів: **UTF-8 без BOM, LF**.

---

## Prove It To Yourself — Результати експериментів

_Усі заміри виконано в Node.js `v26.13.1` на цільовій машині (x86_64, Little-Endian)._

### 1. Порядок байтів (Endianness) у `DataView` для `Float32(1.5)`

```text
DataView.setFloat32(0, 1.5, true)  [LE] -> [ 0, 0, 192, 63 ]   (0x00 0x00 0xC0 0x3F)
DataView.setFloat32(0, 1.5, false) [BE] -> [ 63, 192, 0, 0 ]   (0x3F 0xC0 0x00 0x00)
```

**Висновок:** представлення `1.5` у форматі IEEE 754 (`0x3FC00000`) дзеркально змінюється при перемиканні прапорця `littleEndian`. У бінарному кодеку `@dogfight/shared` прапорець `true` (little-endian) задається явно в усіх викликах `DataView`.

### 2. Залежність TypedArray від CPU-endian

```text
new Uint16Array(new Uint8Array([1, 0, 0, 1]).buffer) -> [ 1, 256 ]
```

**Висновок:** `Uint16Array` інтерпретує буфер у нативному порядку байтів процесора (`[1, 0]` = `1`, `[0, 1]` = `256` на x86_64 LE; на Big-Endian CPU ті самі байти дали б `[256, 1]`). Тому мережевий протокол має використовувати `DataView`, а не пряме приведення через `Uint16Array`/`Float32Array`.

### 3. Розмір пакета: `JSON.stringify` проти `DataView` (8 кораблів)

| Формат                                       | Розмір кадру |        Економія |
| -------------------------------------------- | -----------: | --------------: |
| `JSON.stringify` (8 кораблів)                |    **613 B** |           1.00× |
| Binary `DataView` (5 B заголовок + 8 × 21 B) |    **173 B** | **3.54× менше** |

### 4. Джитер і дрейф `setInterval(..., 33)` проти абсолютного `setTimeout` (`nextTick += 1000/30`, 2 с)

| Таймер (2 секунди, ціль 60 тиків) | Тиків | Підсумковий дрейф | Макс. `|дрейф|` |
| --- | ---: | ---: | ---: |
| `setInterval(..., 33)` | 43 | **576.82 ms** | **576.82 ms** |
| Абсолютний `setTimeout` (`next += 33.333`) | **60** | **7.85 ms** | **21.92 ms** |

**Висновок:** `setInterval(33)` накопичує похибку кроку й квантування таймера ОС, втрачаючи 17 тиків за 2 секунди. Самокоригувальний `setTimeout` з абсолютним розкладом тримає рівно 60 тиків за 2 с (30 Гц).

### 5. Детермінізм симуляції на 1 000 кроків (`mulberry32` vs `Math.random()`)

```text
mulberry32 (run1 vs run2): 8d7099e2 === 8d7099e2  (біт-в-біт ідентично)
Math.random (rand1 vs rand2): a8fdec5a !== 82d45196 (розходження)
```

**Висновок:** заміна `Math.random()` на seeded PRNG (`mulberry32`) і фіксований `dt` гарантує збіг клієнтського передбачення та авторитативного сервера.
