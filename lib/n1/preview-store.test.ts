/**
 * preview-store tests — focused on the C5 fail-closed contract.
 *
 * The threat we're closing: user clicks "Execute" twice (network jitter,
 * impatience, a retry button). With the old code, if Postgres briefly
 * errored between the two requests:
 *
 *   1. Request A lands on Replica 1. consumePreview: PG errors, falls
 *      through to memStore (empty on this replica), returns null →
 *      route returns 400. Client retries.
 *   2. Meanwhile order was stored only in PG (PG was healthy at store
 *      time). Replica 2 might have the preview in its memStore if PG
 *      had been down at store time — but here PG was healthy at store.
 *
 * The dangerous case is when storePreview happened during a PG outage
 * (preview lives in Replica 1's memStore) and then PG comes back up
 * but a different replica is briefly seeing PG errors at consume time.
 * Replica 2 confused state could let an attacker burn a preview twice.
 *
 * Fix: PG error during consumePreview throws PreviewStoreUnavailableError.
 * The route returns 503 and refuses to execute. memStore lookup happens
 * only when PG explicitly returned zero rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrderPreview } from "./types";

process.env.DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";

const executeRawMock = vi.fn();
const queryRawMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
  },
}));

const { storePreview, consumePreview, PreviewStoreUnavailableError } =
  await import("./preview-store");

const STUB_PREVIEW: Omit<OrderPreview, "previewId"> = {
  market: "SOL-PERP",
  side: "Long",
  size: 1,
  leverage: 5,
  estimatedEntryPrice: 100,
  estimatedLiquidationPrice: 80,
  marginRequired: 20,
  estimatedFee: 0.05,
  priceImpact: 0,
  warnings: [],
};

describe("consumePreview — fail-closed on PG outage", () => {
  beforeEach(() => {
    executeRawMock.mockReset();
    queryRawMock.mockReset();
  });

  it("throws PreviewStoreUnavailableError when prisma errors", async () => {
    queryRawMock.mockRejectedValue(new Error("connection refused"));

    await expect(
      consumePreview("prev_deadbeef", "user-A"),
    ).rejects.toBeInstanceOf(PreviewStoreUnavailableError);
  });

  it("preserves the underlying cause", async () => {
    const underlying = new Error("ECONNREFUSED");
    queryRawMock.mockRejectedValue(underlying);

    await expect(consumePreview("prev_x", "user-A"))
      .rejects.toMatchObject({ cause: underlying });
  });

  it("returns the payload when PG deletes a row", async () => {
    const payload = { ...STUB_PREVIEW, previewId: "prev_real" };
    queryRawMock.mockResolvedValue([{ payload }]);

    const got = await consumePreview("prev_real", "user-A");
    expect(got).toEqual(payload);
  });

  it("returns null when PG returns zero rows AND memStore is empty", async () => {
    queryRawMock.mockResolvedValue([]);

    await expect(consumePreview("prev_missing", "user-A")).resolves.toBeNull();
  });

  it("falls through to memStore ONLY when PG returns zero rows (no error)", async () => {
    // PG outage at store time → memStore holds the preview.
    executeRawMock.mockRejectedValueOnce(new Error("PG briefly down"));
    const storedId = await storePreview(STUB_PREVIEW, "user-A");

    // PG healthy at consume time, but the row was never in PG.
    queryRawMock.mockResolvedValue([]);
    const got = await consumePreview(storedId, "user-A");
    expect(got?.previewId).toBe(storedId);

    // Single-use: a second consume returns null (memStore cleared).
    queryRawMock.mockResolvedValue([]);
    await expect(consumePreview(storedId, "user-A")).resolves.toBeNull();
  });

  it("does NOT fall through to memStore on PG error (the replay-replay window)", async () => {
    // PG outage at store time → memStore has the preview.
    executeRawMock.mockRejectedValueOnce(new Error("PG down at store"));
    const storedId = await storePreview(STUB_PREVIEW, "user-A");

    // PG still erroring at consume time. We must throw even though
    // memStore holds the row — a different replica reading memStore
    // could double-execute on chain.
    queryRawMock.mockRejectedValue(new Error("PG still down"));

    await expect(
      consumePreview(storedId, "user-A"),
    ).rejects.toBeInstanceOf(PreviewStoreUnavailableError);

    // Important: throwing must NOT have deleted the memStore entry.
    // Once PG recovers and returns zero rows, the legitimate retry
    // should still find the preview in memStore.
    queryRawMock.mockReset();
    queryRawMock.mockResolvedValue([]);
    const got = await consumePreview(storedId, "user-A");
    expect(got?.previewId).toBe(storedId);
  });

  it("ownership: PG zero rows + memStore entry for different user → null", async () => {
    executeRawMock.mockRejectedValueOnce(new Error("PG down at store"));
    const storedId = await storePreview(STUB_PREVIEW, "user-A");

    queryRawMock.mockResolvedValue([]);
    await expect(consumePreview(storedId, "user-B")).resolves.toBeNull();
  });
});
