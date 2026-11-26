/**
 * Клієнтський Netcode: Client-Side Prediction, Server Reconciliation, Entity Interpolation,
 * локальне прогнозування куль і збір метрик для Netgraph.
 */

import {
  ARENA_SIZE,
  asEntityId,
  asSeq,
  ASTEROID_SIZES,
  asTick,
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
  ServerSnapshotSchema,
  SHIP_PARAMS,
  shipStateFromNet,
  shortestAngleDelta,
  TICK_DT,
  TICK_MS,
  World,
  wrapAngle,
  wrapEntity,
  wrappedDelta,
  type AsteroidSize,
  type Bullet,
  type CodecNameValue,
  type Controls,
  type EntityId,
  type EntityKind,
  type InputMessage,
  type NetAsteroid,
  type NetBullet,
  type NetPickup,
  type NetShip,
  type NetsimState,
  type RawControlsInput,
  type Seq,
  type SnapshotMessage,
  type Tick,
  type Vec2Like,
} from '@dogfight/shared';
import type { RenderableEntity, RenderWorld, ShipView } from '../render/draw.ts';
import { Bus, type GameEvents } from '../util/bus.ts';

const LOCAL_PLAYER_KEY = 'self';
const FIRST_PREDICTED_ID = 1_000_000;
const MAX_SNAPSHOT_BUFFER = 45;
const MAX_PENDING_INPUTS = 120;
const SNAP_THRESHOLD_PX = 160;
const SMOOTH_TAU_SEC = 0.045;
const MAX_EXTRAPOLATION_SEC = 0.1;
const PING_INTERVAL_MS = 500;
const HISTORY_LENGTH = 90;

export interface NetConnectionLike {
  readonly state: string;
  readonly bytesIn: number;
  readonly bytesOut: number;
  send(type: string, payload?: Record<string, unknown>): unknown;
  sendBinary(buffer: ArrayBuffer | ArrayBufferView<ArrayBuffer>): unknown;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface NetHistorySample {
  readonly rttMs: number;
  readonly correctionMag: number;
  readonly snapshotAgeMs: number;
}

export interface NetMetrics {
  readonly online: boolean;
  readonly rttMs: number;
  readonly snapshotAgeMs: number;
  readonly kbInPerSec: number;
  readonly kbOutPerSec: number;
  readonly pendingInputs: number;
  readonly correctionMag: number;
  readonly tick: Tick;
  readonly codec: CodecNameValue;
  readonly interpolationDelayMs: number;
  readonly netsimEnabled: boolean;
  readonly netsim: NetsimState;
  readonly history: readonly NetHistorySample[];
}

export interface StartInfo {
  readonly shipId: EntityId | number;
  readonly tickRate: number;
  readonly tick: Tick | number;
  readonly arena?: { readonly width: number; readonly height: number };
  readonly seed?: number;
  readonly codec?: CodecNameValue;
  readonly netsimEnabled?: boolean;
  readonly netsim?: NetsimState;
}

function wrapCoord(value: number, size: number): number {
  if (size <= 0) return value;
  return ((value % size) + size) % size;
}

function interpolatePos(
  prev: Vec2Like,
  next: Vec2Like,
  t: number,
  width: number,
  height: number,
): Vec2Like {
  const dx = wrappedDelta(prev.x, next.x, width);
  const dy = wrappedDelta(prev.y, next.y, height);
  return {
    x: wrapCoord(prev.x + dx * t, width),
    y: wrapCoord(prev.y + dy * t, height),
  };
}

function makeShipView(record: NetShip, pos: Vec2Like, angle: number): ShipView {
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
    hasBuff: (name: string) => name === 'rapid' && record.rapid,
    *activeBuffs() {
      if (record.rapid && record.rapidLeft > 0) yield ['rapid', record.rapidLeft] as const;
    },
  };
}

function makeAsteroidView(record: NetAsteroid, pos: Vec2Like, angle: number): RenderableEntity {
  const size: AsteroidSize = record.size;
  const cfg = ASTEROID_SIZES[size];
  return {
    id: record.id,
    kind: Kind.ASTEROID,
    pos,
    prevPos: pos,
    angle,
    prevAngle: angle,
    radius: cfg.radius,
    size,
    alive: true,
    components: record.hunter ? { homing: { turnRate: 0, range: 0, targetKinds: [] } } : {},
  };
}

function makeBulletView(record: NetBullet, pos: Vec2Like, angle: number): RenderableEntity {
  return {
    id: record.id,
    kind: Kind.BULLET,
    pos,
    prevPos: pos,
    angle,
    prevAngle: angle,
    radius: 3,
    alive: true,
    components: record.missile ? { homing: { turnRate: 0, range: 0, targetKinds: [] } } : {},
  };
}

function makePickupView(record: NetPickup): RenderableEntity {
  const effect = PICKUP_EFFECTS[record.effect];
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
  readonly bus = new Bus<GameEvents>();

  #connection: NetConnectionLike;
  #now: () => number;
  #world: World;
  #visualRng = createRng(0x5a17);
  #explosions: Explosion[] = [];
  #arena: { width: number; height: number } = {
    width: ARENA_SIZE.width,
    height: ARENA_SIZE.height,
  };
  #localShipId: EntityId | null = null;
  #score = 0;
  #respawnIn = 0;
  #codec: CodecNameValue = 'binary';
  #netsimEnabled = true;
  #netsim: NetsimState = { latency: 0, jitter: 0, drop: 0 };
  #interpolationDelayMs = 80;

  #seq: Seq = asSeq(0);
  #estimatedServerTick: Tick = asTick(0);
  #lastProcessedSeq: Seq = asSeq(0);
  #recentControls: Controls[] = [];
  #pendingInputs: Array<{ readonly seq: Seq; readonly controls: Controls }> = [];
  #predictedBullets: Array<{ readonly bullet: Bullet; readonly seq: Seq }> = [];
  #smoothOffset = { x: 0, y: 0, angle: 0 };

  #snapshotBuffer: Array<{ readonly receivedAt: number; readonly snapshot: SnapshotMessage }> = [];
  #lastSnapshotAt: number | null = null;
  #lastServerTick: Tick = asTick(0);
  #started = false;

  #rttMs = 0;
  #correctionMag = 0;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #bwSamples: Array<{ readonly t: number; readonly bytesIn: number; readonly bytesOut: number }> =
    [];
  #kbInPerSec = 0;
  #kbOutPerSec = 0;
  #history: NetHistorySample[] = [];
  #lastHistoryAt = 0;
  #listeners: Array<readonly [string, EventListener]> = [];

  constructor({
    connection,
    codec = 'binary',
    interpolationDelayMs = 80,
    now = () => performance.now(),
  }: {
    readonly connection: NetConnectionLike;
    readonly codec?: CodecNameValue;
    readonly interpolationDelayMs?: number;
    readonly now?: () => number;
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

  get started(): boolean {
    return this.#started;
  }

  get codec(): CodecNameValue {
    return this.#codec;
  }

  get interpolationDelayMs(): number {
    return this.#interpolationDelayMs;
  }

  get netsimEnabled(): boolean {
    return this.#netsimEnabled;
  }

  get netsim(): NetsimState {
    return { ...this.#netsim };
  }

  get localShipId(): EntityId | null {
    return this.#localShipId;
  }

  get pendingCount(): number {
    return this.#pendingInputs.length;
  }

  #bindConnection(): void {
    const on = (type: string, handler: (detail: unknown) => void): void => {
      const listener: EventListener = (event) => {
        if (event instanceof CustomEvent) handler(event.detail);
      };
      this.#connection.addEventListener(type, listener);
      this.#listeners.push([type, listener]);
    };
    on('start', (detail) => {
      if (!detail || typeof detail !== 'object') return;
      const d: Record<string, unknown> = { ...detail };
      if (typeof d.shipId !== 'number' || typeof d.tickRate !== 'number') return;
      const rawArena = d.arena && typeof d.arena === 'object' ? { ...d.arena } : null;
      const arena =
        rawArena &&
        'width' in rawArena &&
        'height' in rawArena &&
        typeof rawArena.width === 'number' &&
        typeof rawArena.height === 'number'
          ? { width: rawArena.width, height: rawArena.height }
          : undefined;
      const rawNs = d.netsim && typeof d.netsim === 'object' ? { ...d.netsim } : null;
      const netsim =
        rawNs &&
        'latency' in rawNs &&
        'jitter' in rawNs &&
        'drop' in rawNs &&
        typeof rawNs.latency === 'number' &&
        typeof rawNs.jitter === 'number' &&
        typeof rawNs.drop === 'number'
          ? { latency: rawNs.latency, jitter: rawNs.jitter, drop: rawNs.drop }
          : undefined;
      this.onStart({
        shipId: d.shipId,
        tickRate: d.tickRate,
        tick: typeof d.tick === 'number' ? d.tick : 0,
        arena,
        seed: typeof d.seed === 'number' ? d.seed : undefined,
        codec: d.codec === 'binary' || d.codec === 'json' ? d.codec : undefined,
        netsimEnabled: typeof d.netsimEnabled === 'boolean' ? d.netsimEnabled : undefined,
        netsim,
      });
    });
    on('snapshot', (detail) => {
      const parsed = ServerSnapshotSchema.safeParse(detail);
      if (parsed.success) this.onSnapshot(parsed.data);
    });
    on('pong', (detail) => {
      if (detail && typeof detail === 'object') {
        const d: Record<string, unknown> = { ...detail };
        this.onPong({
          clientTime: typeof d.clientTime === 'number' ? d.clientTime : undefined,
          t: typeof d.t === 'number' ? d.t : undefined,
          serverTick: typeof d.serverTick === 'number' ? d.serverTick : undefined,
        });
      }
    });
    on('netsim', (detail) => {
      if (detail && typeof detail === 'object') {
        const d: Record<string, unknown> = { ...detail };
        if (
          typeof d.latency === 'number' &&
          typeof d.jitter === 'number' &&
          typeof d.drop === 'number'
        ) {
          this.#netsim = { latency: d.latency, jitter: d.jitter, drop: d.drop };
          this.dispatchEvent(new CustomEvent('netsim', { detail: this.netsim }));
        }
      }
    });
  }

  start(): void {
    this.#connection.send('ready', { codec: this.#codec });
    this.#sendPing();
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    this.#pingTimer = setInterval(() => this.#sendPing(), PING_INTERVAL_MS);
  }

  destroy(): void {
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    for (const [type, listener] of this.#listeners) {
      this.#connection.removeEventListener(type, listener);
    }
    this.#listeners.length = 0;
    this.bus.clear();
  }

  setInterpolationDelay(ms: number): void {
    this.#interpolationDelayMs = Math.max(0, Math.min(250, Number(ms) || 0));
  }

  setCodec(codec: CodecNameValue): void {
    this.#codec = codec;
    if (this.#started) this.#connection.send('codec', { codec });
  }

  setNetsim(params: Partial<NetsimState>): void {
    this.#netsim = { ...this.#netsim, ...params };
    if (this.#connection.state === 'open') {
      this.#connection.send('netsim', { ...this.#netsim });
    }
  }

  #sendPing(): void {
    if (this.#connection.state !== 'open') return;
    const t = this.#now();
    if (this.#codec === 'binary') {
      this.#connection.sendBinary(binaryCodec.encode({ type: MsgType.PING, clientTime: t }));
    } else {
      this.#connection.send('ping', { t });
    }
  }

  onStart(info: StartInfo): void {
    this.#started = true;
    this.#localShipId = asEntityId(info.shipId);
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
    this.#estimatedServerTick = asTick(info.tick ?? 0);
    this.#lastServerTick = asTick(info.tick ?? 0);
    if (info.codec) this.#codec = info.codec;
    if (typeof info.netsimEnabled === 'boolean') this.#netsimEnabled = info.netsimEnabled;
    if (info.netsim) this.#netsim = { ...info.netsim };
    this.dispatchEvent(new CustomEvent('started', { detail: info }));
  }

  onPong(detail: {
    readonly clientTime?: number;
    readonly t?: number;
    readonly serverTick?: number;
  }): void {
    const sentAt = detail.clientTime ?? detail.t;
    if (typeof sentAt !== 'number') return;
    const sample = Math.max(0, this.#now() - sentAt);
    this.#rttMs = this.#rttMs === 0 ? sample : this.#rttMs * 0.7 + sample * 0.3;
    if (typeof detail.serverTick === 'number') {
      this.#estimatedServerTick = asTick(
        Math.max(
          this.#estimatedServerTick,
          detail.serverTick + Math.round(this.#rttMs / 2 / TICK_MS),
        ),
      );
    }
  }

  stepInput(rawControls: RawControlsInput): void {
    if (!this.#started) return;
    const controls = normalizeControls(rawControls);
    this.#seq = asSeq(this.#seq + 1);
    this.#estimatedServerTick = asTick(this.#estimatedServerTick + 1);

    const prev = this.#recentControls.slice(0, Math.min(3, INPUT_LIMITS.maxHistory));
    this.#recentControls.unshift(controls);
    if (this.#recentControls.length > INPUT_LIMITS.maxHistory) this.#recentControls.pop();

    this.#pendingInputs.push({ seq: this.#seq, controls });
    if (this.#pendingInputs.length > MAX_PENDING_INPUTS) this.#pendingInputs.shift();

    const player = this.#world.getPlayer(LOCAL_PLAYER_KEY);
    if (player?.ship.alive) {
      player.ship.setControls(controls);
      if (controls.fire) {
        const bullet = player.ship.fire();
        if (bullet) {
          this.#predictedBullets.push({ bullet, seq: this.#seq });
          this.bus.emit('fired', { missile: false });
        }
      }
      if (controls.missile) {
        const missile = player.ship.fireMissile();
        if (missile) {
          this.#predictedBullets.push({ bullet: missile, seq: this.#seq });
          this.bus.emit('fired', { missile: true });
        }
      }
      player.ship.update(TICK_DT);
      wrapEntity(player.ship, this.#arena.width, this.#arena.height);
    }

    for (let i = this.#predictedBullets.length - 1; i >= 0; i -= 1) {
      const item = this.#predictedBullets[i];
      if (!item) continue;
      item.bullet.update(TICK_DT);
      wrapEntity(item.bullet, this.#arena.width, this.#arena.height);
      if (!item.bullet.alive) {
        this.#world.despawn(item.bullet.id);
        this.#predictedBullets.splice(i, 1);
      }
    }

    const message: InputMessage = {
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

  onSnapshot(snapshot: SnapshotMessage, now = this.#now()): void {
    if (snapshot.tick < this.#lastServerTick) return;
    this.#lastServerTick = asTick(snapshot.tick);
    this.#lastSnapshotAt = now;
    this.#lastProcessedSeq = asSeq(
      Math.max(this.#lastProcessedSeq, snapshot.lastProcessedSeq ?? 0),
    );

    this.#snapshotBuffer.push({ receivedAt: now, snapshot });
    if (this.#snapshotBuffer.length > MAX_SNAPSHOT_BUFFER) this.#snapshotBuffer.shift();

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
      this.bus.emit('exploded', event);
    }

    this.#predictedBullets = this.#predictedBullets.filter((item) => {
      if (item.seq <= this.#lastProcessedSeq) {
        this.#world.despawn(item.bullet.id);
        return false;
      }
      return true;
    });

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

    this.#pendingInputs = this.#pendingInputs.filter((item) => item.seq > this.#lastProcessedSeq);
    this.#world.syncPlayerShip(LOCAL_PLAYER_KEY, shipStateFromNet(serverShip));

    if (ship.alive) {
      this.#world.muted = true;
      for (const item of this.#pendingInputs) {
        ship.setControls(item.controls);
        ship.update(TICK_DT);
        wrapEntity(ship, this.#arena.width, this.#arena.height);
      }
      this.#world.muted = false;
    }

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

  buildRenderWorld(alpha: number, dtFrame: number, now = this.#now()): RenderWorld {
    const decay = Math.exp(-Math.max(0, dtFrame) / SMOOTH_TAU_SEC);
    this.#smoothOffset.x *= decay;
    this.#smoothOffset.y *= decay;
    this.#smoothOffset.angle *= decay;
    if (Math.hypot(this.#smoothOffset.x, this.#smoothOffset.y) < 0.05) {
      this.#smoothOffset.x = 0;
      this.#smoothOffset.y = 0;
    }
    if (Math.abs(this.#smoothOffset.angle) < 0.0005) this.#smoothOffset.angle = 0;

    for (let i = this.#explosions.length - 1; i >= 0; i -= 1) {
      const exp = this.#explosions[i];
      if (!exp) continue;
      exp.update(Math.min(dtFrame, 0.05));
      if (!exp.alive) this.#explosions.splice(i, 1);
    }

    const byKind: Record<EntityKind, RenderableEntity[]> = {
      [Kind.SHIP]: [],
      [Kind.ASTEROID]: [],
      [Kind.BULLET]: [],
      [Kind.PICKUP]: [],
      [Kind.EXPLOSION]: this.#explosions,
    };

    let localShipView: ShipView | null = null;
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
        hasBuff: (name: string) => ship.hasBuff(name),
        activeBuffs: () => ship.activeBuffs(),
      };
      if (ship.alive) byKind[Kind.SHIP].push(localShipView);
    }

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
        components: bullet.components,
      });
    }

    this.#interpolateEntities(now - this.#interpolationDelayMs, byKind);
    this.#sampleMetrics(now);

    return {
      width: this.#arena.width,
      height: this.#arena.height,
      player: localShipView,
      score: this.#score,
      respawnIn: this.#respawnIn,
      ofKind: (kind: EntityKind) => byKind[kind],
    };
  }

  #interpolateEntities(renderTime: number, byKind: Record<EntityKind, RenderableEntity[]>): void {
    const buf = this.#snapshotBuffer;
    const first = buf[0];
    const last = buf[buf.length - 1];
    if (!first || !last) return;

    const { width, height } = this.#arena;
    let prev = first;
    let next = last;

    if (renderTime <= prev.receivedAt) {
      next = prev;
    } else if (renderTime >= next.receivedAt) {
      prev = next;
    } else {
      for (let i = buf.length - 1; i >= 1; i -= 1) {
        const a = buf[i - 1];
        const b = buf[i];
        if (a && b && a.receivedAt <= renderTime && renderTime <= b.receivedAt) {
          prev = a;
          next = b;
          break;
        }
      }
    }

    const span = next.receivedAt - prev.receivedAt;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - prev.receivedAt) / span)) : 1;
    const extraSec =
      prev === next
        ? Math.min(MAX_EXTRAPOLATION_SEC, Math.max(0, (renderTime - next.receivedAt) / 1000))
        : 0;

    const prevShips = new Map(prev.snapshot.ships.map((item) => [item.id, item]));
    const prevAsteroids = new Map(prev.snapshot.asteroids.map((item) => [item.id, item]));
    const prevBullets = new Map(prev.snapshot.bullets.map((item) => [item.id, item]));

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

    for (const pickup of next.snapshot.pickups) {
      byKind[Kind.PICKUP].push(makePickupView(pickup));
    }
  }

  #sampleMetrics(now: number): void {
    const bytesIn = this.#connection.bytesIn ?? 0;
    const bytesOut = this.#connection.bytesOut ?? 0;
    this.#bwSamples.push({ t: now, bytesIn, bytesOut });
    while (this.#bwSamples.length > 2) {
      const head = this.#bwSamples[0];
      if (!head || now - head.t <= 1000) break;
      this.#bwSamples.shift();
    }
    const oldest = this.#bwSamples[0];
    if (oldest) {
      const dtSec = Math.max(0.1, (now - oldest.t) / 1000);
      this.#kbInPerSec = (bytesIn - oldest.bytesIn) / 1024 / dtSec;
      this.#kbOutPerSec = (bytesOut - oldest.bytesOut) / 1024 / dtSec;
    }

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

  getMetrics(now = this.#now()): NetMetrics {
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
