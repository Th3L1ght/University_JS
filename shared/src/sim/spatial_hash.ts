/**
 * Просторова хеш-сітка (Spatial Hash Grid) для пошуку зіткнень за O(n) замість O(n²).
 *
 * Підтримує тороїдальну арену (wrap-around) і не створює нових масивів на кожному кроці:
 * комірки повторно використовуються, очищаються лише «брудні» комірки.
 * Пари дедуплікуються за індексами обходу, зберігаючи повний детермінізм симуляції.
 */

import { wrappedDelta } from './arena.ts';
import type { Entity } from './entity.ts';

function overlap(a: Entity, b: Entity, width: number, height: number): boolean {
  const dx = wrappedDelta(a.pos.x, b.pos.x, width);
  const dy = wrappedDelta(a.pos.y, b.pos.y, height);
  const reach = a.radius + b.radius;
  return dx * dx + dy * dy <= reach * reach;
}

interface IndexedEntry {
  readonly entity: Entity;
  readonly index: number;
}

export class SpatialHashGrid {
  #cellSize: number;
  #cells = new Map<number, IndexedEntry[]>();
  #dirty: IndexedEntry[][] = [];
  #seenPairs = new Set<number>();

  constructor(cellSize = 96) {
    this.#cellSize = cellSize;
  }

  #clear(): void {
    for (let i = 0; i < this.#dirty.length; i += 1) {
      const bucket = this.#dirty[i];
      if (bucket) bucket.length = 0;
    }
    this.#dirty.length = 0;
    this.#seenPairs.clear();
  }

  #insertIntoCell(cx: number, cy: number, entry: IndexedEntry): void {
    const key = ((cx & 0xffff) << 16) | (cy & 0xffff);
    let bucket = this.#cells.get(key);
    if (!bucket) {
      bucket = [];
      this.#cells.set(key, bucket);
    }
    if (bucket.length === 0) this.#dirty.push(bucket);
    bucket.push(entry);
  }

  queryPairs(
    entities: readonly Entity[],
    width: number,
    height: number,
  ): Array<readonly [Entity, Entity]> {
    this.#clear();
    const cs = this.#cellSize;
    const cols = Math.max(1, Math.ceil(width / cs));
    const rows = Math.max(1, Math.ceil(height / cs));

    for (let i = 0; i < entities.length; i += 1) {
      const entity = entities[i];
      if (!entity) continue;
      const entry: IndexedEntry = { entity, index: i };
      const minX = Math.floor((entity.pos.x - entity.radius) / cs);
      const maxX = Math.floor((entity.pos.x + entity.radius) / cs);
      const minY = Math.floor((entity.pos.y - entity.radius) / cs);
      const maxY = Math.floor((entity.pos.y + entity.radius) / cs);

      for (let gx = minX; gx <= maxX; gx += 1) {
        const wx = ((gx % cols) + cols) % cols;
        for (let gy = minY; gy <= maxY; gy += 1) {
          const wy = ((gy % rows) + rows) % rows;
          this.#insertIntoCell(wx, wy, entry);
        }
      }
    }

    const pairs: Array<readonly [Entity, Entity]> = [];
    const stride = entities.length + 1;

    for (let b = 0; b < this.#dirty.length; b += 1) {
      const bucket = this.#dirty[b];
      if (!bucket || bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        const a = bucket[i];
        if (!a) continue;
        for (let j = i + 1; j < bucket.length; j += 1) {
          const bEntry = bucket[j];
          if (!bEntry) continue;
          const lo = a.index < bEntry.index ? a : bEntry;
          const hi = a.index < bEntry.index ? bEntry : a;
          const pairKey = lo.index * stride + hi.index;
          if (this.#seenPairs.has(pairKey)) continue;
          this.#seenPairs.add(pairKey);
          if (overlap(lo.entity, hi.entity, width, height)) {
            pairs.push([lo.entity, hi.entity]);
          }
        }
      }
    }

    return pairs;
  }
}
