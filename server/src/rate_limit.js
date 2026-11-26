/**
 * Token bucket: ліміт частоти повідомлень на одне з'єднання.
 * У відра `capacity` жетонів (дозволений сплеск), воно поповнюється зі швидкістю
 * `refillPerSec` жетонів на секунду. Кожне повідомлення коштує один жетон.
 */
export class TokenBucket {
  #tokens;
  #last;

  /**
   * @param {object} options
   * @param {number} options.capacity максимальний сплеск
   * @param {number} options.refillPerSec стала швидкість, повідомлень/с
   * @param {() => number} [options.now] годинник у мс (підміняється в тестах)
   */
  constructor({ capacity, refillPerSec, now = () => performance.now() }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  /** @returns {boolean} true - повідомлення дозволено, false - ліміт перевищено */
  take(cost = 1) {
    const current = this.now();
    const elapsedSec = Math.max(0, current - this.#last) / 1000;
    this.#last = current;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsedSec * this.refillPerSec);
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }

  get tokens() {
    return this.#tokens;
  }
}
