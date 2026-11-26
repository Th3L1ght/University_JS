/**
 * Введення з клавіатури на замиканнях. Коди клавіш - KeyboardEvent.code.
 */

const PREVENT_DEFAULT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export interface InputController {
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
  endStep(): void;
  destroy(): void;
}

export function createInput(target: Window | HTMLElement = window): InputController {
  const down = new Set<string>();
  const pressed = new Set<string>();

  function onKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (PREVENT_DEFAULT.has(event.code)) event.preventDefault();
    if (event.repeat) return;
    if (!down.has(event.code)) pressed.add(event.code);
    down.add(event.code);
  }

  function onKeyUp(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    down.delete(event.code);
  }

  function onBlur(): void {
    down.clear();
    pressed.clear();
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endStep: () => pressed.clear(),
    destroy() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
