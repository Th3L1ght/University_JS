/**
 * Брендовані примітиви та загальні утилітарні типи.
 *
 * Брендований тип (`number & { readonly __brand: ... }`) у рантаймі залишається звичайним
 * числом (нульові накладні витрати), але компілятор забороняє передати `Tick` замість
 * `EntityId` чи `Seq` замість `Tick`.
 */

export type EntityId = number & { readonly __brand: 'EntityId' };
export type Tick = number & { readonly __brand: 'Tick' };
export type Seq = number & { readonly __brand: 'Seq' };

/** Конструктор брендованого ідентифікатора сутності (0 означає "ще не додано у світ"). */
export function asEntityId(value: number): EntityId {
  // Єдина точка брендування числа в EntityId після нормалізації до u32.
  return (value >>> 0) as EntityId;
}

/** Конструктор брендованого номера тіка симуляції. */
export function asTick(value: number): Tick {
  // Єдина точка брендування числа в Tick після нормалізації до u32.
  return (value >>> 0) as Tick;
}

/** Конструктор брендованого номера команди вводу (sequence number). */
export function asSeq(value: number): Seq {
  // Єдина точка брендування числа в Seq після нормалізації до u32.
  return (value >>> 0) as Seq;
}

/** Вичерпна перевірка у гілці default switch: компілятор відхилить необроблений варіант. */
export function assertNever(value: never, context = 'unexpected value'): never {
  throw new Error(`${context}: ${String(value)}`);
}

/** Універсальний результат операції без винятків. */
export type Result<T, E = string> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: E };
