/**
 * Retry helper with configurable attempts and exponential fallback.
 * Shared across copy engine and worker job handlers.
 */

const NON_RETRYABLE_MESSAGES = [
  "insufficient",
  "Invalid",
  "too small",
  "already submitted",
];

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Don't retry on user/exchange errors that won't change on retry
      if (NON_RETRYABLE_MESSAGES.some((s) => msg.includes(s))) {
        throw err;
      }
      if (attempt < retries) {
        console.warn(`[retry] ${label} attempt ${attempt + 1} failed, retrying in ${delayMs}ms: ${msg}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
