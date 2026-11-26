/**
 * Навантажувальний тест сервера: піднімає N headless WebSocket-клієнтів (ws) зі скриптовим
 * рухом і стрільбою для N = 8, 32, 64, 128, вимірює tick p99 (ms), eventLoopUtilization,
 * RSS (MB) і трафік (KB/s), та визначає граничну ємність до бюджету тіка 33.3 мс.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { asSeq, asTick, binaryCodec, MsgType, TICK_MS } from '@dogfight/shared';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/index.ts';
import { createLogger } from '../src/logger.ts';

const LEVELS = [8, 32, 64, 128];
const DURATION_MS = 3000;
const TICK_BUDGET_MS = 1000 / 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openBotClient(wsUrl, roomId, index) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let bytesIn = 0;
    let bytesOut = 0;
    let seq = 0;
    let timer = null;
    let ready = false;

    const sendJson = (obj) => {
      const text = JSON.stringify(obj);
      bytesOut += Buffer.byteLength(text);
      socket.send(text);
    };

    socket.on('open', () => {
      sendJson({ v: 1, type: 'join', room: roomId, nickname: `Load${index}` });
    });

    socket.on('message', (data, isBinary) => {
      bytesIn += Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(String(data));
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.type === 'welcome') {
        sendJson({ v: 1, type: 'ready', codec: 'binary' });
      } else if (msg.type === 'start' && !ready) {
        ready = true;
        timer = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          seq += 1;
          const frame = binaryCodec.encode({
            type: MsgType.INPUT,
            seq: asSeq(seq),
            tick: asTick(seq),
            thrust: seq % 4 !== 0,
            turn: (seq + index) % 3 === 0 ? 1 : (seq + index) % 3 === 1 ? -1 : 0,
            fire: seq % 3 === 0,
            missile: false,
            prev: [],
          });
          bytesOut += frame.byteLength;
          socket.send(frame);
        }, TICK_MS);
        resolve({
          getBytes: () => ({ bytesIn, bytesOut }),
          close: () => {
            clearInterval(timer);
            socket.close();
          },
        });
      }
    });

    socket.on('error', reject);
  });
}

async function runScenario(app, baseUrl, wsUrl, n) {
  const room = app.rooms.create({
    name: `Load ${n}`,
    maxPlayers: Math.max(8, n),
    arena: { initialAsteroids: 12, minAsteroids: 10 },
  });

  const eluStart = performance.eventLoopUtilization();
  const clients = await Promise.all(
    Array.from({ length: n }, (_, i) => openBotClient(wsUrl, room.id, i + 1)),
  );

  const t0 = performance.now();
  await sleep(DURATION_MS);
  const elapsedSec = (performance.now() - t0) / 1000;

  const eluDelta = performance.eventLoopUtilization(eluStart);
  const stats = await (await fetch(`${baseUrl}/api/stats`)).json();
  const match = stats.matches.find((m) => m.room === room.id);

  let totalIn = 0;
  let totalOut = 0;
  for (const c of clients) {
    const b = c.getBytes();
    totalIn += b.bytesIn;
    totalOut += b.bytesOut;
    c.close();
  }
  await sleep(150);

  return {
    N: n,
    tickAvgMs: match?.tickDurationMs.avg ?? 0,
    tickP99Ms: match?.tickDurationMs.p99 ?? 0,
    tickMaxMs: match?.tickDurationMs.max ?? 0,
    eluPct: Number((eluDelta.utilization * 100).toFixed(1)),
    rssMB: Number((stats.memory.rss / 1024 / 1024).toFixed(1)),
    kbDownSec: Number((totalIn / 1024 / elapsedSec).toFixed(1)),
    kbUpSec: Number((totalOut / 1024 / elapsedSec).toFixed(1)),
    withinBudget: (match?.tickDurationMs.p99 ?? 0) < TICK_BUDGET_MS,
  };
}

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dogfight-load-'));
  const config = loadConfig(
    {
      PORT: '0',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_DIR: path.join(tmp, 'logs'),
      MAX_PLAYERS_PER_ROOM: '64',
      MAX_CONNECTIONS: '500',
    },
    tmp,
  );
  // Для N=128 дозволяємо до 256 гравців у кімнаті без зміни дефолтів конфіга.
  const loadConfigOverride = {
    ...config,
    limits: { ...config.limits, maxPlayersPerRoom: 256 },
  };
  const app = createApp(loadConfigOverride, { logger: createLogger({ level: 'silent' }) });
  await app.start();
  const { port } = app.address;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const results = [];
  try {
    for (const n of LEVELS) {
      results.push(await runScenario(app, baseUrl, wsUrl, n));
    }
  } finally {
    await app.shutdown('load_test');
    await rm(tmp, { recursive: true, force: true });
  }

  console.table(results);
}

await main();
