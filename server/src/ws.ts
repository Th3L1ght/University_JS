/**
 * WebSocket-шар на бібліотеці ws, прив'язаний до HTTP-сервера (шлях /ws).
 * Використовує єдиний Zod-протокол і бінарний кодек із @dogfight/shared.
 */

import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import {
  asTick,
  assertNever,
  binaryCodec,
  CloseCode,
  encodeServerMessage,
  MsgType,
  parseClientMessage,
  type ClientMessage,
  type CloseCodeValue,
  type PlayerSummary,
  type ServerMessage,
} from '@dogfight/shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { ServerConfig } from './config.ts';
import type { Logger } from './logger.ts';
import type { Match, MatchManager } from './match.ts';
import type { MetricsCollector, RejectionReason } from './metrics.ts';
import { NetSim, parseNetsimParams } from './netsim.ts';
import { TokenBucket } from './rate_limit.ts';
import { RoomError, type Room, type RoomManager } from './rooms.ts';

const MAX_DROPPED_BEFORE_DISCONNECT = 100;
const HARD_BUFFER_FACTOR = 4;
const MAX_BAD_INPUTS = 30;

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isInputFrame(data: Buffer): boolean {
  return data.subarray(0, 24).toString('utf8').startsWith('{"v":1,"type":"input"');
}

export interface SendableConn {
  readonly socket: {
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string | ArrayBuffer | Buffer, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
  };
  dropped: number;
}

export interface SendOptions {
  readonly maxBufferedBytes: number;
  readonly logger: Logger;
  readonly stats?: { dropped: number };
  readonly metrics?: MetricsCollector;
}

export function safeSend(
  conn: SendableConn,
  message: ServerMessage,
  options: SendOptions,
): 'sent' | 'dropped' | 'closed' {
  return deliver(conn, encodeServerMessage(message), options);
}

export function deliver(
  conn: SendableConn,
  data: string | ArrayBuffer | Buffer,
  { maxBufferedBytes, logger, stats, metrics }: SendOptions,
): 'sent' | 'dropped' | 'closed' {
  const { socket } = conn;
  if (socket.readyState !== WebSocket.OPEN) return 'closed';

  if (socket.bufferedAmount > maxBufferedBytes * HARD_BUFFER_FACTOR) {
    logger.warn('ws.rejected', {
      reason: 'slow_consumer_hard',
      bufferedAmount: socket.bufferedAmount,
    });
    socket.terminate();
    return 'closed';
  }
  if (socket.bufferedAmount > maxBufferedBytes) {
    conn.dropped += 1;
    if (stats) stats.dropped += 1;
    if (conn.dropped >= MAX_DROPPED_BEFORE_DISCONNECT) {
      logger.warn('ws.rejected', { reason: 'slow_consumer', dropped: conn.dropped });
      socket.close(CloseCode.SLOW_CONSUMER, 'slow consumer');
      return 'closed';
    }
    return 'dropped';
  }

  const outBytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  metrics?.recordMessage('out', outBytes);
  socket.send(data, (error) => {
    if (error) logger.warn('ws.send_error', { error: error.message });
  });
  return 'sent';
}

interface ClientConn {
  readonly id: string;
  readonly ip: string | undefined;
  readonly socket: WebSocket;
  joined: boolean;
  room: Room | null;
  player: PlayerSummary | null;
  dropped: number;
  awaitingPong: boolean;
  missedPongs: number;
  readonly bucket: TokenBucket;
  authTimer: ReturnType<typeof setTimeout> | null;
  inMatch: boolean;
  match: Match | null;
  badInputs: number;
  readonly netsim: NetSim;
  readonly inputBucket: TokenBucket;
}

export interface WsServerHandle {
  readonly wss: WebSocketServer;
  readonly connections: Set<ClientConn>;
  readonly stats: {
    accepted: number;
    rejected: number;
    dropped: number;
    violations: number;
    rejectedInputs: number;
  };
  close(options?: { readonly timeoutMs?: number }): Promise<void>;
}

function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
  nodeEnv: ServerConfig['nodeEnv'],
): boolean {
  // Порожній Origin (headless ws-клієнти, тести, локальний dev) дозволено, якщо список не заданий жорстко.
  if (!origin) return allowedOrigins.length === 0 || nodeEnv !== 'production';
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  // За замовчуванням дозволяємо localhost / 127.0.0.1.
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

export function attachWebSocketServer({
  server,
  rooms,
  matches,
  config,
  logger,
  metrics,
}: {
  readonly server: http.Server;
  readonly rooms: RoomManager;
  readonly matches: MatchManager;
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly metrics?: MetricsCollector;
}): WsServerHandle {
  const { ws: wsConfig, limits } = config;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: wsConfig.maxPayload });
  const connections = new Set<ClientConn>();
  const byRoom = new Map<string, Set<ClientConn>>();
  const byIp = new Map<string, number>();
  const stats = { accepted: 0, rejected: 0, dropped: 0, violations: 0, rejectedInputs: 0 };
  const sendOptions: SendOptions = {
    maxBufferedBytes: wsConfig.maxBufferedBytes,
    logger,
    stats,
    metrics,
  };

  const send = (conn: ClientConn, message: ServerMessage) => safeSend(conn, message, sendOptions);
  const broadcast = (roomId: string, message: ServerMessage) => {
    for (const conn of byRoom.get(roomId) ?? []) send(conn, message);
  };
  const sendError = (conn: ClientConn, code: string, message: string) =>
    send(conn, { type: 'error', code, message });
  const sendGame = (conn: ClientConn, frame: ArrayBuffer | string) =>
    conn.netsim.schedule('out', () => deliver(conn, frame, sendOptions));

  rooms.on('created', (room) => {
    byRoom.set(room.id, new Set());
    const rosterMsg = (): ServerMessage => ({
      type: 'roster',
      room: room.id,
      players: room.roster(),
    });
    room.on('join', () => broadcast(room.id, rosterMsg()));
    room.on('leave', () => broadcast(room.id, rosterMsg()));
    room.on('chat', (message) => broadcast(room.id, { type: 'chat', room: room.id, ...message }));
  });
  rooms.on('removed', (room) => byRoom.delete(room.id));

  function violate(
    conn: ClientConn,
    closeCode: CloseCodeValue,
    code: string,
    reason: string,
    metricReason: RejectionReason = 'invalid_payload',
  ): void {
    stats.violations += 1;
    metrics?.recordRejection(metricReason);
    logger.warn('ws.rejected', {
      conn: conn.id,
      roomId: conn.room?.id,
      playerId: conn.player?.id,
      code,
      reason,
      closeCode,
    });
    sendError(conn, code, reason);
    conn.socket.close(closeCode, code);
  }

  function leaveMatch(conn: ClientConn): void {
    if (!conn.inMatch || !conn.match || !conn.player) return;
    conn.inMatch = false;
    const { match } = conn;
    conn.match = null;
    match.removePlayer(conn.player.id);
    if (match.playerCount === 0) matches.remove(match.roomId);
  }

  function leaveRoom(conn: ClientConn): void {
    if (!conn.joined || !conn.room || !conn.player) return;
    const roomId = conn.room.id;
    const playerId = conn.player.id;
    leaveMatch(conn);
    conn.joined = false;
    byRoom.get(roomId)?.delete(conn);
    conn.room.leave(playerId);
    logger.info('player.left', { roomId, playerId });
  }

  function handleInput(
    conn: ClientConn,
    message: {
      readonly seq: number;
      readonly tick: number;
      readonly thrust: boolean;
      readonly turn: number;
      readonly fire: boolean;
      readonly missile?: boolean;
      readonly prev?: readonly {
        readonly thrust?: boolean;
        readonly turn?: number;
        readonly fire?: boolean;
        readonly missile?: boolean;
      }[];
    },
    bytes: number,
  ): void {
    if (!conn.inMatch || !conn.match || !conn.player) return;
    const result = conn.match.submitInput(conn.player.id, message, { bytes });
    if (result.rejected === 0) return;
    stats.rejectedInputs += result.rejected;
    conn.badInputs += result.rejected;
    if (conn.badInputs >= MAX_BAD_INPUTS) {
      violate(
        conn,
        CloseCode.POLICY_VIOLATION,
        'cheat_suspected',
        `некоректний ввід: ${result.reason ?? 'invalid'}`,
      );
    }
  }

  function dispatchClientMessage(conn: ClientConn, message: ClientMessage): void {
    switch (message.type) {
      case 'join': {
        if (conn.joined) {
          sendError(conn, 'already_joined', 'ви вже перебуваєте в кімнаті');
          return;
        }
        const room = rooms.get(message.room);
        if (!room) {
          sendError(conn, 'room_not_found', 'кімнату не знайдено');
          conn.socket.close(CloseCode.ROOM_NOT_FOUND, 'room_not_found');
          return;
        }
        const player: PlayerSummary = { id: randomUUID().slice(0, 8), nickname: message.nickname };
        try {
          room.join(player);
        } catch (error: unknown) {
          if (!(error instanceof RoomError)) throw error;
          sendError(conn, error.code, error.message);
          if (error.code === 'room_full') conn.socket.close(CloseCode.ROOM_FULL, 'room_full');
          return;
        }
        conn.joined = true;
        conn.room = room;
        conn.player = player;
        if (conn.authTimer !== null) clearTimeout(conn.authTimer);
        byRoom.get(room.id)?.add(conn);
        logger.info('player.joined', {
          roomId: room.id,
          playerId: player.id,
        });
        send(conn, {
          type: 'welcome',
          playerId: player.id,
          room: room.toJSON(),
          players: room.roster(),
        });
        return;
      }

      case 'chat': {
        if (!conn.joined || !conn.room || !conn.player) {
          violate(conn, CloseCode.POLICY_VIOLATION, 'not_joined', 'спершу надішліть join');
          return;
        }
        conn.room.chat(conn.player.id, message.text);
        return;
      }

      case 'leave': {
        leaveRoom(conn);
        conn.socket.close(CloseCode.NORMAL, 'bye');
        return;
      }

      case 'ping': {
        send(conn, { type: 'pong', t: message.t ?? null, serverTime: Date.now() });
        return;
      }

      case 'ready': {
        if (!conn.joined || !conn.room || !conn.player) {
          violate(conn, CloseCode.POLICY_VIOLATION, 'not_joined', 'спершу надішліть join');
          return;
        }
        if (conn.inMatch) {
          sendError(conn, 'already_ready', 'ви вже в матчі');
          return;
        }
        const codec = message.codec ?? 'binary';
        const match = matches.getOrCreate(conn.room);
        const info = match.addPlayer(conn.player.id, {
          nickname: conn.player.nickname,
          codec,
          send: (frame) => sendGame(conn, frame),
        });
        conn.inMatch = true;
        conn.match = match;
        logger.info('гравець увійшов у матч', {
          room: conn.room.id,
          playerId: conn.player.id,
          codec,
        });
        send(conn, {
          type: 'start',
          ...info,
          codec,
          netsimEnabled: wsConfig.netsimEnabled,
          netsim: conn.netsim.toJSON(),
        });
        return;
      }

      case 'codec': {
        if (!conn.inMatch || !conn.match || !conn.player) {
          sendError(conn, 'not_in_match', 'спершу надішліть ready');
          return;
        }
        if (message.codec) conn.match.setCodec(conn.player.id, message.codec);
        return;
      }

      case 'netsim': {
        if (!wsConfig.netsimEnabled) {
          sendError(conn, 'netsim_disabled', 'емуляцію мережі вимкнено (NETSIM_ENABLED=0)');
          return;
        }
        const parsed = parseNetsimParams(message);
        if (!parsed.ok) {
          sendError(conn, 'bad_netsim', parsed.error);
          return;
        }
        conn.netsim.update(parsed.data);
        send(conn, { type: 'netsim', ...conn.netsim.toJSON() });
        return;
      }

      case 'input': {
        conn.netsim.schedule('in', () => handleInput(conn, message, 0));
        return;
      }

      default: {
        const _exhaustive: never = message;
        return assertNever(_exhaustive, 'необроблений тип повідомлення клієнта');
      }
    }
  }

  function onBinary(conn: ClientConn, buf: Buffer): void {
    if (!conn.inputBucket.take()) {
      violate(
        conn,
        CloseCode.POLICY_VIOLATION,
        'rate_limited',
        'перевищено ліміт повідомлень',
        'rate_limit',
      );
      return;
    }
    let message;
    try {
      message = binaryCodec.decode(buf);
    } catch {
      violate(
        conn,
        CloseCode.UNSUPPORTED_DATA,
        'binary_frame',
        'некоректний бінарний кадр',
        'invalid_payload',
      );
      return;
    }
    const bytes = buf.byteLength;
    switch (message.type) {
      case MsgType.INPUT:
        conn.netsim.schedule('in', () => handleInput(conn, message, bytes));
        return;
      case MsgType.PING: {
        const clientTime = message.clientTime;
        conn.netsim.schedule('in', () =>
          sendGame(
            conn,
            binaryCodec.encode({
              type: MsgType.PONG,
              clientTime,
              serverTick: conn.match?.tick ?? asTick(0),
            }),
          ),
        );
        return;
      }
      case MsgType.SNAPSHOT:
      case MsgType.PONG:
        violate(
          conn,
          CloseCode.POLICY_VIOLATION,
          'unknown_type',
          'неочікуваний бінарний кадр',
          'policy',
        );
        return;
      default: {
        const _exhaustive: never = message;
        return assertNever(_exhaustive, 'невідомий бінарний кадр');
      }
    }
  }

  function onMessage(conn: ClientConn, data: RawData, isBinary: boolean): void {
    const buf = rawDataToBuffer(data);
    metrics?.recordMessage('in', buf.byteLength);
    if (isBinary) {
      onBinary(conn, buf);
      return;
    }
    const bucket = isInputFrame(buf) ? conn.inputBucket : conn.bucket;
    if (!bucket.take()) {
      violate(
        conn,
        CloseCode.POLICY_VIOLATION,
        'rate_limited',
        'перевищено ліміт повідомлень',
        'rate_limit',
      );
      return;
    }
    const parsed = parseClientMessage(buf, { maxBytes: wsConfig.maxPayload });
    if (!parsed.ok) {
      violate(
        conn,
        parsed.error.closeCode,
        parsed.error.code,
        parsed.error.reason,
        'invalid_payload',
      );
      return;
    }
    dispatchClientMessage(conn, parsed.data);
  }

  wss.on('error', (error: unknown) => logger.error('помилка WebSocketServer', { error }));

  wss.on('connection', (socket, request) => {
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin, config.allowedOrigins, config.nodeEnv)) {
      stats.rejected += 1;
      metrics?.recordRejection('origin');
      logger.warn('ws.rejected', { reason: 'origin', origin });
      socket.on('error', () => {});
      socket.close(CloseCode.FORBIDDEN_ORIGIN, 'forbidden_origin');
      return;
    }

    const ip = request.socket.remoteAddress ?? 'unknown';
    const ipCount = byIp.get(ip) ?? 0;
    if (ipCount >= limits.maxConnectionsPerIp) {
      stats.rejected += 1;
      metrics?.recordRejection('ip_limit');
      logger.warn('ws.rejected', { reason: 'ip_limit', ip, count: ipCount });
      socket.on('error', () => {});
      socket.close(CloseCode.TRY_AGAIN_LATER, 'ip_limit');
      return;
    }

    if (connections.size >= limits.maxConnections) {
      stats.rejected += 1;
      metrics?.recordRejection('server_full');
      logger.warn('ws.rejected', { reason: 'server_full' });
      socket.on('error', () => {});
      socket.close(CloseCode.TRY_AGAIN_LATER, 'server_full');
      return;
    }

    byIp.set(ip, ipCount + 1);

    const conn: ClientConn = {
      id: randomUUID().slice(0, 8),
      ip: request.socket.remoteAddress,
      socket,
      joined: false,
      room: null,
      player: null,
      dropped: 0,
      awaitingPong: false,
      missedPongs: 0,
      bucket: new TokenBucket({
        capacity: wsConfig.rateLimitBurst,
        refillPerSec: wsConfig.rateLimitPerSec,
      }),
      authTimer: null,
      inMatch: false,
      match: null,
      badInputs: 0,
      netsim: new NetSim(),
      inputBucket: new TokenBucket({
        capacity: wsConfig.inputRateLimitBurst,
        refillPerSec: wsConfig.inputRateLimitPerSec,
      }),
    };
    connections.add(conn);
    stats.accepted += 1;

    const query = new URL(request.url ?? '/ws', 'http://localhost').searchParams;
    if (['latency', 'jitter', 'drop'].some((key) => query.has(key))) {
      const requested = parseNetsimParams(Object.fromEntries(query));
      if (!wsConfig.netsimEnabled) {
        logger.warn('емуляцію мережі вимкнено: параметри адреси ігноруються', { conn: conn.id });
      } else if (requested.ok) {
        conn.netsim.update(requested.data);
      } else {
        logger.warn('некоректні параметри емуляції мережі', {
          conn: conn.id,
          error: requested.error,
        });
      }
    }

    socket.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      logger.warn('помилка сокета', { conn: conn.id, code, message });
    });

    socket.on('pong', () => {
      conn.awaitingPong = false;
      conn.missedPongs = 0;
    });

    socket.on('message', (data, isBinary) => {
      try {
        onMessage(conn, data, isBinary);
      } catch (error: unknown) {
        logger.error('неочікувана помилка обробника повідомлення', { conn: conn.id, error });
        socket.close(CloseCode.INTERNAL_ERROR, 'internal_error');
      }
    });

    socket.on('close', () => {
      if (conn.authTimer !== null) clearTimeout(conn.authTimer);
      conn.netsim.dispose();
      connections.delete(conn);
      const nextCount = (byIp.get(ip) ?? 1) - 1;
      if (nextCount <= 0) byIp.delete(ip);
      else byIp.set(ip, nextCount);
      leaveRoom(conn);
    });

    conn.authTimer = setTimeout(() => {
      if (conn.joined) return;
      logger.info('таймаут авторизації', { conn: conn.id, ip: conn.ip });
      sendError(conn, 'auth_timeout', 'join не отримано вчасно');
      socket.close(CloseCode.AUTH_TIMEOUT, 'auth_timeout');
    }, wsConfig.authTimeoutMs);
  });

  const heartbeat = setInterval(() => {
    for (const conn of connections) {
      if (conn.awaitingPong) {
        conn.missedPongs += 1;
        if (conn.missedPongs >= 2) {
          logger.warn('heartbeat: клієнт не відповідає, відключаю', { conn: conn.id });
          conn.socket.terminate();
          continue;
        }
      }
      conn.awaitingPong = true;
      conn.socket.ping();
    }
  }, wsConfig.heartbeatMs);
  heartbeat.unref();

  async function close({ timeoutMs = 3000 }: { readonly timeoutMs?: number } = {}): Promise<void> {
    clearInterval(heartbeat);
    for (const conn of connections) {
      if (conn.authTimer !== null) clearTimeout(conn.authTimer);
      send(conn, { type: 'shutdown', reason: 'server_shutting_down' });
      conn.socket.close(CloseCode.GOING_AWAY, 'server_shutting_down');
    }
    const deadline = Date.now() + timeoutMs;
    while (connections.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const conn of connections) conn.socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return { wss, connections, stats, close };
}
