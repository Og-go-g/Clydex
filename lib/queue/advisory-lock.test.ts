/**
 * Pure-function smoke test for the advisory lock key encoding.
 *
 * Why this test exists: the lock keyspace lives in the same 64-bit
 * namespace as the copy engine's leader hash locks. A regression in the
 * NS offset or the bit-shift would let two unrelated jobs collide on the
 * same key — the kind of bug that's quiet (just a "skipped, locked
 * elsewhere" log line) but wrong (account refresh blocked by an unrelated
 * copy-engine lock and vice versa).
 *
 * The actual lock acquire/release behavior is exercised at deploy time
 * by the post-migration verification SQL — mocking pg's session-scope
 * advisory locks correctly is harder than just running them on the
 * staging DB once.
 */

import { describe, it, expect } from "vitest";

// Stub the env var before the module under test loads its pg pool —
// `accountIdToLockKey` itself is a pure function but it lives next to
// `withAccountLock`, which constructs the pool on import.
process.env.HISTORY_DATABASE_URL ??= "postgresql://stub:stub@localhost:1/stub";

const { accountIdToLockKey } = await import("./advisory-lock");

// BigInt literals (`123n`) need ES2020+; the project's tsconfig is older,
// so we construct via `BigInt(...)` to match the source module's style.
const U32_MASK = BigInt("0xffffffff");
const NS_MARKER = BigInt("0xc1d7");
const SHIFT_32 = BigInt(32);

describe("accountIdToLockKey", () => {
  it("places the NS marker in the upper 16 bits", () => {
    // NS_MARKER << 32 = the NS prefix; lower 32 bits should be the accountId.
    const key = accountIdToLockKey(1);
    expect(key & U32_MASK).toBe(BigInt(1));
    expect(key >> SHIFT_32).toBe(NS_MARKER);
  });

  it("survives the largest realistic accountId (uint32 max)", () => {
    const max = 0xffffffff;
    const key = accountIdToLockKey(max);
    expect(key & U32_MASK).toBe(BigInt(max));
    expect(key >> SHIFT_32).toBe(NS_MARKER);
  });

  it("encodes negative accountIds via uint32 cast (defensive — should never happen, but shouldn't blow up)", () => {
    // -1 >>> 0 === 0xffffffff in JS — the function relies on this coercion.
    const key = accountIdToLockKey(-1);
    expect(key & U32_MASK).toBe(U32_MASK);
    expect(key >> SHIFT_32).toBe(NS_MARKER);
  });

  it("produces distinct keys for distinct accountIds", () => {
    const a = accountIdToLockKey(3560);
    const b = accountIdToLockKey(3561);
    expect(a).not.toBe(b);
  });

  it("never collides with the copy engine's leader-hash keyspace", () => {
    // Copy engine uses 32-bit hashes of leaderAddr (no NS prefix). Our
    // keys always have 0xC1D7 in bits 32-47, so they're unreachable from
    // a pure 32-bit hash.
    const key = accountIdToLockKey(0);
    const copyEngineMaxKey = U32_MASK; // u32 hash, no upper bits set
    expect(key > copyEngineMaxKey).toBe(true);
  });
});
