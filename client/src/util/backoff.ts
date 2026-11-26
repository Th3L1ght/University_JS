/**
 * Експоненційний backoff із джитером («рівний джитер»).
 */

export interface BackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
}

export function backoffDelay(
  attempt: number,
  { baseMs = 200, maxMs = Infinity }: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}
