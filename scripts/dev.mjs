/**
 * Dev-режим: Node-сервер (з автоперезапуском) і Vite dev-сервер одночасно.
 * Vite проксує /api і /ws на сервер (див. client/vite.config.js).
 * Ctrl+C зупиняє обох; якщо один процес завершився - зупиняється й інший.
 */

import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch', '--env-file-if-exists=.env', 'server/src/index.js'], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  }),
  spawn('npm', ['run', 'dev', '--workspace=client'], { stdio: 'inherit' }),
];

let stopping = false;
function stopAll(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
}

for (const child of children) {
  child.on('exit', (code) => {
    stopAll();
    if (!stopping || code) process.exitCode = code ?? 1;
  });
}
process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
