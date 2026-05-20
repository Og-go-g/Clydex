/**
 * nonce-store tests — focused on the fail-closed contract introduced for
 * the 2026-05-17 C2 audit item.
 *
 * The threat we're guarding against: an attacker who captured a complete
 * SIWS bundle (message + signature) replaying it against /api/auth/login
 * during a transient Postgres outage. If `consumeNonce` swallowed the PG
 * error and fell through to memTake, a multi-replica deploy could be
 * tricked because each replica's memStore is per-process and may not
 * know the nonce was already burned elsewhere.
 *
 * The fix is asymmetric:
 *   - storeNonce stays best-effort (PG fail → memSet; single-process happy
 *     path still works).
 *   - consumeNonce is strict: PG error → throw NonceStoreUnavailableError.
 *     PG returning zero rows is NOT an error — it just means the nonce isn't
 *     in PG, and we fall through to memTake (the legitimate use case for
 *     in-memory backing during a prior store-time outage).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";

const executeRawMock = vi.fn();
const queryRawMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
  },
}));

const { consumeNonce, storeNonce, NonceStoreUnavailableError } = await import(
  "./nonce-store"
);

describe("consumeNonce — fail-closed on PG outage", () => {
  beforeEach(() => {
    executeRawMock.mockReset();
    queryRawMock.mockReset();
  });

  it("throws NonceStoreUnavailableError when prisma errors", async () => {
    queryRawMock.mockRejectedValue(new Error("connection refused"));

    await expect(consumeNonce("nonce-during-outage")).rejects.toBeInstanceOf(
      NonceStoreUnavailableError,
    );
  });

  it("preserves the underlying cause on the thrown error", async () => {
    const underlying = new Error("ECONNREFUSED 127.0.0.1:5432");
    queryRawMock.mockRejectedValue(underlying);

    await expect(consumeNonce("nonce-x"))
      .rejects.toMatchObject({ cause: underlying });
  });

  it("returns true when PG deletes one row", async () => {
    queryRawMock.mockResolvedValue([{ value: "nonce-real" }]);

    await expect(consumeNonce("nonce-real")).resolves.toBe(true);
  });

  it("returns false when PG returns zero rows AND nonce is not in memStore", async () => {
    queryRawMock.mockResolvedValue([]);

    await expect(consumeNonce("never-stored")).resolves.toBe(false);
  });

  it("falls through to memStore when PG returns zero rows (legitimate use)", async () => {
    // Simulate: pgStoreNonce previously failed → memSet ran. Now PG is
    // healthy again but the row doesn't exist in PG. consumeNonce must
    // see the in-memory copy.
    executeRawMock.mockRejectedValueOnce(new Error("PG was briefly down"));
    queryRawMock.mockResolvedValue([]);

    await storeNonce("nonce-in-mem-only");
    await expect(consumeNonce("nonce-in-mem-only")).resolves.toBe(true);
  });

  it("does NOT fall through to memStore when PG errors (replay-replay vector closed)", async () => {
    // Sequence:
    //   1. storeNonce — PG also unavailable → memSet runs.
    //   2. consumeNonce — PG STILL erroring. Even though memStore has the
    //      nonce, we must reject with NonceStoreUnavailableError rather
    //      than letting memTake return true. Briefly blocking logins is
    //      the documented UX cost of closing the replay window.
    executeRawMock.mockRejectedValueOnce(new Error("PG down"));
    queryRawMock.mockRejectedValue(new Error("PG still down"));

    await storeNonce("captured-bundle-nonce");
    await expect(consumeNonce("captured-bundle-nonce"))
      .rejects.toBeInstanceOf(NonceStoreUnavailableError);
  });
});
