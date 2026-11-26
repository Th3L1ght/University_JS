/**
 * Введення з клавіатури на замиканнях. Стан (два приватні Set) недоступний ззовні.
 * Коди клавіш - KeyboardEvent.code (фізичні клавіші, не залежать від розкладки).
 */

const PREVENT_DEFAULT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

/**
 * @param {Window | HTMLElement} [target]
 * @returns {{
 *   isDown: (code: string) => boolean,
 *   justPressed: (code: string) => boolean,
 *   endStep: () => void,
 *   destroy: () => void
 * }}
 */
export function createInput(target = window) {
  const down = new Set(); // клавіші, що утримуються зараз
  const pressed = new Set(); // клавіші, натиснуті від останнього endStep()

  function onKeyDown(event) {
    if (PREVENT_DEFAULT.has(event.code)) event.preventDefault();
    if (event.repeat) return;
    if (!down.has(event.code)) pressed.add(event.code);
    down.add(event.code);
  }

  function onKeyUp(event) {
    down.delete(event.code);
  }

  // Втрата фокуса не надсилає keyup: без скидання судно й далі «тримало» б клавішу.
  function onBlur() {
    down.clear();
    pressed.clear();
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    /** Викликається після кожного кроку симуляції: скидає одноразові натискання. */
    endStep: () => pressed.clear(),
    destroy() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
