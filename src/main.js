/**
 * Точка входу: зв'язує введення, симуляцію, рендер і ігровий цикл.
 */

import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { createShip, integrate } from './sim/ship.js';
import { wrapShip } from './sim/arena.js';
import { createCanvas } from './render/canvas.js';
import { drawFrame } from './render/draw.js';

const canvasElement = document.getElementById('game');
if (!canvasElement) throw new Error('В index.html немає елемента <canvas id="game">');

const { ctx, view } = createCanvas(canvasElement);
const input = createInput(window);
const ship = createShip(view.width / 2, view.height / 2);

// Клавіша вважається активною, якщо її утримують або натиснули від минулого кроку:
// так короткий тап між двома кроками симуляції не губиться.
const active = (...codes) => codes.some((code) => input.isDown(code) || input.justPressed(code));

function readControls() {
  return {
    left: active('ArrowLeft', 'KeyA'),
    right: active('ArrowRight', 'KeyD'),
    thrust: active('ArrowUp', 'KeyW'),
  };
}

function simulate(dt) {
  integrate(ship, readControls(), dt);
  wrapShip(ship, view.width, view.height);
  input.endStep();
}

function render(alpha, metrics) {
  drawFrame(ctx, view, ship, alpha, metrics, performance.now());
}

createLoop({ simulate, render }).start();
