/**
 * Узагальнений пул об'єктів (ObjectPool<T>) для гарячих шляхів без зайвих алокацій.
 * Зменшує навантаження на V8 GC під час інтенсивного бою (кулі, вибухи).
 */

export interface PoolStats {
  readonly allocated: number;
  readonly acquired: number;
  readonly recycled: number;
  readonly available: number;
}

export class ObjectPool<T> {
  #factory: () => T;
  #maxSize: number;
  #free: T[] = [];
  #allocated = 0;
  #acquired = 0;
  #recycled = 0;

  constructor(factory: () => T, { maxSize = 512, preallocate = 0 } = {}) {
    this.#factory = factory;
    this.#maxSize = maxSize;
    for (let i = 0; i < preallocate; i += 1) {
      this.#free.push(this.#factory());
      this.#allocated += 1;
    }
  }

  acquire(): T {
    this.#acquired += 1;
    const item = this.#free.pop();
    if (item !== undefined) {
      this.#recycled += 1;
      return item;
    }
    this.#allocated += 1;
    return this.#factory();
  }

  release(item: T): void {
    if (this.#free.length < this.#maxSize) {
      this.#free.push(item);
    }
  }

  get stats(): PoolStats {
    return {
      allocated: this.#allocated,
      acquired: this.#acquired,
      recycled: this.#recycled,
      available: this.#free.length,
    };
  }
}
