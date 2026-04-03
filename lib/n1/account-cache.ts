import { getUser } from "./client";

/**
 * Server-side cache: wallet address → N1 account ID.
 * Account IDs don't change, so we cache aggressively (5 min TTL).
 */
const cache = new Map<string, { accountId: number; time: number }>();
const TTL = 300_000;
const MAX_SIZE = 1_000;

export async function getCachedAccountId(address: string): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(address);
  if (cached && now - cached.time < TTL) {
    return cached.accountId;
  }

  const user = await getUser(address);
  if (!user || !user.accountIds?.length) return null;
  const accountId = user.accountIds[0];

  // Evict oldest entries if cache is at capacity
  while (cache.size >= MAX_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of cache) {
      if (entry.time < oldestTime) {
        oldestTime = entry.time;
        oldestKey = key;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
    else break;
  }

  cache.set(address, { accountId, time: now });
  return accountId;
}
