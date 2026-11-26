/**
 * Емулятор поганої мережі: затримка, джиттер і втрата пакетів для одного з'єднання.
 *
 * Дозволяє відтворити реальний пінг на localhost. Параметри (в обидва боки незалежно):
 *   latency - додаткова затримка в одну сторону, мс (RTT збільшується приблизно на 2·latency);
 *   jitter  - випадкове відхилення затримки ±jitter мс;
 *   drop    - імовірність втрати пакета [0, 1].
 *
 * Порядок доставки зберігається (як у TCP/WebSocket): пакет не може обігнати попередній,
 * тож джиттер дає "ривки", а не перестановки. Втрата ж видаляє пакет остаточно - так поводиться
 * UDP-подібний ігровий трафік; тому drop діє лише на бінарні/ігрові кадри (вхід, знімки, ping),
 * а керувальні JSON-повідомлення (join, chat, ...) не губляться.
 */

export const NETSIM_LIMITS = Object.freeze({
  latency: [0, 1000],
  jitter: [0, 500],
  drop: [0, 0.5],
});

/**
 * Перевіряє й нормалізує параметри емуляції.
 * @param {Record<string, unknown>} raw
 * @returns {{ ok: true, value: { latency?: number, jitter?: number, drop?: number } } | { ok: false, error: string }}
 */
export function parseNetsimParams(raw) {
  const value = {};
  for (const [key, [min, max]] of Object.entries(NETSIM_LIMITS)) {
    const input = raw[key];
    if (input === undefined || input === null || input === '') continue;
    const number = typeof input === 'string' ? Number(input) : input;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
      return { ok: false, error: `${key} має бути числом від ${min} до ${max}` };
    }
    value[key] = number;
  }
  return { ok: true, value };
}

export class NetSim {
  #random;
  #now;
  #timers = new Set();
  #lastDeliverAt = { in: 0, out: 0 };

  /**
   * @param {{ latency?: number, jitter?: number, drop?: number }} [params]
   * @param {{ random?: () => number, now?: () => number }} [deps] залежності (тести)
   */
  constructor(params = {}, { random = Math.random, now = () => performance.now() } = {}) {
    this.latency = params.latency ?? 0;
    this.jitter = params.jitter ?? 0;
    this.drop = params.drop ?? 0;
    this.#random = random;
    this.#now = now;
  }

  get active() {
    return this.latency > 0 || this.jitter > 0 || this.drop > 0;
  }

  update(params) {
    if (params.latency !== undefined) this.latency = params.latency;
    if (params.jitter !== undefined) this.jitter = params.jitter;
    if (params.drop !== undefined) this.drop = params.drop;
  }

  toJSON() {
    return { latency: this.latency, jitter: this.jitter, drop: this.drop };
  }

  /**
   * Виконує `deliver` із затримкою або губить пакет.
   * @param {'in' | 'out'} direction напрямок (порядок зберігається окремо в кожному)
   * @param {() => void} deliver
   * @param {{ lossy?: boolean }} [options] lossy: false - пакет не можна втратити
   * @returns {'delivered' | 'delayed' | 'dropped'}
   */
  schedule(direction, deliver, { lossy = true } = {}) {
    if (!this.active) {
      deliver();
      return 'delivered';
    }
    if (lossy && this.drop > 0 && this.#random() < this.drop) return 'dropped';

    const jitter = this.jitter > 0 ? (this.#random() * 2 - 1) * this.jitter : 0;
    const now = this.#now();
    const at = Math.max(this.#lastDeliverAt[direction], now + Math.max(0, this.latency + jitter));
    this.#lastDeliverAt[direction] = at;

    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        deliver();
      },
      Math.max(0, at - now),
    );
    this.#timers.add(timer);
    return 'delayed';
  }

  /** Скасовує всі відкладені пакети (з'єднання закрито). */
  dispose() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}
