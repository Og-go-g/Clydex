import { prisma } from "../db";

/* ------------------------------------------------------------------ */
/*  Close-position lock store — per-(wallet, market, side) lock.       */
/* ------------------------------------------------------------------ */
//
// The browser-side `closingMarkets` Set in useOrderExecution is per-tab
// and can be bypassed by opening the portfolio in two tabs. The Nord
// SDK's reduce-only flag prevents over-closing the same direction, but
// it does NOT protect against a race that flips the position sign
// between the two reads — the second close can land as an OPENING order
// in the opposite direction. This server-side lock is the authoritative
// serialisation.
//
// Atomicity: INSERT ... ON CONFLICT (key) DO UPDATE ... WHERE the existing
// row has already expired. The UPDATE row count tells us whether we won
// the lock. If neither INSERT nor UPDATE applied, the lock is held by
// someone else and we refuse.

const TTL_S = 30;

/**
 * Try to claim a close-lock. Returns true if acquired (or already owned by
 * this same context — caller is expected to release before re-acquiring).
 * Returns false if another holder owns a non-expired lock.
 *
 * Best-effort under PG outage: if the DB call fails we let the caller
 * proceed. The blast radius of a missed lock during a brief PG hiccup is
 * acceptable; the alternative (refusing every close) is worse.
 */
export async function acquireCloseLock(
  walletAddr: string,
  marketSymbol: string,
  side: "Long" | "Short",
): Promise<boolean> {
  const key = makeKey(walletAddr, marketSymbol, side);
  try {
    const rows = await prisma.$queryRaw<{ key: string }[]>`
      INSERT INTO close_locks (key, expires_at)
      VALUES (${key}, NOW() + (${TTL_S}::int * INTERVAL '1 second'))
      ON CONFLICT (key) DO UPDATE
        SET expires_at = NOW() + (${TTL_S}::int * INTERVAL '1 second')
        WHERE close_locks.expires_at < NOW()
      RETURNING key;
    `;
    return rows.length > 0;
  } catch (err) {
    console.warn(
      "[close-lock] acquire failed, allowing close:",
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

/**
 * Release a previously-acquired close-lock. Safe to call even if no row
 * exists — we just want the key to disappear.
 */
export async function releaseCloseLock(
  walletAddr: string,
  marketSymbol: string,
  side: "Long" | "Short",
): Promise<void> {
  const key = makeKey(walletAddr, marketSymbol, side);
  try {
    await prisma.$executeRaw`DELETE FROM close_locks WHERE key = ${key};`;
  } catch (err) {
    console.warn(
      "[close-lock] release failed (will expire via TTL):",
      err instanceof Error ? err.message : err,
    );
  }
}

function makeKey(
  walletAddr: string,
  marketSymbol: string,
  side: "Long" | "Short",
): string {
  // Normalise to defeat trivial bypass attempts via case toggling.
  return `${walletAddr}:${marketSymbol.toUpperCase()}:${side}`;
}
