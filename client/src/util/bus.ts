/**
 * Суворо типізована шина подій `Bus<E>` (заміна нетипізованого EventTarget/CustomEvent).
 *
 * `on<K extends keyof E>` і `emit<K extends keyof E>` на етапі компіляції гарантують,
 * що ім'я події існує в карті `E` і тип payload точно відповідає `E[K]`.
 * Жодного `any` і жодного `as` — лише mapped type `ListenerMap<E>`.
 */

type Listener<T> = (payload: T) => void;
type ListenerMap<E extends object> = { [K in keyof E]?: Set<Listener<E[K]>> };

export class Bus<E extends object> {
  #listeners: ListenerMap<E> = {};

  /** Підписується на подію `event` і повертає функцію відписки. */
  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    const existing = this.#listeners[event];
    const set = existing ?? new Set<Listener<E[K]>>();
    if (!existing) this.#listeners[event] = set;
    set.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.#listeners[event]?.delete(listener);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.#listeners[event];
    if (!set) return;
    for (const listener of [...set]) listener(payload);
  }

  clear(): void {
    this.#listeners = {};
  }
}

/** Типізована карта ігрових подій (симуляція / netcode -> звук, HUD). */
export interface GameEvents {
  fired: { readonly missile: boolean };
  hit: { readonly target: { readonly kind: string }; readonly destroyed: boolean };
  exploded: {
    readonly kind: string;
    readonly size: number;
    readonly x?: number;
    readonly y?: number;
  };
  pickup: { readonly effect: { readonly type: string } };
  scoreChanged: { readonly score: number; readonly delta: number };
}
