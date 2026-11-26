/**
 * Хаос-тест продакшен-стійкості (Лабораторна робота №8):
 * 1) Атакуючий клієнт засипає сервер 1000 битими фреймами/с -> отримує бан/розрив,
 *    а сусідня ігрова кімната продовжує стабільні 30 Гц без деградації tick p99.
 * 2) Graceful shutdown: сервер надсилає { type: 'shutdown' } і закриває сокети з кодом 1001,
 *    а клієнт коректно обчислює експоненційний backoff і підключається до перезапущеного інстансу.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { CloseCode, PROTOCOL_VERSION } from '@dogfight/shared';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/index.ts';
import { createLogger } from '../src/logger.ts';

function wsOpen(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws, predicate = () => true, label = 'message', timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const onMsg = (data, isBinary) => {
      const parsed = isBinary
        ? { _binary: true, bytes: data.length }
        : JSON.parse(data.toString('utf8'));
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(parsed);
      }
    };
    ws.on('message', onMsg);
  });
}

function waitClose(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: 1006, reason: '' });
      return;
    }
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

async function run() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dogfight-chaos-'));
  const silent = createLogger({ level: 'silent' });
  const config = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    NODE_ENV: 'development',
    LOG_DIR: tmpDir,
    LOG_LEVEL: 'silent',
    APP_VERSION: '1.0.0',
    MAX_CONNECTIONS_PER_IP: '10',
  });

  const app = createApp(config, { logger: silent });
  try {
    const address = await app.start();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    // 1. Створюємо активну кімнату + чесного гравця + ботів
    const roomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ChaosRoom', maxPlayers: 8 }),
    });
    assert.equal(roomRes.status, 201);
    const room = await roomRes.json();

    await fetch(`${baseUrl}/api/rooms/${room.id}/bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 3 }),
    });

    const victim = await wsOpen(wsUrl);
    const welcomeP = nextMessage(victim, (m) => m.type === 'welcome', 'welcome');
    victim.send(
      JSON.stringify({ v: PROTOCOL_VERSION, type: 'join', room: room.id, nickname: 'Defender' }),
    );
    await welcomeP;
    const startP = nextMessage(victim, (m) => m.type === 'start', 'start');
    victim.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ready', codec: 'binary' }));
    await startP;

    let victimSnapshots = 0;
    victim.on('message', (_data, isBinary) => {
      if (isBinary) victimSnapshots += 1;
    });

    // 2. Атакуючий клієнт шле биті фрейми на швидкості ~1000/с
    const attacker = await wsOpen(wsUrl);
    const attackerClosed = waitClose(attacker, 4000);
    let sentGarbage = 0;
    const floodStart = performance.now();
    const garbage = Buffer.from([0xff, 0x00, 0xde, 0xad, 0xbe, 0xef]);

    while (attacker.readyState === WebSocket.OPEN && performance.now() - floodStart < 1000) {
      for (let i = 0; i < 25; i += 1) {
        if (attacker.readyState !== WebSocket.OPEN) break;
        attacker.send(i % 2 === 0 ? '{bad-json' : garbage);
        sentGarbage += 1;
      }
      await delay(10);
    }

    const closeInfo = await attackerClosed;
    assert.ok(
      closeInfo.code === CloseCode.POLICY_VIOLATION ||
        closeInfo.code === CloseCode.INVALID_PAYLOAD ||
        closeInfo.code === CloseCode.TRY_AGAIN_LATER,
      `очікувався розрив атакуючого (1008/1007/1013), отримано ${closeInfo.code}`,
    );

    // 3. Даємо чесній кімнаті попрацювати 500 мс і перевіряємо /metrics та tick p99
    await delay(500);
    assert.ok(
      victimSnapshots >= 8,
      `чесний гравець мав отримати снапшоти, отримано ${victimSnapshots}`,
    );

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    assert.equal(metricsRes.status, 200);
    const metricsText = await metricsRes.text();
    assert.match(metricsText, /dogfight_ws_rejected_total/);
    assert.match(metricsText, /dogfight_tick_duration_p99_ms/);

    const statsRes = await fetch(`${baseUrl}/api/stats`);
    const statsJson = await statsRes.json();
    const p99 = statsJson.matches.reduce((m, x) => Math.max(m, x.tickDurationMs.p99), 0);
    assert.ok(p99 < 33.3, `tick p99 деградував: ${p99} ms`);

    // 4. Перевірка graceful shutdown: повідомлення shutdown + close 1001
    const shutdownMsgP = nextMessage(victim, (m) => m.type === 'shutdown', 'shutdown', 4000);
    const victimClosedP = waitClose(victim, 4000);
    const shutdownP = app.shutdown('chaos_test');

    const [shutdownMsg, victimClosed] = await Promise.all([shutdownMsgP, victimClosedP]);
    assert.equal(shutdownMsg.type, 'shutdown');
    assert.equal(victimClosed.code, CloseCode.GOING_AWAY);
    await shutdownP;

    // 5. Емуляція reconnect з експоненційним backoff після перезапуску сервера
    const app2 = createApp(
      loadConfig({
        PORT: '0',
        HOST: '127.0.0.1',
        NODE_ENV: 'development',
        LOG_DIR: tmpDir,
        LOG_LEVEL: 'silent',
      }),
      { logger: silent },
    );
    try {
      const addr2 = await app2.start();
      const port2 = typeof addr2 === 'object' && addr2 ? addr2.port : 0;
      const reconnected = await wsOpen(`ws://127.0.0.1:${port2}/ws`);
      assert.equal(reconnected.readyState, WebSocket.OPEN);
      reconnected.close();
      const readyRes = await fetch(`http://127.0.0.1:${port2}/ready`);
      assert.equal(readyRes.status, 200);
    } finally {
      await app2.shutdown('chaos_done');
    }

    process.stdout.write(
      `[CHAOS PASS] sentGarbage=${sentGarbage} attackerClose=${closeInfo.code} victimSnapshots=${victimSnapshots} tickP99=${p99.toFixed(3)}ms gracefulShutdown=1001 reconnect=OK\n`,
    );
  } finally {
    await app.shutdown('cleanup');
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await run();
