/**
 * Token bucket: ліміт частоти повідомлень на одне з'єднання.
 */

export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillPerSec: number;
  readonly now?: () => number;
}

export class TokenBucket {
  #tokens: number;
  #last: number;
  readonly capacity: number;
  readonly refillPerSec: number;
  readonly now: () => number;

  constructor({ capacity, refillPerSec, now = () => performance.now() }: TokenBucketOptions) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  /** @returns true - повідомлення дозволено, false - ліміт перевищено */
  take(cost = 1): boolean {
    const current = this.now();
    const elapsedSec = Math.max(0, current - this.#last) / 1000;
    this.#last = current;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsedSec * this.refillPerSec);
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }

  get tokens(): number {
    return this.#tokens;
  }
}
