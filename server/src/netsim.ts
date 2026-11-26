/**
 * Емулятор поганої мережі: затримка, джиттер і втрата пакетів для одного з'єднання.
 */

import type { NetsimState, Result } from '@dogfight/shared';

export const NETSIM_LIMITS = {
  latency: [0, 1000] as const,
  jitter: [0, 500] as const,
  drop: [0, 0.5] as const,
} as const;

export type NetsimKey = keyof typeof NETSIM_LIMITS;
export type NetsimPatch = Partial<NetsimState>;

const NETSIM_KEYS: readonly NetsimKey[] = ['latency', 'jitter', 'drop'];

export function parseNetsimParams(raw: Record<string, unknown>): Result<NetsimPatch, string> {
  const value: { latency?: number; jitter?: number; drop?: number } = {};
  for (const key of NETSIM_KEYS) {
    const [min, max] = NETSIM_LIMITS[key];
    const input = raw[key];
    if (input === undefined || input === null || input === '') continue;
    const num = typeof input === 'string' ? Number(input) : input;
    if (typeof num !== 'number' || !Number.isFinite(num) || num < min || num > max) {
      return { ok: false, error: `${key} має бути числом від ${min} до ${max}` };
    }
    value[key] = num;
  }
  return { ok: true, data: value };
}

export class NetSim {
  #random: () => number;
  #now: () => number;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #lastDeliverAt = { in: 0, out: 0 };

  latency: number;
  jitter: number;
  drop: number;

  constructor(
    params: NetsimPatch = {},
    {
      random = Math.random,
      now = () => performance.now(),
    }: { readonly random?: () => number; readonly now?: () => number } = {},
  ) {
    this.latency = params.latency ?? 0;
    this.jitter = params.jitter ?? 0;
    this.drop = params.drop ?? 0;
    this.#random = random;
    this.#now = now;
  }

  get active(): boolean {
    return this.latency > 0 || this.jitter > 0 || this.drop > 0;
  }

  update(params: NetsimPatch): void {
    if (params.latency !== undefined) this.latency = params.latency;
    if (params.jitter !== undefined) this.jitter = params.jitter;
    if (params.drop !== undefined) this.drop = params.drop;
  }

  toJSON(): NetsimState {
    return { latency: this.latency, jitter: this.jitter, drop: this.drop };
  }

  schedule(
    direction: 'in' | 'out',
    deliver: () => void,
    { lossy = true }: { readonly lossy?: boolean } = {},
  ): 'delivered' | 'delayed' | 'dropped' {
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

  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}
