/**
 * Чистий стан і фізика судна. Жодних залежностей від DOM і Canvas:
 * функції детерміновані й тестуються в Node.
 *
 * Одиниці: пікселі, секунди, радіани. Кут 0 спрямований уздовж +X, додатний - за годинниковою
 * стрілкою на екрані (вісь Y спрямована вниз).
 */

import { wrapAngle } from '../math.js';

export const SHIP_PARAMS = Object.freeze({
  turnRate: 3.4, // рад/с: повний оберт за ~1.85 с
  thrustAccel: 420, // пкс/с²: прискорення від двигуна
  drag: 0.75, // 1/с: коефіцієнт лінійного опору
  maxSpeed: 480, // пкс/с: жорстка стеля швидкості
});

export function createShip(x = 0, y = 0, angle = -Math.PI / 2) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    thrust: 0,
    prevX: x,
    prevY: y,
    prevAngle: angle,
  };
}

/**
 * Один крок симуляції (напівнеявний Ейлер: спочатку швидкість, потім позиція).
 * Перед зміною стану поточний копіюється в prev* - для інтерполяції в render.
 *
 * @param {ReturnType<typeof createShip>} ship змінюється на місці
 * @param {{ left: boolean, right: boolean, thrust: boolean }} controls
 * @param {number} dt крок, секунди
 * @param {typeof SHIP_PARAMS} [params]
 */
export function integrate(ship, controls, dt, params = SHIP_PARAMS) {
  ship.prevX = ship.x;
  ship.prevY = ship.y;
  ship.prevAngle = ship.angle;

  const turn = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
  ship.angle = wrapAngle(ship.angle + turn * params.turnRate * dt);

  ship.thrust = controls.thrust ? 1 : 0;
  if (ship.thrust) {
    ship.vx += Math.cos(ship.angle) * params.thrustAccel * dt;
    ship.vy += Math.sin(ship.angle) * params.thrustAccel * dt;
  }

  // Експоненційне згасання v *= e^(-drag*dt): не залежить від розміру кроку.
  const damping = Math.exp(-params.drag * dt);
  ship.vx *= damping;
  ship.vy *= damping;

  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > params.maxSpeed) {
    const k = params.maxSpeed / speed;
    ship.vx *= k;
    ship.vy *= k;
  }

  ship.x += ship.vx * dt;
  ship.y += ship.vy * dt;
}
