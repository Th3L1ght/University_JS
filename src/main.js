/**
 * Точка входу: зв'язує введення, світ, рендер і ігровий цикл.
 */

import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { Ship } from './sim/ship.js';
import { World } from './sim/world.js';
import { createCanvas } from './render/canvas.js';
import { drawFrame } from './render/draw.js';

const canvasElement = document.getElementById('game');
if (!canvasElement) throw new Error('В index.html немає елемента <canvas id="game">');

const { ctx, view } = createCanvas(canvasElement);
const input = createInput(window);

const world = new World({ width: view.width, height: view.height, seed: 20261116 });
const ship = new Ship({ x: view.width / 2, y: view.height / 2 });
world.setPlayer(ship);
world.populate();

// Клавіша вважається активною, якщо її утримують або натиснули від минулого кроку:
// так короткий тап між двома кроками симуляції не губиться.
const active = (codes) => codes.some((code) => input.isDown(code) || input.justPressed(code));
const justPressed = (codes) => codes.some((code) => input.justPressed(code));

// Таблиця прив'язок "клавіша -> дія". `run` викликається як `binding.run()`, тобто з
// this === binding. Тому методи судна передаються лише завдяки прив'язці в конструкторі
// Ship: без неї this усередині fire() був би об'єктом-прив'язкою, а не судном.
const bindings = [
  { codes: ['Space'], held: true, run: ship.fire },
  { codes: ['KeyX', 'KeyE'], held: false, run: ship.fireMissile },
];

function readControls() {
  return {
    left: active(['ArrowLeft', 'KeyA']),
    right: active(['ArrowRight', 'KeyD']),
    thrust: active(['ArrowUp', 'KeyW']),
  };
}

function simulate(dt) {
  for (const binding of bindings) {
    if (binding.held ? active(binding.codes) : justPressed(binding.codes)) binding.run();
  }
  world.setSize(view.width, view.height);
  world.step(dt, readControls());
  input.endStep();
}

function render(alpha, metrics) {
  drawFrame(ctx, view, world, alpha, metrics, performance.now());
}

createLoop({ simulate, render }).start();
