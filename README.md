# Dogfight - Лабораторна робота №6: TypeScript — Types for the Protocol, the Simulation, and Both Sides of the Wire

Шостий етап гри Dogfight: повна міграція монорепозиторію (`shared`, `server`, `client`) на суворий **TypeScript**
(`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`) зі збереженням ідентичного
рантайму, усіх тестів (включно з тестом детермінізму на 1000 кроків), бінарного протоколу 30 Гц та автономної
роботи `client/dist/index.html` по `file://`.

## Швидкий старт і CI

Потрібен Node.js ≥22 (нативний запуск `.ts` без транспиляції сервера — використовується виключно стираний синтаксис
без `enum` і parameter properties).

```bash
npm install            # встановлює залежності (typescript, zod, @types/node, @types/ws, ...)
npm run typecheck      # tsc --noEmit по всіх трьох пакетах (shared, server, client)
npm run lint           # ESLint + typescript-eslint (@typescript-eslint/no-explicit-any: error)
npm run format:check   # Prettier
npm test               # тести всіх workspaces (node --test *.test.ts)
npm run build          # збірка клієнта Vite у client/dist (base: './', сумісно з file://)
npm start              # node server/src/index.ts (http://localhost:3000)
npm run dev            # Node --watch server/src/index.ts + Vite (Windows npm.cmd і POSIX)
```

Мінімальний CI-воркфлоу живе в `.github/workflows/ci.yml` і на кожен push/PR виконує:
`npm ci` → `npm run typecheck` → `npm run lint` → `npm test` → `npm run build`.

## Архітектура типізації

- **`tsconfig.base.json`**: `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`,
  `erasableSyntaxOnly: true`, `target: "ES2023"`, `skipLibCheck: true`. Наслідується в `shared/tsconfig.json`,
  `server/tsconfig.json` та `client/tsconfig.json`.
- **`@dogfight/shared`**:
  - `src/types.ts` — брендовані типи `EntityId`, `Tick`, `Seq` та конструктори `asEntityId()`, `asTick()`, `asSeq()`.
  - `src/sim/` — незмінний `Vector2` (`readonly x`, `readonly y`), дискриміновані знімки `EntitySnapshot`, вичерпний `switch` із `never`.
  - `src/protocol.ts` — єдиний контракт усіх JSON-повідомлень (`ClientMessageSchema`, `ServerMessageSchema`, `RoomInputSchema`, `InputCommandSchema`) на **Zod** + `z.infer` і `parseClientMessage(raw)` через `safeParse` (старий ручний валідатор із Лаби №4 повністю видалено).
  - `src/codec/` — єдиний інтерфейс `Codec<TEncoded, TDecoded>` із реалізаціями `binaryCodec` (`DataView`, little-endian) та `jsonCodec`.
- **`server/`**:
  - `src/config.ts` — валідація змінних середовища через Zod-схему з дефолтами (`ServerConfig`).
  - `src/rooms.ts` — типізований `EventEmitter<RoomEvents>` та `EventEmitter<RoomManagerEvents>`.
  - `src/ws.ts`, `src/http.ts`, `src/match.ts`, `src/index.ts` — вичерпна диспетчеризація `ClientMessage`, звуження `catch (error: unknown)` перед доступом до `.message`/`.code`.
- **`client/`**:
  - `src/util/bus.ts` — типізована шина подій `Bus<GameEvents>` (заміна нетипізованого `EventTarget`/`CustomEvent` у зв'язці `NetClient`/`World` → `audio`).
  - `src/lobby/lobby_ui.ts`, `src/render/netgraph.ts`, `src/render/draw.ts` — суворо типізовані DOM-елементи й Canvas-рендер.

### Чому UI лобі та HUD залишено на чистому TypeScript + DOM

Лобі, чат і панель Netgraph не потребують віртуального DOM чи важкого UI-фреймворка: чистий TypeScript поверх
стандартного DOM API (`document.createElement<K extends keyof HTMLElementTagNameMap>`, `textContent` без `innerHTML`)
дає **нульовий оверхед рантайма**, не створює пауз GC паралельно з ігровим циклом 60–144 FPS на Canvas і зберігає
миттєвий автономний запуск зібраного `client/dist/index.html` подвійним кліком по `file://`.

## What TypeScript found

Увімкнення `strict` + `noUncheckedIndexedAccess` виявило конкретні потенційні баги, непомітні в JS:

1. **`server/src/index.ts` (`ws` possibly `null` у `shutdown`)** — якщо процес отримував сигнал завершення до ініціалізації `attachWebSocketServer`, `await ws.close()` падав би з `TypeError`; виправлено через `await ws?.close(...)`.
2. **`server/src/http.ts` (`replay[1]` і `target.split()[0]`)** — `noUncheckedIndexedAccess` показав, що група регексу та перший елемент `split` мають тип `string | undefined`; додано явні перевірки.
3. **`server/src/http.ts` та `ws.ts` (`catch (error: unknown)`)** — читання `error.code` та `error.message` без перевірки типу падало б при киданні не-`Error` значень; винесено безпечні звуження `errorCode()` / `instanceof Error`.
4. **`shared/src/sim/collision.ts` і `server/src/match.ts` (індексація масивів)** — звернення `candidates[i]`, `sorted[size - 1]`, `PICKUP_EFFECT_TYPES[idx]` без перевірки меж потенційно давали `undefined` на порожніх вибірках.
5. **`client/src/assets/sprite_art.ts` і `client/src/render/draw.ts` (словники спрайтів)** — `sheet.frames[name]` та `state.sheets.sprites` могли повернути `undefined` за помилкового ключа; додано `requireFrame()` і перевірки перед `drawSprite`.
6. **`client/src/net/net_client.ts` (межа `CustomEvent.detail` та буфер знімків)** — `#snapshotBuffer[0]`, `#bwSamples[0]` та вхідні повідомлення з WebSocket тепер валідуються перед використанням (`ServerSnapshotSchema.safeParse`), а не приймаються «на віру».
7. **`client/src/net/connection.ts` (`ArrayBufferView<ArrayBuffer>` vs `SharedArrayBuffer`)** — `WebSocket.send` і `TextDecoder.decode` не приймають потенційний `SharedArrayBuffer`; обмеження типу буфера прибрало ризик рантайм-винятку в браузері.
8. **`shared/src/sim/world.ts` (незмінність `WORLD_RULES` і `Vector2`)** — переведення `Vector2` на `readonly x / readonly y` і `WORLD_RULES` на `Readonly` усунуло можливість випадкової мутації спільних векторів між сутностями.

## 3 найцікавіші типи проєкту (для JS-розробника)

### 1. Branded types (`EntityId`, `Tick`, `Seq` у `shared/src/types.ts`)

```ts
export type EntityId = number & { readonly __brand: 'EntityId' };
export type Tick = number & { readonly __brand: 'Tick' };
export type Seq = number & { readonly __brand: 'Seq' };
```

У JavaScript ідентифікатор корабля, номер тіка сервера й порядковий номер інпуту — усе просто `number`, тому легко
переплутати аргументи `send(tick, seq)` замість `send(seq, tick)`. Брендований тип додає «невидиму бирку» тільки на
етапі компіляції: у рантаймі це досі звичайне число з нульовими витратами, але `tsc` одразу підсвітить помилку,
якщо передати `Tick` туди, де очікується `EntityId` чи `Seq`.

### 2. Discriminated Unions + Zod `z.infer` + Exhaustive `never` (`shared/src/protocol.ts`)

```ts
export const ClientMessageSchema = z.discriminatedUnion('type', [
  ClientJoinSchema,
  ClientChatSchema,
  ClientLeaveSchema /* ... */,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
```

Замість того щоб підтримувати окремо JS-валідатор і окремо TS-інтерфейси (які неминуче розходяться), ми описуємо
протокол **один раз** через Zod-схему. `safeParse` перевіряє сирий JSON у рантаймі, а `z.infer` автоматично будує
дискриміноване об'єднання для TypeScript. У кожному `switch (msg.type)` гілка `default: { const _exhaustive: never = msg; ... }`
гарантує: щойно з'явиться новий тип повідомлення, компілятор покаже кожне місце в коді, де його забули обробити.

### 3. Generic-шина подій `Bus<GameEvents>` (`client/src/util/bus.ts`)

```ts
type ListenerMap<E extends object> = { [K in keyof E]?: Set<(payload: E[K]) => void> };
export class Bus<E extends object> {
  on<K extends keyof E>(event: K, listener: (payload: E[K]) => void): () => void {
    /* ... */
  }
  emit<K extends keyof E>(event: K, payload: E[K]): void {
    /* ... */
  }
}
```

У стандартному `EventTarget` ім'я події — будь-який рядок, а `event.detail` має тип `any`. У `Bus<GameEvents>`
узагальнений ключ `K extends keyof E` зв'язує назву події з конкретним типом її даних `E[K]`: виклик
`bus.emit('fired', { missile: true })` перевіряється компілятором, а помилка в назві (`'firedd'`) або типі поля
ловиться ще до запуску браузера — причому без жодного `any` і без жодного `as`.

## Якість коду та знімок `Lab_6`

- `npm run typecheck`: **0 помилок** (`@dogfight/shared`, `dogfight-server`, `dogfight-client`).
- `npm run lint` & `npm run format:check`: **0 помилок, 0 попереджень**.
- **0 `any`** у всьому проєкті; лише **3** приведення `as` у всій кодовій базі (`asEntityId`, `asTick`, `asSeq` у `shared/src/types.ts`, кожне з коментарем-обґрунтуванням).
- `npm test`: **155 тестів пройдено, 0 провалено** (`shared`: 27, `server`: 94 + 1 skipped на Windows без прав на symlink, `client`: 34).
- `npm run build --workspace=client`: чиста збірка з `base: './'` у `client/dist/`.
- Знімок `JavaScript_Labs/Lab_6` містить повну структуру монорепозиторію (включно з `tsconfig.base.json`, `.github/`, `client/dist/`) без `node_modules/`, `logs/` і `.DS_Store`.

---

## Prove It To Yourself — Результати експериментів

_Перевірено на `TypeScript 6.0.3` (`strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`) та `Node.js v26.13.1`._

### 1. Excess Property Check (змінна проти свіжого літерала)

```ts
type Vec = { x: number };
const obj = { x: 1, y: 2 };
const a: Vec = obj; // OK — структурна сумісність
const b: Vec = { x: 1, y: 2 }; // TS2353: Object literal may only specify known properties, and 'y' does not exist in type 'Vec'.
```

**Висновок:** TypeScript виявляє друкарські помилки у полях при передачі свіжого об'єктного літерала напряму, але допускає структурний підтип через змінну.

### 2. Звуження `Map.get()` під `strict`

`Map<string, Ship>.get(id)` повертає `Ship | undefined`:

- `ship!.hp` — небезпечний non-null assertion (приховує можливий `TypeError` у рантаймі);
- `const hp = ship?.hp ?? 0` — безпечне значення за замовчуванням;
- `if (ship !== undefined) { ship.hp ... }` — рекомендоване звуження типу (control-flow narrowing).

### 3. Вичерпний `switch` із `never` (`assertNever`)

При додаванні нового варіанта до discriminated union (наприклад, `{ type: 'shutdown' }`) без обробки гілки у `switch`:

```text
TS2322: Type '{ type: "shutdown"; reason?: string | undefined; }' is not assignable to type 'never'.
```

**Висновок:** `const _exhaustive: never = msg` перетворює пропущений обробник протоколу з тихого бага на помилку компіляції.

### 4. Межа довіри `JSON.parse()` → `unknown` → `zod.safeParse()`

`JSON.parse()` у рантаймі може повернути будь-який тип; приведення через `as ClientMessage` обманює компілятор. У `@dogfight/shared` вхідні кадри проходять через `ClientMessageSchema.safeParse(raw)` — тип `ClientMessage` видається лише після реальної валідації всіх полів і діапазонів.

### 5. Нативний запуск `enum` у Node.js v26 проти `as const` union

Фактичний вивід `node -e "enum Dir { Left, Right }"` на `Node.js v26.13.1`:

```text
enum Dir { Left, Right }
^^^^
TypeScript enum is not supported in strip-only mode
SyntaxError: Unexpected reserved word
```

**Висновок:** Node.js v26 виконує `.ts` напряму через type-stripping (видалення типів без кодогенерації), тому нестирані конструкції (`enum`, `namespace`, parameter properties) заборонені прапорцем `erasableSyntaxOnly: true` і замінені на `as const` об'єкти + union-типи (`MsgType`, `CloseCode`, `Kind`).
