/**
 * WebSocket-шар на бібліотеці ws, прив'язаний до HTTP-сервера (шлях /ws).
 *
 * Захисні механізми:
 *  - maxPayload: бібліотека сама закриває з'єднання кодом 1009 для надто великого кадру;
 *  - обов'язковий обробник socket.on('error') на кожному сокеті, інакше помилка мережі
 *    стала б необробленою подією 'error' і зупинила б увесь процес;
 *  - таймаут авторизації: валідний join мусить прийти за authTimeoutMs;
 *  - heartbeat: ping кожні heartbeatMs, «мертвий» клієнт (2 пропущені pong) відключається;
 *  - token bucket на з'єднання (rate limit) і ліміти кімнат/гравців/з'єднань;
 *  - політика повільного клієнта: перед відправкою перевіряється socket.bufferedAmount.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { CloseCode, encodeServerMessage, parseClientMessage } from './protocol.js';
import { TokenBucket } from './rate_limit.js';
import { RoomError } from './rooms.js';

/** Після такої кількості відкинутих повідомлень повільний клієнт відключається. */
const MAX_DROPPED_BEFORE_DISCONNECT = 100;
/** Жорстка межа буфера: у скільки разів перевищує maxBufferedBytes, щоб відключити одразу. */
const HARD_BUFFER_FACTOR = 4;

/**
 * Надсилає повідомлення з урахуванням повільного клієнта.
 *  - 'sent'    - передано бібліотеці;
 *  - 'dropped' - буфер сокета переповнений, повідомлення відкинуто (клієнт не встигає читати);
 *  - 'closed'  - сокет закрито або його відключено через переповнення.
 *
 * @param {{ socket: import('ws').WebSocket, dropped: number }} conn
 * @param {string} type
 * @param {object} payload
 * @param {{ maxBufferedBytes: number, logger: object, stats?: { dropped: number } }} options
 */
export function safeSend(conn, type, payload, { maxBufferedBytes, logger, stats }) {
  const { socket } = conn;
  if (socket.readyState !== WebSocket.OPEN) return 'closed';

  if (socket.bufferedAmount > maxBufferedBytes * HARD_BUFFER_FACTOR) {
    logger.warn('slow consumer: буфер переповнений, відключаю', {
      bufferedAmount: socket.bufferedAmount,
    });
    socket.terminate(); // клієнт не читає, close-кадр він усе одно не прийме
    return 'closed';
  }
  if (socket.bufferedAmount > maxBufferedBytes) {
    conn.dropped += 1;
    if (stats) stats.dropped += 1;
    if (conn.dropped >= MAX_DROPPED_BEFORE_DISCONNECT) {
      logger.warn('slow consumer: забагато відкинутих повідомлень, відключаю', {
        dropped: conn.dropped,
      });
      socket.close(CloseCode.SLOW_CONSUMER, 'slow consumer');
      return 'closed';
    }
    return 'dropped';
  }

  socket.send(encodeServerMessage(type, payload), (error) => {
    if (error) logger.warn('помилка відправки', { error: error.message });
  });
  return 'sent';
}

/**
 * @param {object} options
 * @param {import('node:http').Server} options.server
 * @param {import('./rooms.js').RoomManager} options.rooms
 * @param {object} options.config результат loadConfig()
 * @param {object} options.logger
 */
export function attachWebSocketServer({ server, rooms, config, logger }) {
  const { ws: wsConfig, limits } = config;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: wsConfig.maxPayload });
  const connections = new Set();
  const byRoom = new Map(); // roomId -> Set<conn>
  const stats = { accepted: 0, rejected: 0, dropped: 0, violations: 0 };
  const sendOptions = { maxBufferedBytes: wsConfig.maxBufferedBytes, logger, stats };

  const send = (conn, type, payload) => safeSend(conn, type, payload, sendOptions);
  const broadcast = (roomId, type, payload) => {
    for (const conn of byRoom.get(roomId) ?? []) send(conn, type, payload);
  };
  const sendError = (conn, code, message) => send(conn, 'error', { code, message });

  // --- Підписка на події кімнат: мережевий шар лише реагує на стан ---
  rooms.on('created', (room) => {
    byRoom.set(room.id, new Set());
    const rosterPayload = () => ({ room: room.id, players: room.roster() });
    room.on('join', () => broadcast(room.id, 'roster', rosterPayload()));
    room.on('leave', () => broadcast(room.id, 'roster', rosterPayload()));
    room.on('chat', (message) => broadcast(room.id, 'chat', { room: room.id, ...message }));
  });
  rooms.on('removed', (room) => byRoom.delete(room.id));

  /** Порушення протоколу чи політики: лог, повідомлення про помилку й закриття сокета. */
  function violate(conn, closeCode, code, reason) {
    stats.violations += 1;
    logger.warn('порушення протоколу WebSocket', {
      conn: conn.id,
      ip: conn.ip,
      code,
      reason,
      closeCode,
    });
    sendError(conn, code, reason);
    conn.socket.close(closeCode, code); // причина закриття - короткий ASCII-код (ліміт 123 байти)
  }

  function leaveRoom(conn) {
    if (!conn.joined) return;
    conn.joined = false;
    byRoom.get(conn.room.id)?.delete(conn);
    conn.room.leave(conn.player.id);
  }

  const handlers = {
    join(conn, message) {
      if (conn.joined) return sendError(conn, 'already_joined', 'ви вже перебуваєте в кімнаті');

      const room = rooms.get(message.room);
      if (!room) {
        sendError(conn, 'room_not_found', 'кімнату не знайдено');
        return conn.socket.close(CloseCode.ROOM_NOT_FOUND, 'room_not_found');
      }

      const player = { id: randomUUID().slice(0, 8), nickname: message.nickname };
      try {
        room.join(player);
      } catch (error) {
        if (!(error instanceof RoomError)) throw error;
        sendError(conn, error.code, error.message);
        if (error.code === 'room_full') return conn.socket.close(CloseCode.ROOM_FULL, 'room_full');
        return undefined; // нікнейм зайнятий: можна спробувати інший у межах таймауту авторизації
      }

      conn.joined = true;
      conn.room = room;
      conn.player = player;
      clearTimeout(conn.authTimer);
      byRoom.get(room.id)?.add(conn);
      logger.info('гравець приєднався', {
        room: room.id,
        playerId: player.id,
        nickname: player.nickname,
      });
      return send(conn, 'welcome', {
        playerId: player.id,
        room: room.toJSON(),
        players: room.roster(),
      });
    },

    chat(conn, message) {
      if (!conn.joined)
        return violate(conn, CloseCode.POLICY_VIOLATION, 'not_joined', 'спершу надішліть join');
      return conn.room.chat(conn.player.id, message.text);
    },

    leave(conn) {
      leaveRoom(conn);
      conn.socket.close(CloseCode.NORMAL, 'bye');
    },

    ping(conn, message) {
      send(conn, 'pong', { t: message.t ?? null, serverTime: Date.now() });
    },
  };

  function onMessage(conn, data, isBinary) {
    if (isBinary) {
      return violate(
        conn,
        CloseCode.UNSUPPORTED_DATA,
        'binary_frame',
        'бінарні кадри не підтримуються',
      );
    }
    if (!conn.bucket.take()) {
      return violate(
        conn,
        CloseCode.POLICY_VIOLATION,
        'rate_limited',
        'перевищено ліміт повідомлень',
      );
    }
    const parsed = parseClientMessage(data, { maxBytes: wsConfig.maxPayload });
    if (!parsed.ok) return violate(conn, parsed.closeCode, parsed.code, parsed.reason);
    return handlers[parsed.message.type](conn, parsed.message);
  }

  wss.on('error', (error) => logger.error('помилка WebSocketServer', { error }));

  wss.on('connection', (socket, request) => {
    if (connections.size >= limits.maxConnections) {
      stats.rejected += 1;
      socket.on('error', () => {});
      socket.close(CloseCode.TRY_AGAIN_LATER, 'server_full');
      return;
    }

    const conn = {
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
    };
    connections.add(conn);
    stats.accepted += 1;

    // ОБОВ'ЯЗКОВО: без цього обробника помилка сокета (скидання з'єднання, надто великий кадр)
    // стала б необробленою подією 'error' і завалила б увесь процес.
    socket.on('error', (error) => {
      logger.warn('помилка сокета', { conn: conn.id, code: error.code, message: error.message });
    });

    socket.on('pong', () => {
      conn.awaitingPong = false;
      conn.missedPongs = 0;
    });

    socket.on('message', (data, isBinary) => {
      try {
        onMessage(conn, data, isBinary);
      } catch (error) {
        // Помилка обробника не повинна виходити за межі з'єднання.
        logger.error('неочікувана помилка обробника повідомлення', { conn: conn.id, error });
        socket.close(CloseCode.INTERNAL_ERROR, 'internal_error');
      }
    });

    socket.on('close', () => {
      clearTimeout(conn.authTimer);
      connections.delete(conn);
      leaveRoom(conn);
    });

    // Клієнт мусить прислати валідний join за відведений час.
    conn.authTimer = setTimeout(() => {
      if (conn.joined) return;
      logger.info('таймаут авторизації', { conn: conn.id, ip: conn.ip });
      sendError(conn, 'auth_timeout', 'join не отримано вчасно');
      socket.close(CloseCode.AUTH_TIMEOUT, 'auth_timeout');
    }, wsConfig.authTimeoutMs);
  });

  // Heartbeat: ping кожні heartbeatMs; клієнт, що пропустив 2 pong поспіль, відключається.
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

  /** Коректне закриття: код 1001 усім клієнтам, очікування закриття, інакше terminate. */
  async function close({ timeoutMs = 3000 } = {}) {
    clearInterval(heartbeat);
    for (const conn of connections) {
      clearTimeout(conn.authTimer);
      conn.socket.close(CloseCode.GOING_AWAY, 'server_shutting_down');
    }
    const deadline = Date.now() + timeoutMs;
    while (connections.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const conn of connections) conn.socket.terminate();
    await new Promise((resolve) => wss.close(() => resolve()));
  }

  return { wss, connections, stats, close };
}
