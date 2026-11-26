/**
 * Експоненційний backoff із джитером («рівний джитер»): половина затримки фіксована, половина
 * випадкова. Спільний для повторів запитів (withRetry) і перепідключення WebSocket.
 *
 * @param {number} attempt номер невдалої спроби, починаючи з 1
 * @param {{ baseMs?: number, maxMs?: number }} [options]
 * @param {() => number} [random] джерело [0, 1)
 * @returns {number} затримка перед наступною спробою, мс
 */
export function backoffDelay(
  attempt,
  { baseMs = 200, maxMs = Infinity } = {},
  random = Math.random,
) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}
