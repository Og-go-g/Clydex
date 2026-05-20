/**
 * sync_cursors advance contract (C6 audit item).
 *
 * Before this fix, `syncAllHistory` advanced the cursor to NOW() inside
 * the same try block where the sync function ran. The thrown-error path
 * already worked (catch → no setCursor), but if a sync function ever
 * returned a SyncResult with `error` set or `hasMore: true` the cursor
 * would jump anyway — silently losing the window between the last good
 * page and NOW for every wallet that hit a partial failure. Affected
 * leaderboard PnL accuracy with no visible signal.
 *
 * Fix lives in a tiny pure helper, `shouldAdvanceCursor`, that the two
 * dispatcher functions share. The audit's acceptance criterion is
 * "simulate fetchPage throwing on page 3; verify cursor unchanged" —
 * that path is exercised by the catch block (no setCursor inside the
 * catch). What this unit test pins down is the OTHER path: a non-
 * throwing partial failure.
 */

import { describe, it, expect } from "vitest";
import type { SyncResult } from "./types";

// sync.ts pulls in lib/db-history at module load and requires the
// HISTORY_DATABASE_URL env var. Stub it before the import to keep this
// unit test self-contained — we never touch the pool here, the assertion
// is purely on shouldAdvanceCursor's logic.
process.env.HISTORY_DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";

const { shouldAdvanceCursor } = await import("./sync");

function r(partial: Partial<SyncResult>): SyncResult {
  return { type: "trades", inserted: 0, hasMore: false, ...partial };
}

describe("shouldAdvanceCursor", () => {
  it("advances on a fully clean sync (hasMore=false, no error)", () => {
    expect(shouldAdvanceCursor(r({ inserted: 42, hasMore: false }))).toBe(true);
  });

  it("does NOT advance when the sync reports more pages", () => {
    expect(shouldAdvanceCursor(r({ inserted: 50, hasMore: true }))).toBe(false);
  });

  it("does NOT advance when the sync surfaced a soft error", () => {
    expect(
      shouldAdvanceCursor(r({ inserted: 25, hasMore: false, error: "timeout on page 3" })),
    ).toBe(false);
  });

  it("does NOT advance when both flags say something went wrong", () => {
    expect(
      shouldAdvanceCursor(r({ inserted: 25, hasMore: true, error: "rate limited" })),
    ).toBe(false);
  });

  it("treats empty inserts (no new rows) as still-clean — advance", () => {
    // An account with no new history since the cursor returns inserted: 0
    // but hasMore: false. We want the cursor to move to NOW() so the next
    // cycle starts from the latest time instead of re-paginating empty
    // pages forever.
    expect(shouldAdvanceCursor(r({ inserted: 0, hasMore: false }))).toBe(true);
  });
});
