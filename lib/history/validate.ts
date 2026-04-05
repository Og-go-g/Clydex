/**
 * Safe integer parser for API query parameters.
 * Rejects NaN, Infinity, negative, and non-integer values.
 * Returns undefined when input is invalid (lets downstream use defaults).
 */
export function safeInt(val: string | null, fallback?: number): number | undefined {
  if (val === null || val === undefined || val === "") return fallback;
  const n = Number(val);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}
