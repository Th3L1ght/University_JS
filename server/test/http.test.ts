import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HttpError, resolveStaticPath } from '../src/http.ts';
import { join, makeRoom, openClient, sleep, startTestApp } from './helpers.ts';

/** Сирий HTTP-запит із довільним шляхом: fetch нормалізує ".." і нічого б не перевірив. */
function rawRequest(port, rawPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const postJson = (url, body, headers = {}) =>
  fetch(`${url}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('HTTP: /health і REST API кімнат', () => {
  let env;
  before(async () => {
    env = await startTestApp({ MAX_ROOMS: '3', MAX_BODY_BYTES: '512' });
  });
  after(() => env.stop());

  test('GET /health', async () => {
    const response = await fetch(`${env.url}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptimeSec, 'number');
    assert.equal(typeof body.memory.rss, 'number');
    assert.equal(body.rooms, 0);
    assert.equal(body.node, process.version);
  });

  test('POST /api/rooms -> 201, Location і дані кімнати; GET /api/rooms її показує', async () => {
    const response = await postJson(env.url, {
      name: 'Belt Alpha',
      mode: 'Survival',
      maxPlayers: 4,
      arena: { initialAsteroids: 7 },
    });
    assert.equal(response.status, 201);
    const room = await response.json();
    assert.match(room.id, /^belt-alpha-[0-9a-f]{4}$/);
    assert.equal(response.headers.get('location'), `/api/rooms/${room.id}`);
    assert.equal(room.maxPlayers, 4);
    assert.deepEqual(room.arena, { initialAsteroids: 7 });
    assert.match(room.replayId, new RegExp(`^${room.id}-`));

    const list = await (await fetch(`${env.url}/api/rooms`)).json();
    assert.ok(list.rooms.some((candidate) => candidate.id === room.id));
    env.app.rooms.remove(room.id);
  });

  test('валідація: 400 зі списком помилок', async () => {
    const response = await postJson(env.url, { name: 'x', maxPlayers: 99, extra: true });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'validation_failed');
    assert.ok(body.details.length >= 3);
  });

  test('битий JSON -> 400, інший Content-Type -> 415', async () => {
    assert.equal((await postJson(env.url, '{ nope')).status, 400);
    const wrongType = await fetch(`${env.url}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'name=x',
    });
    assert.equal(wrongType.status, 415);
  });

  test('обмеження розміру тіла: 413 за Content-Length і для chunked без Content-Length', async () => {
    const big = JSON.stringify({ name: 'a'.repeat(2000) });
    assert.equal((await postJson(env.url, big)).status, 413);

    // Тіло частинами без Content-Length: сервер мусить зупинитися на ліміті, а не накопичувати все.
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: env.port,
          path: '/api/rooms',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', (error) => (error.code === 'ECONNRESET' ? resolve(413) : reject(error)));
      req.write('{"name":"');
      req.write('a'.repeat(2000));
      req.end('"}');
    });
    assert.equal(status, 413);
  });

  test('ліміт кількості кімнат -> 409', async () => {
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await postJson(env.url, { name: `Room ${i}` });
      assert.equal(response.status, 201);
      created.push((await response.json()).id);
    }
    const over = await postJson(env.url, { name: 'Over' });
    assert.equal(over.status, 409);
    assert.equal((await over.json()).error, 'room_limit');
    for (const id of created) env.app.rooms.remove(id);
  });

  test('405 з Allow, 404 для невідомого API, 426 для /ws без upgrade', async () => {
    const put = await fetch(`${env.url}/api/rooms`, { method: 'PUT' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, POST');
    assert.equal((await fetch(`${env.url}/api/unknown`)).status, 404);
    assert.equal((await fetch(`${env.url}/ws`)).status, 426);
  });
});

describe('HTTP: GET /api/replays/:id (стрімінг журналу)', () => {
  let env;
  before(async () => {
    env = await startTestApp();
  });
  after(() => env.stop());

  test('віддає журнал завершеного матчу рядками NDJSON', async () => {
    const room = makeRoom(env.app, { name: 'Replay Room' });
    const client = await openClient(env.wsUrl);
    join(client, room.id, 'Maverick');
    await client.next('welcome');
    client.send({ v: 1, type: 'chat', text: 'перший' });
    await client.next('chat');
    client.send({ v: 1, type: 'leave' });
    await client.closed;
    await sleep(100); // журнал дописується асинхронно після виходу останнього гравця

    const response = await fetch(`${env.url}/api/replays/${room.replayId}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const text = await response.text();
    assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.type),
      ['start', 'join', 'chat', 'leave', 'end'],
    );
    assert.equal(events[2].text, 'перший');
    assert.ok(
      events.every((event, i) => i === 0 || event.t >= events[i - 1].t),
      'час не спадає',
    );
  });

  test('невідомий журнал -> 404, некоректні id -> 400 (path traversal не доходить до диска)', async () => {
    assert.equal((await fetch(`${env.url}/api/replays/nope-123`)).status, 404);
    for (const id of ['..%2f..%2fetc%2fpasswd', '%2e%2e', 'UPPER', 'a', 'x%00y', '%E0%A4%A']) {
      const response = await rawRequest(env.port, `/api/replays/${id}`);
      assert.equal(response.status, 400, id);
    }
    assert.equal((await rawRequest(env.port, '/api/replays/a/b')).status, 404);
  });
});

describe('HTTP: статика та захист від path traversal', () => {
  let env;
  let outsideFile;
  let symlinkSupported = true;
  before(async () => {
    env = await startTestApp();
    await writeFile(path.join(env.staticDir, 'index.html'), '<!doctype html><title>ok</title>');
    await writeFile(path.join(env.staticDir, 'app.js'), 'console.log(1)');
    await writeFile(path.join(env.staticDir, 'style.css'), 'a{}');
    await writeFile(
      path.join(env.staticDir, 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    await writeFile(path.join(env.staticDir, 'beep.wav'), 'RIFF');
    await writeFile(path.join(env.staticDir, 'data.json'), '{"a":1}');
    await writeFile(path.join(env.staticDir, 'noext'), 'x');
    await mkdir(path.join(env.staticDir, 'sub'));
    await writeFile(path.join(env.staticDir, 'sub', 'index.html'), 'sub index');
    outsideFile = path.join(env.dir, 'secret.txt');
    await writeFile(outsideFile, 'SECRET');
    try {
      await symlink(outsideFile, path.join(env.staticDir, 'leak.txt'));
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') symlinkSupported = false;
      else throw error;
    }
  });
  after(() => env.stop());

  test('Content-Type за розширенням, nosniff, індекс каталогу', async () => {
    const expected = {
      '/': 'text/html; charset=utf-8',
      '/index.html': 'text/html; charset=utf-8',
      '/app.js': 'text/javascript; charset=utf-8',
      '/style.css': 'text/css; charset=utf-8',
      '/logo.svg': 'image/svg+xml',
      '/beep.wav': 'audio/wav',
      '/data.json': 'application/json; charset=utf-8',
      '/noext': 'application/octet-stream',
    };
    for (const [url, type] of Object.entries(expected)) {
      const response = await fetch(env.url + url);
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('content-type'), type, url);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal(await (await fetch(`${env.url}/sub/`)).text(), 'sub index');
  });

  test('HEAD повертає заголовки без тіла, POST -> 405, відсутній файл -> 404', async () => {
    const head = await rawRequest(env.port, '/app.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '14');
    assert.equal(head.body, '');
    assert.equal((await rawRequest(env.port, '/app.js', { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${env.url}/missing.js`)).status, 404);
  });

  test('path traversal: усі варіанти ".." відхиляються (403/400) і не віддають сторонні файли', async () => {
    const attacks = [
      ['/../secret.txt', 403],
      ['/../../../../etc/passwd', 403],
      ['/%2e%2e/secret.txt', 403],
      ['/%2e%2e/%2e%2e/etc/passwd', 403],
      ['/..%2fsecret.txt', 403],
      ['/%2e%2e%2fsecret.txt', 403],
      ['/sub/../../secret.txt', 403],
      ['/..\\secret.txt', 403],
      ['/%2e%2e%5csecret.txt', 403],
      ['/%00', 400],
      ['/app.js%00.png', 400],
      ['/%E0%A4%A', 400],
    ];
    for (const [attack, status] of attacks) {
      const response = await rawRequest(env.port, attack);
      assert.equal(response.status, status, attack);
      assert.ok(!response.body.includes('SECRET'), attack);
    }
  });

  test('символічне посилання назовні кореня -> 403', async (t) => {
    if (!symlinkSupported) {
      t.skip('Windows без прав на створення симлінків (EPERM)');
      return;
    }
    const response = await fetch(`${env.url}/leak.txt`);
    assert.equal(response.status, 403);
    assert.ok(!(await response.text()).includes('SECRET'));
  });

  test('resolveStaticPath: модульні перевірки', async () => {
    const root = env.staticDir;
    assert.equal(
      await resolveStaticPath(root, '/app.js'),
      path.join(await import('node:fs/promises').then((fs) => fs.realpath(root)), 'app.js'),
    );
    assert.equal(await resolveStaticPath(root, '/nope'), null);
    await assert.rejects(
      resolveStaticPath(root, '/../x'),
      (e) => e instanceof HttpError && e.status === 403,
    );
    await assert.rejects(resolveStaticPath(root, '/a\0b'), (e) => e.status === 400);
  });

  test('у режимі development статику не віддаємо (її віддає Vite)', async () => {
    const dev = await startTestApp({ NODE_ENV: 'development' });
    try {
      assert.equal((await fetch(`${dev.url}/`)).status, 404);
      assert.equal((await fetch(`${dev.url}/health`)).status, 200);
    } finally {
      await dev.stop();
    }
  });

  test('сервер переживає некоректний HTTP (clientError)', async () => {
    await new Promise((resolve) => {
      const socket = net.connect(env.port, '127.0.0.1', () => socket.write('GARBAGE\r\n\r\n'));
      socket.on('data', () => {});
      socket.on('close', resolve);
    });
    assert.equal((await fetch(`${env.url}/health`)).status, 200);
  });
});
