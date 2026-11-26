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
import { binaryCodec, MsgType } from '@dogfight/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { CloseCode, encodeServerMessage, parseClientMessage } from './protocol.js';
import { NetSim, parseNetsimParams } from './netsim.js';
import { TokenBucket } from './rate_limit.js';
import { RoomError } from './rooms.js';

/** Після такої кількості відкинутих повідомлень повільний клієнт відключається. */
const MAX_DROPPED_BEFORE_DISCONNECT = 100;
/** Жорстка межа буфера: у скільки разів перевищує maxBufferedBytes, щоб відключити одразу. */
const HARD_BUFFER_FACTOR = 4;
/** Скільки відхилених команд вводу терпимо, перш ніж відключити клієнта як підозрілого. */
const MAX_BAD_INPUTS = 30;

/** Дешева перевірка префікса текстового кадру: чи це JSON-ввід (до повного розбору). */
function isInputFrame(data) {
  const head = data.subarray ? data.subarray(0, 24).toString('utf8') : String(data).slice(0, 24);
  return head.startsWith('{"v":1,"type":"input"');
}

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
export function safeSend(conn, type, payload, options) {
  return deliver(conn, encodeServerMessage(type, payload), options);
}

/**
 * Ядро політики повільного клієнта: надсилає вже закодований кадр (рядок = текстовий кадр,
 * ArrayBuffer/Buffer = бінарний). Знімки світу тут - ідеальні кандидати на відкидання:
 * застарілий знімок нікому не потрібен, нового чекати лише 33 мс.
 */
export function deliver(conn, data, { maxBufferedBytes, logger, stats }) {
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

  socket.send(data, (error) => {
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
export function attachWebSocketServer({ server, rooms, matches, config, logger }) {
  const { ws: wsConfig, limits } = config;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: wsConfig.maxPayload });
  const connections = new Set();
  const byRoom = new Map(); // roomId -> Set<conn>
  const stats = { accepted: 0, rejected: 0, dropped: 0, violations: 0, rejectedInputs: 0 };
  const sendOptions = { maxBufferedBytes: wsConfig.maxBufferedBytes, logger, stats };

  const send = (conn, type, payload) => safeSend(conn, type, payload, sendOptions);
  const broadcast = (roomId, type, payload) => {
    for (const conn of byRoom.get(roomId) ?? []) send(conn, type, payload);
  };
  const sendError = (conn, code, message) => send(conn, 'error', { code, message });
  /** Ігровий кадр (знімок, pong): іде через емулятор мережі з'єднання (затримка/джиттер/втрати). */
  const sendGame = (conn, frame) =>
    conn.netsim.schedule('out', () => deliver(conn, frame, sendOptions));

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

  /** Прибирає судно гравця з матчу; порожній матч зупиняється й видаляється. */
  function leaveMatch(conn) {
    if (!conn.inMatch) return;
    conn.inMatch = false;
    const { match } = conn;
    conn.match = null;
    match.removePlayer(conn.player.id);
    if (match.playerCount === 0) matches.remove(match.roomId);
  }

  function leaveRoom(conn) {
    if (!conn.joined) return;
    leaveMatch(conn);
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

    /** Вхід у матч: створює судно, відповідає start; далі йдуть бінарні знімки. */
    ready(conn, message) {
      if (!conn.joined) {
        return violate(conn, CloseCode.POLICY_VIOLATION, 'not_joined', 'спершу надішліть join');
      }
      if (conn.inMatch) return sendError(conn, 'already_ready', 'ви вже в матчі');
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
      return send(conn, 'start', {
        ...info,
        codec,
        netsimEnabled: wsConfig.netsimEnabled,
        netsim: conn.netsim.toJSON(),
      });
    },

    codec(conn, message) {
      if (!conn.inMatch) return sendError(conn, 'not_in_match', 'спершу надішліть ready');
      if (message.codec) conn.match.setCodec(conn.player.id, message.codec);
      return undefined;
    },

    netsim(conn, message) {
      if (!wsConfig.netsimEnabled) {
        return sendError(conn, 'netsim_disabled', 'емуляцію мережі вимкнено (NETSIM_ENABLED=0)');
      }
      const parsed = parseNetsimParams(message);
      if (!parsed.ok) return sendError(conn, 'bad_netsim', parsed.error);
      conn.netsim.update(parsed.value);
      return send(conn, 'netsim', conn.netsim.toJSON());
    },

    /** Ввід у JSON-режимі (текстовий кадр): далі та сама валідація, що й у бінарного. */
    input(conn, message) {
      conn.netsim.schedule('in', () => handleInput(conn, message, 0));
    },
  };

  /** Передає ввід матчу; систематичні читерські значення призводять до відключення. */
  function handleInput(conn, message, bytes) {
    if (!conn.inMatch) return;
    const result = conn.match.submitInput(conn.player.id, message, { bytes });
    if (result.rejected === 0) return;
    stats.rejectedInputs += result.rejected;
    conn.badInputs += result.rejected;
    if (conn.badInputs >= MAX_BAD_INPUTS) {
      violate(
        conn,
        CloseCode.POLICY_VIOLATION,
        'cheat_suspected',
        `некоректний ввід: ${result.reason}`,
      );
    }
  }

  /** Бінарний кадр: INPUT іде в матч, PING - назад як PONG (через емулятор мережі). */
  function onBinary(conn, data) {
    if (!conn.inputBucket.take()) {
      return violate(
        conn,
        CloseCode.POLICY_VIOLATION,
        'rate_limited',
        'перевищено ліміт повідомлень',
      );
    }
    let message;
    try {
      message = binaryCodec.decode(data);
    } catch {
      return violate(conn, CloseCode.UNSUPPORTED_DATA, 'binary_frame', 'некоректний бінарний кадр');
    }
    const bytes = data.byteLength;
    if (message.type === MsgType.INPUT) {
      return conn.netsim.schedule('in', () => handleInput(conn, message, bytes));
    }
    if (message.type === MsgType.PING) {
      return conn.netsim.schedule('in', () =>
        sendGame(
          conn,
          binaryCodec.encode({
            type: MsgType.PONG,
            clientTime: message.clientTime,
            serverTick: conn.match?.tick ?? 0,
          }),
        ),
      );
    }
    return violate(conn, CloseCode.POLICY_VIOLATION, 'unknown_type', 'неочікуваний бінарний кадр');
  }

  function onMessage(conn, data, isBinary) {
    if (isBinary) return onBinary(conn, data);
    // Ввід у JSON-режимі йде з частотою тіків: власне відро, щоб не вичерпати ліміт чату/керування.
    const bucket = isInputFrame(data) ? conn.inputBucket : conn.bucket;
    if (!bucket.take()) {
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
      // Ігровий стан з'єднання: матч, емулятор мережі, окреме відро для вводу.
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

    // Емуляція мережі з адреси: /ws?latency=100&jitter=30&drop=0.02 (або повідомленням netsim).
    const query = new URL(request.url ?? '/ws', 'http://localhost').searchParams;
    if (['latency', 'jitter', 'drop'].some((key) => query.has(key))) {
      const requested = parseNetsimParams(Object.fromEntries(query));
      if (!wsConfig.netsimEnabled) {
        logger.warn('емуляцію мережі вимкнено: параметри адреси ігноруються', { conn: conn.id });
      } else if (requested.ok) {
        conn.netsim.update(requested.value);
      } else {
        logger.warn('некоректні параметри емуляції мережі', {
          conn: conn.id,
          error: requested.error,
        });
      }
    }
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
      conn.netsim.dispose();
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
