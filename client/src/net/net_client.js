/**
 * Клієнтський Netcode: Client-Side Prediction, Server Reconciliation, Entity Interpolation,
 * локальне прогнозування куль і збір метрик для Netgraph.
 *
 * Модуль не залежить від DOM чи Canvas, тож тестується напряму в Node (client/test/).
 */

import {
  ARENA_SIZE,
  ASTEROID_SIZES,
  binaryCodec,
  createRng,
  Explosion,
  INPUT_LIMITS,
  Kind,
  lerp,
  lerpAngle,
  MsgType,
  normalizeControls,
  PICKUP_EFFECTS,
  SHIP_PARAMS,
  shipStateFromNet,
  shortestAngleDelta,
  TICK_DT,
  TICK_MS,
  World,
  wrapAngle,
  wrapEntity,
  wrappedDelta,
} from '@dogfight/shared';

const LOCAL_PLAYER_KEY = 'self';
const FIRST_PREDICTED_ID = 1_000_000;
const MAX_SNAPSHOT_BUFFER = 45; // ~1.5 с на 30 Гц
const MAX_PENDING_INPUTS = 120;
const SNAP_THRESHOLD_PX = 160; // більша похибка (наприклад, респаун) - миттєвий snap без згладжування
const SMOOTH_TAU_SEC = 0.045; // за 100 мс згасає ~89% похибки: 1 - e^(-0.1/0.045)
const MAX_EXTRAPOLATION_SEC = 0.1;
const PING_INTERVAL_MS = 500;
const HISTORY_LENGTH = 90;

function wrapCoord(value, size) {
  if (size <= 0) return value;
  return ((value % size) + size) % size;
}

function interpolatePos(prev, next, t, width, height) {
  const dx = wrappedDelta(prev.x, next.x, width);
  const dy = wrappedDelta(prev.y, next.y, height);
  return {
    x: wrapCoord(prev.x + dx * t, width),
    y: wrapCoord(prev.y + dy * t, height),
  };
}

function makeShipView(record, pos, angle) {
  return {
    id: record.id,
    kind: Kind.SHIP,
    pos,
    prevPos: pos,
    angle,
    prevAngle: angle,
    radius: SHIP_PARAMS.radius,
    alive: record.alive,
    hp: record.hp,
    thrust: record.thrust ? 1 : 0,
    invulnerable: record.invulnerable,
    hasBuff: (name) => name === 'rapid' && record.rapid,
    *activeBuffs() {
      if (record.rapid && record.rapidLeft > 0) yield ['rapid', record.rapidLeft];
    },
  };
}

function makeAsteroidView(record, pos, angle) {
  const cfg = ASTEROID_SIZES[record.size] ?? ASTEROID_SIZES[3];
  return {
    id: record.id,
    kind: Kind.ASTEROID,
    pos,
    prevPos: pos,
    angle,
    prevAngle: angle,
    radius: cfg.radius,
    size: record.size,
    alive: true,
    components: record.hunter ? { homing: true } : {},
  };
}

function makeBulletView(record, pos, angle) {
  return {
    id: record.id,
    kind: Kind.BULLET,
    pos,
    prevPos: pos,
    angle,
    prevAngle: angle,
    radius: 3,
    alive: true,
    owner: record.owner,
    components: record.missile ? { homing: true } : {},
  };
}

function makePickupView(record) {
  const effect = PICKUP_EFFECTS[record.effect] ?? PICKUP_EFFECTS.heal;
  const pos = { x: record.x, y: record.y };
  return {
    id: record.id,
    kind: Kind.PICKUP,
    pos,
    prevPos: pos,
    angle: 0,
    prevAngle: 0,
    radius: 14,
    alive: true,
    components: {
      pickup: { effect },
      lifetime: { remaining: record.remaining },
    },
  };
}

export class NetClient extends EventTarget {
  #connection;
  #now;
  #world;
  #visualRng = createRng(0x5a17);
  #explosions = [];
  #arena = { width: ARENA_SIZE.width, height: ARENA_SIZE.height };
  #localShipId = null;
  #score = 0;
  #respawnIn = 0;
  #codec = 'binary';
  #netsimEnabled = true;
  #netsim = { latency: 0, jitter: 0, drop: 0 };
  #interpolationDelayMs = 80;

  #seq = 0;
  #estimatedServerTick = 0;
  #lastProcessedSeq = 0;
  #recentControls = []; // для надлишкового поля prev в INPUT
  #pendingInputs = []; // неподтверджені команди { seq, controls }
  #predictedBullets = []; // { bullet, seq }
  #smoothOffset = { x: 0, y: 0, angle: 0 };

  #snapshotBuffer = []; // [{ receivedAt, snapshot }]
  #lastSnapshotAt = null;
  #lastServerTick = 0;
  #started = false;

  // Метрики для Netgraph
  #rttMs = 0;
  #correctionMag = 0;
  #pingTimer = null;
  #bwSamples = []; // [{ t, bytesIn, bytesOut }]
  #kbInPerSec = 0;
  #kbOutPerSec = 0;
  #history = [];
  #lastHistoryAt = 0;
  #listeners = [];

  /**
   * @param {object} options
   * @param {import('./connection.js').Connection} options.connection
   * @param {'binary' | 'json'} [options.codec]
   * @param {number} [options.interpolationDelayMs]
   * @param {() => number} [options.now]
   */
  constructor({
    connection,
    codec = 'binary',
    interpolationDelayMs = 80,
    now = () => performance.now(),
  }) {
    super();
    this.#connection = connection;
    this.#codec = codec;
    this.#interpolationDelayMs = interpolationDelayMs;
    this.#now = now;
    this.#world = new World({
      width: this.#arena.width,
      height: this.#arena.height,
      seed: 1,
      firstId: FIRST_PREDICTED_ID,
      rules: { initialAsteroids: 0, minAsteroids: 0, maxPickups: 0 },
    });
    this.#bindConnection();
  }

  get started() {
    return this.#started;
  }

  get codec() {
    return this.#codec;
  }

  get interpolationDelayMs() {
    return this.#interpolationDelayMs;
  }

  get netsimEnabled() {
    return this.#netsimEnabled;
  }

  get netsim() {
    return { ...this.#netsim };
  }

  get localShipId() {
    return this.#localShipId;
  }

  get pendingCount() {
    return this.#pendingInputs.length;
  }

  #bindConnection() {
    const on = (type, handler) => {
      this.#connection.addEventListener(type, handler);
      this.#listeners.push([type, handler]);
    };
    on('start', (event) => this.onStart(event.detail));
    on('snapshot', (event) => this.onSnapshot(event.detail));
    on('pong', (event) => this.onPong(event.detail));
    on('netsim', (event) => {
      const { latency, jitter, drop } = event.detail;
      this.#netsim = { latency, jitter, drop };
      this.dispatchEvent(new CustomEvent('netsim', { detail: this.netsim }));
    });
  }

  /** Надсилає `ready`, запускає періодичний ping для вимірювання RTT. */
  start() {
    this.#connection.send('ready', { codec: this.#codec });
    this.#sendPing();
    clearInterval(this.#pingTimer);
    this.#pingTimer = setInterval(() => this.#sendPing(), PING_INTERVAL_MS);
  }

  destroy() {
    clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    for (const [type, handler] of this.#listeners) {
      this.#connection.removeEventListener(type, handler);
    }
    this.#listeners.length = 0;
  }

  setInterpolationDelay(ms) {
    this.#interpolationDelayMs = Math.max(0, Math.min(250, Number(ms) || 0));
  }

  setCodec(codec) {
    if (codec !== 'binary' && codec !== 'json') return;
    this.#codec = codec;
    if (this.#started) this.#connection.send('codec', { codec });
  }

  setNetsim(params) {
    this.#netsim = { ...this.#netsim, ...params };
    if (this.#connection.state === 'open') {
      this.#connection.send('netsim', this.#netsim);
    }
  }

  #sendPing() {
    if (this.#connection.state !== 'open') return;
    const t = this.#now();
    if (this.#codec === 'binary') {
      this.#connection.sendBinary(binaryCodec.encode({ type: MsgType.PING, clientTime: t }));
    } else {
      this.#connection.send('ping', { t });
    }
  }

  onStart(info) {
    this.#started = true;
    this.#localShipId = info.shipId;
    this.#arena = {
      width: info.arena?.width ?? ARENA_SIZE.width,
      height: info.arena?.height ?? ARENA_SIZE.height,
    };
    this.#world.setSize(this.#arena.width, this.#arena.height);
    if (!this.#world.hasPlayer(LOCAL_PLAYER_KEY)) {
      const entry = this.#world.addPlayer(LOCAL_PLAYER_KEY, {
        x: this.#arena.width / 2,
        y: this.#arena.height / 2,
      });
      entry.ship.id = this.#localShipId;
    }
    this.#estimatedServerTick = info.tick ?? 0;
    this.#lastServerTick = info.tick ?? 0;
    if (info.codec) this.#codec = info.codec;
    if (typeof info.netsimEnabled === 'boolean') this.#netsimEnabled = info.netsimEnabled;
    if (info.netsim) this.#netsim = { ...info.netsim };
    this.dispatchEvent(new CustomEvent('started', { detail: info }));
  }

  onPong(detail) {
    const sentAt = detail.clientTime ?? detail.t;
    if (typeof sentAt !== 'number') return;
    const sample = Math.max(0, this.#now() - sentAt);
    this.#rttMs = this.#rttMs === 0 ? sample : this.#rttMs * 0.7 + sample * 0.3;
    if (typeof detail.serverTick === 'number') {
      this.#estimatedServerTick = Math.max(
        this.#estimatedServerTick,
        detail.serverTick + Math.round(this.#rttMs / 2 / TICK_MS),
      );
    }
  }

  // --- Крок локального вводу + Client-Side Prediction (30 Гц) ---

  /**
   * Викликається з фіксованим кроком TICK_DT (1/30 с).
   * Миттєво прогнозує рух і постріли локального судна та відправляє команду на сервер.
   */
  stepInput(rawControls) {
    if (!this.#started) return;
    const controls = normalizeControls(rawControls);
    this.#seq += 1;
    this.#estimatedServerTick += 1;

    const prev = this.#recentControls.slice(0, Math.min(3, INPUT_LIMITS.maxHistory));
    this.#recentControls.unshift(controls);
    if (this.#recentControls.length > INPUT_LIMITS.maxHistory) this.#recentControls.pop();

    this.#pendingInputs.push({ seq: this.#seq, controls });
    if (this.#pendingInputs.length > MAX_PENDING_INPUTS) this.#pendingInputs.shift();

    // Миттєвий локальний прогноз руху й пострілу.
    const player = this.#world.getPlayer(LOCAL_PLAYER_KEY);
    if (player?.ship.alive) {
      player.ship.setControls(controls);
      if (controls.fire) {
        const bullet = player.ship.fire();
        if (bullet) {
          this.#predictedBullets.push({ bullet, seq: this.#seq });
          this.dispatchEvent(
            new CustomEvent('fired', { detail: { shooter: player.ship, bullet, missile: false } }),
          );
        }
      }
      if (controls.missile) {
        const missile = player.ship.fireMissile();
        if (missile) {
          this.#predictedBullets.push({ bullet: missile, seq: this.#seq });
          this.dispatchEvent(
            new CustomEvent('fired', {
              detail: { shooter: player.ship, bullet: missile, missile: true },
            }),
          );
        }
      }
      player.ship.update(TICK_DT);
      wrapEntity(player.ship, this.#arena.width, this.#arena.height);
    }

    // Оновлюємо локально спрогнозовані кулі.
    for (let i = this.#predictedBullets.length - 1; i >= 0; i -= 1) {
      const { bullet } = this.#predictedBullets[i];
      bullet.update(TICK_DT);
      wrapEntity(bullet, this.#arena.width, this.#arena.height);
      if (!bullet.alive) {
        this.#world.despawn(bullet.id);
        this.#predictedBullets.splice(i, 1);
      }
    }

    // Відправка команди на сервер.
    const message = {
      type: MsgType.INPUT,
      seq: this.#seq,
      tick: this.#estimatedServerTick,
      thrust: controls.thrust,
      turn: controls.turn,
      fire: controls.fire,
      missile: controls.missile,
      prev,
    };
    if (this.#connection.state === 'open') {
      if (this.#codec === 'binary') {
        this.#connection.sendBinary(binaryCodec.encode(message));
      } else {
        this.#connection.send('input', {
          seq: message.seq,
          tick: message.tick,
          thrust: message.thrust,
          turn: message.turn,
          fire: message.fire,
          missile: message.missile,
          prev: message.prev,
        });
      }
    }
  }

  // --- Отримання знімка + Server Reconciliation ---

  onSnapshot(snapshot, now = this.#now()) {
    // Ігноруємо застарілі знімки (якщо прийшли не по порядку).
    if (snapshot.tick < this.#lastServerTick) return;
    this.#lastServerTick = snapshot.tick;
    this.#lastSnapshotAt = now;
    this.#lastProcessedSeq = Math.max(this.#lastProcessedSeq, snapshot.lastProcessedSeq ?? 0);

    this.#snapshotBuffer.push({ receivedAt: now, snapshot });
    if (this.#snapshotBuffer.length > MAX_SNAPSHOT_BUFFER) this.#snapshotBuffer.shift();

    // Події вибухів -> локальні частинки й звук.
    for (const event of snapshot.events ?? []) {
      if (event.type !== 'explosion') continue;
      const isShip = event.kind === Kind.SHIP;
      this.#explosions.push(
        new Explosion({
          x: event.x,
          y: event.y,
          rng: this.#visualRng,
          count: isShip ? 42 : 6 + 5 * event.size,
          speed: isShip ? 240 : 40 + 35 * event.size,
          life: isShip ? 1.1 : 0.45 + 0.2 * event.size,
          tint: isShip ? 'ship' : 'rock',
        }),
      );
      this.dispatchEvent(new CustomEvent('exploded', { detail: event }));
    }

    // Прибираємо локальні кулі, чий seq вже підтверджено сервером (вони є в snapshot.bullets).
    this.#predictedBullets = this.#predictedBullets.filter((item) => {
      if (item.seq <= this.#lastProcessedSeq) {
        this.#world.despawn(item.bullet.id);
        return false;
      }
      return true;
    });

    // Server Reconciliation для власного судна.
    const serverShip = snapshot.ships.find((s) => s.id === this.#localShipId);
    const localPlayer = this.#world.getPlayer(LOCAL_PLAYER_KEY);
    if (!serverShip || !localPlayer) return;

    this.#score = serverShip.score ?? 0;
    this.#respawnIn = serverShip.alive ? 0 : (serverShip.respawnIn ?? 0);

    const ship = localPlayer.ship;
    const oldX = ship.pos.x + this.#smoothOffset.x;
    const oldY = ship.pos.y + this.#smoothOffset.y;
    const oldAngle = wrapAngle(ship.angle + this.#smoothOffset.angle);
    const wasAlive = ship.alive;

    // 1. Відкидаємо підтверджені сервером команди.
    this.#pendingInputs = this.#pendingInputs.filter((item) => item.seq > this.#lastProcessedSeq);

    // 2. Виставляємо авторитативний стан із сервера.
    this.#world.syncPlayerShip(LOCAL_PLAYER_KEY, shipStateFromNet(serverShip));

    // 3. Повторно програємо неподтверджені команди тією ж функцією з @dogfight/shared.
    if (ship.alive) {
      this.#world.muted = true;
      for (const item of this.#pendingInputs) {
        ship.setControls(item.controls);
        ship.update(TICK_DT);
        wrapEntity(ship, this.#arena.width, this.#arena.height);
      }
      this.#world.muted = false;
    }

    // 4. Обчислюємо похибку прогнозу й запускаємо плавне згладжування (~100 мс).
    if (!wasAlive || !ship.alive) {
      this.#correctionMag = 0;
      this.#smoothOffset = { x: 0, y: 0, angle: 0 };
      return;
    }
    const dx = wrappedDelta(ship.pos.x, oldX, this.#arena.width);
    const dy = wrappedDelta(ship.pos.y, oldY, this.#arena.height);
    const dAngle = shortestAngleDelta(ship.angle, oldAngle);
    this.#correctionMag = Math.hypot(dx, dy);

    if (this.#correctionMag > SNAP_THRESHOLD_PX) {
      this.#smoothOffset = { x: 0, y: 0, angle: 0 };
    } else {
      this.#smoothOffset = { x: dx, y: dy, angle: dAngle };
    }
  }

  // --- Entity Interpolation + збірка стану для рендера ---

  /**
   * Повертає легкий об'єкт, сумісний із `drawFrame()`:
   *  - локальне судно: прогноз + плавне згладжування коррекції;
   *  - чужі судна, астероїди, серверні кулі, бонуси: інтерполяція в минулому (now - interpolationDelay);
   *  - непідтверджені локальні кулі: миттєвий локальний прогноз.
   */
  buildRenderWorld(alpha, dtFrame, now = this.#now()) {
    // Плавне згасання візуальної похибки за ~100 мс.
    const decay = Math.exp(-Math.max(0, dtFrame) / SMOOTH_TAU_SEC);
    this.#smoothOffset.x *= decay;
    this.#smoothOffset.y *= decay;
    this.#smoothOffset.angle *= decay;
    if (Math.hypot(this.#smoothOffset.x, this.#smoothOffset.y) < 0.05) {
      this.#smoothOffset.x = 0;
      this.#smoothOffset.y = 0;
    }
    if (Math.abs(this.#smoothOffset.angle) < 0.0005) this.#smoothOffset.angle = 0;

    // Оновлення локальних частинок вибухів.
    for (let i = this.#explosions.length - 1; i >= 0; i -= 1) {
      this.#explosions[i].update(Math.min(dtFrame, 0.05));
      if (!this.#explosions[i].alive) this.#explosions.splice(i, 1);
    }

    const byKind = {
      [Kind.SHIP]: [],
      [Kind.ASTEROID]: [],
      [Kind.BULLET]: [],
      [Kind.PICKUP]: [],
      [Kind.EXPLOSION]: this.#explosions,
    };

    // Локальне судно (Client-Side Prediction).
    let localShipView = null;
    const localPlayer = this.#world.getPlayer(LOCAL_PLAYER_KEY);
    if (localPlayer) {
      const ship = localPlayer.ship;
      const x = wrapCoord(
        lerp(ship.prevPos.x, ship.pos.x, alpha) + this.#smoothOffset.x,
        this.#arena.width,
      );
      const y = wrapCoord(
        lerp(ship.prevPos.y, ship.pos.y, alpha) + this.#smoothOffset.y,
        this.#arena.height,
      );
      const angle = wrapAngle(
        lerpAngle(ship.prevAngle, ship.angle, alpha) + this.#smoothOffset.angle,
      );
      const pos = { x, y };
      localShipView = {
        id: ship.id,
        kind: Kind.SHIP,
        pos,
        prevPos: pos,
        angle,
        prevAngle: angle,
        radius: ship.radius,
        alive: ship.alive,
        hp: ship.hp,
        thrust: ship.thrust,
        invulnerable: ship.invulnerable,
        hasBuff: (name) => ship.hasBuff(name),
        activeBuffs: () => ship.activeBuffs(),
      };
      if (ship.alive) byKind[Kind.SHIP].push(localShipView);
    }

    // Локально спрогнозовані кулі (ще не підтверджені сервером).
    for (const { bullet } of this.#predictedBullets) {
      if (!bullet.alive) continue;
      const pos = {
        x: wrapCoord(lerp(bullet.prevPos.x, bullet.pos.x, alpha), this.#arena.width),
        y: wrapCoord(lerp(bullet.prevPos.y, bullet.pos.y, alpha), this.#arena.height),
      };
      byKind[Kind.BULLET].push({
        id: bullet.id,
        kind: Kind.BULLET,
        pos,
        prevPos: pos,
        angle: bullet.angle,
        prevAngle: bullet.angle,
        radius: bullet.radius,
        alive: true,
        owner: bullet.owner,
        components: bullet.components,
      });
    }

    // Entity Interpolation для всіх серверних сутностей (у минулому: now - interpolationDelay).
    this.#interpolateEntities(now - this.#interpolationDelayMs, byKind);

    this.#sampleMetrics(now);

    return {
      width: this.#arena.width,
      height: this.#arena.height,
      player: localShipView,
      score: this.#score,
      respawnIn: this.#respawnIn,
      ofKind: (kind) => byKind[kind] ?? [],
    };
  }

  #interpolateEntities(renderTime, byKind) {
    const buf = this.#snapshotBuffer;
    if (buf.length === 0) return;

    const { width, height } = this.#arena;
    let prev = buf[0];
    let next = buf[buf.length - 1];

    if (renderTime <= prev.receivedAt) {
      next = prev;
    } else if (renderTime >= next.receivedAt) {
      prev = next;
    } else {
      for (let i = buf.length - 1; i >= 1; i -= 1) {
        if (buf[i - 1].receivedAt <= renderTime && renderTime <= buf[i].receivedAt) {
          prev = buf[i - 1];
          next = buf[i];
          break;
        }
      }
    }

    const span = next.receivedAt - prev.receivedAt;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - prev.receivedAt) / span)) : 1;
    // Якщо затримка інтерполяції 0 або буфер порожній на поточний час - легка екстраполяція.
    const extraSec =
      prev === next
        ? Math.min(MAX_EXTRAPOLATION_SEC, Math.max(0, (renderTime - next.receivedAt) / 1000))
        : 0;

    const indexById = (list) => new Map(list.map((item) => [item.id, item]));
    const prevShips = indexById(prev.snapshot.ships);
    const prevAsteroids = indexById(prev.snapshot.asteroids);
    const prevBullets = indexById(prev.snapshot.bullets);

    // Чужі судна.
    for (const ship of next.snapshot.ships) {
      if (ship.id === this.#localShipId || !ship.alive) continue;
      const before = prevShips.get(ship.id);
      const pos = before
        ? interpolatePos(before, ship, t, width, height)
        : {
            x: wrapCoord(ship.x + ship.vx * extraSec, width),
            y: wrapCoord(ship.y + ship.vy * extraSec, height),
          };
      const angle = before ? lerpAngle(before.angle, ship.angle, t) : ship.angle;
      byKind[Kind.SHIP].push(makeShipView(ship, pos, angle));
    }

    // Астероїди.
    for (const asteroid of next.snapshot.asteroids) {
      const before = prevAsteroids.get(asteroid.id);
      const pos = before
        ? interpolatePos(before, asteroid, t, width, height)
        : {
            x: wrapCoord(asteroid.x + asteroid.vx * extraSec, width),
            y: wrapCoord(asteroid.y + asteroid.vy * extraSec, height),
          };
      const angle = before ? lerpAngle(before.angle, asteroid.angle, t) : asteroid.angle;
      byKind[Kind.ASTEROID].push(makeAsteroidView(asteroid, pos, angle));
    }

    // Серверні кулі.
    for (const bullet of next.snapshot.bullets) {
      const before = prevBullets.get(bullet.id);
      const pos = before
        ? interpolatePos(before, bullet, t, width, height)
        : {
            x: wrapCoord(bullet.x + bullet.vx * extraSec, width),
            y: wrapCoord(bullet.y + bullet.vy * extraSec, height),
          };
      const angle = Math.atan2(bullet.vy, bullet.vx);
      byKind[Kind.BULLET].push(makeBulletView(bullet, pos, angle));
    }

    // Бонуси (статичні).
    for (const pickup of next.snapshot.pickups) {
      byKind[Kind.PICKUP].push(makePickupView(pickup));
    }
  }

  // --- Метрики для Netgraph ---

  #sampleMetrics(now) {
    const bytesIn = this.#connection.bytesIn ?? 0;
    const bytesOut = this.#connection.bytesOut ?? 0;
    this.#bwSamples.push({ t: now, bytesIn, bytesOut });
    while (this.#bwSamples.length > 2 && now - this.#bwSamples[0].t > 1000) {
      this.#bwSamples.shift();
    }
    const oldest = this.#bwSamples[0];
    const dtSec = Math.max(0.1, (now - oldest.t) / 1000);
    this.#kbInPerSec = (bytesIn - oldest.bytesIn) / 1024 / dtSec;
    this.#kbOutPerSec = (bytesOut - oldest.bytesOut) / 1024 / dtSec;

    if (now - this.#lastHistoryAt >= 66) {
      this.#lastHistoryAt = now;
      this.#history.push({
        rttMs: this.#rttMs,
        correctionMag: this.#correctionMag,
        snapshotAgeMs: this.#lastSnapshotAt === null ? 0 : now - this.#lastSnapshotAt,
      });
      if (this.#history.length > HISTORY_LENGTH) this.#history.shift();
    }
  }

  getMetrics(now = this.#now()) {
    return {
      online: true,
      rttMs: this.#rttMs,
      snapshotAgeMs: this.#lastSnapshotAt === null ? 0 : Math.max(0, now - this.#lastSnapshotAt),
      kbInPerSec: this.#kbInPerSec,
      kbOutPerSec: this.#kbOutPerSec,
      pendingInputs: this.#pendingInputs.length,
      correctionMag: this.#correctionMag,
      tick: this.#lastServerTick,
      codec: this.#codec,
      interpolationDelayMs: this.#interpolationDelayMs,
      netsimEnabled: this.#netsimEnabled,
      netsim: { ...this.#netsim },
      history: this.#history,
    };
  }
}
