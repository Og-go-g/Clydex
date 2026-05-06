"use client";

/**
 * Live readers for "is this orderId still open?" / "is this position
 * still open?" — purpose-built for chat cards that may sit on screen
 * for days after the underlying order/position actually changed state
 * via another channel (portfolio cancel button, automatic fill,
 * liquidation, etc).
 *
 * The cards' local state alone (`useState("idle" | "confirmed" | …)`)
 * doesn't know about anything that happens off-card. Without these
 * hooks the user can stare at an orange "Cancel Order" button for a
 * trade that was filled four days ago — confirmed by the user as the
 * exact symptom that prompted this audit.
 *
 * Architecture:
 *   - One module-level cache shared by all subscribers (a chat with
 *     20 cards must NOT fan out 20 parallel /api/account fetches).
 *   - Refresh trigger is the Nord WS account-event signal (Phase 8b
 *     pattern): subscribe via ws-manager once, debounce, then refetch
 *     /api/account. The aggregate REST blob stays the source of truth
 *     — WS is purely a "something changed, time to re-poll" tap.
 *   - Backstop polling at 60 s in case the WS disconnects without
 *     anyone noticing yet.
 *   - Visibility-aware: silent when the tab is hidden; refreshes on
 *     focus return if cache is stale.
 */

import { useEffect, useState } from "react";
import { getNordWsManager } from "@/lib/n1/ws-manager";

type AccountSnapshot = {
  exists: boolean;
  accountId: number | null;
  openOrderIds: Set<number>;
  positionsBySymbol: Map<string, { isLong: boolean; absSize: number }>;
  fetchedAt: number;
};

const BACKSTOP_POLL_MS = 60_000;
const STALE_AFTER_MS = 30_000;
const WS_DEBOUNCE_MS = 250;

let cached: AccountSnapshot | null = null;
let cachePromise: Promise<AccountSnapshot> | null = null;
const subscribers = new Set<(s: AccountSnapshot) => void>();

let backstopTimer: ReturnType<typeof setInterval> | null = null;
let wsUnsub: (() => void) | null = null;
let wsAccountIdSubscribed: number | null = null;
let wsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityListenerAttached = false;

function normalizeSymbol(s: string): string {
  // Accept both "ETH/USD" and "ETHUSD"; downstream callers may pass either.
  return (s ?? "").replace("/", "").toUpperCase();
}

interface RawOrder {
  orderId?: number;
  id?: number;
}

interface RawPosition {
  symbol?: string;
  perp?: { baseSize?: number; isLong?: boolean };
}

async function fetchSnapshot(): Promise<AccountSnapshot> {
  // De-dupe in-flight requests. If two cards mount in the same render
  // tick they'll both await the same promise rather than firing two
  // /api/account calls.
  if (cachePromise) return cachePromise;

  cachePromise = (async () => {
    try {
      const res = await fetch(`/api/account?_t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) {
        // Don't trash a previously-good cache on transient failure.
        return cached ?? {
          exists: false,
          accountId: null,
          openOrderIds: new Set<number>(),
          positionsBySymbol: new Map(),
          fetchedAt: Date.now(),
        };
      }
      const data = await res.json();
      const orders = (data.orders ?? data.openOrders ?? []) as RawOrder[];
      const openOrderIds = new Set<number>();
      for (const o of orders) {
        const id = Number(o.orderId ?? o.id);
        if (Number.isFinite(id)) openOrderIds.add(id);
      }
      const positions = (data.positions ?? []) as RawPosition[];
      const positionsBySymbol = new Map<string, { isLong: boolean; absSize: number }>();
      for (const p of positions) {
        const baseSize = Number(p.perp?.baseSize ?? 0);
        if (Math.abs(baseSize) < 1e-12) continue;
        const sym = normalizeSymbol(p.symbol ?? "");
        if (!sym) continue;
        positionsBySymbol.set(sym, {
          isLong: p.perp?.isLong ?? baseSize > 0,
          absSize: Math.abs(baseSize),
        });
      }
      const accountId = typeof data.accountId === "number" && data.accountId > 0
        ? data.accountId
        : null;
      const snap: AccountSnapshot = {
        exists: !!data.exists,
        accountId,
        openOrderIds,
        positionsBySymbol,
        fetchedAt: Date.now(),
      };
      cached = snap;
      // Now that we know the accountId, subscribe to its account WS
      // stream. Idempotent — if we're already subscribed to the same
      // id, this is a no-op.
      ensureWsSubscribed(accountId);
      for (const fn of subscribers) {
        try { fn(snap); } catch (err) { console.error("[useLiveAccountState] subscriber threw:", err); }
      }
      return snap;
    } finally {
      cachePromise = null;
    }
  })();

  return cachePromise;
}

function scheduleRefetchDebounced(): void {
  if (wsDebounceTimer) return;
  wsDebounceTimer = setTimeout(() => {
    wsDebounceTimer = null;
    void fetchSnapshot();
  }, WS_DEBOUNCE_MS);
}

function ensureWsSubscribed(accountId: number | null): void {
  if (typeof window === "undefined") return;
  if (accountId === null) return;
  if (wsAccountIdSubscribed === accountId && wsUnsub) return;
  // Account changed (rare — wallet swap) or first attach
  if (wsUnsub) {
    wsUnsub();
    wsUnsub = null;
  }
  try {
    wsUnsub = getNordWsManager().subscribeAccount(accountId, () => {
      // WS doesn't carry the full account state we need — just signals
      // that SOMETHING changed. Debounced refetch via REST is the
      // source of truth (Phase 8b convention).
      scheduleRefetchDebounced();
    });
    wsAccountIdSubscribed = accountId;
  } catch (err) {
    // subscribeAccount throws on invalid accountId. Log and fall back
    // to backstop polling — better than the whole hook breaking.
    console.warn("[useLiveAccountState] WS subscribe failed:", err);
  }
}

function ensureBackstopPollerRunning(): void {
  if (backstopTimer || typeof window === "undefined") return;
  // Backstop poll catches the case where WS reconnect fails silently.
  // Light cadence (60 s) — WS is the primary trigger.
  backstopTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (subscribers.size === 0) return;
    void fetchSnapshot();
  }, BACKSTOP_POLL_MS);

  if (!visibilityListenerAttached) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && subscribers.size > 0) {
        const stale = !cached || Date.now() - cached.fetchedAt > STALE_AFTER_MS;
        if (stale) void fetchSnapshot();
      }
    });
    visibilityListenerAttached = true;
  }
}

function teardownIfIdle(): void {
  if (subscribers.size > 0) return;
  if (backstopTimer) {
    clearInterval(backstopTimer);
    backstopTimer = null;
  }
  if (wsUnsub) {
    wsUnsub();
    wsUnsub = null;
    wsAccountIdSubscribed = null;
  }
}

function subscribe(fn: (s: AccountSnapshot) => void): () => void {
  subscribers.add(fn);
  ensureBackstopPollerRunning();
  if (cached) {
    queueMicrotask(() => {
      if (subscribers.has(fn)) fn(cached!);
    });
  } else {
    void fetchSnapshot();
  }
  return () => {
    subscribers.delete(fn);
    teardownIfIdle();
  };
}

// ─── Public hooks ────────────────────────────────────────────────

export type LiveOrderState =
  | { status: "loading" }
  | { status: "open" }
  | { status: "closed" }; // filled, cancelled, or otherwise gone

/**
 * Returns `loading` until the first /api/account fetch resolves, then
 * `open` if `orderId` is in the live open-orders list, otherwise `closed`.
 *
 * Callers should treat `closed` as "this card's button should not work"
 * — the order is no longer cancellable because it isn't on the book.
 */
export function useLiveOrderState(orderId: number | null | undefined): LiveOrderState {
  const [snap, setSnap] = useState<AccountSnapshot | null>(cached);

  useEffect(() => {
    return subscribe(setSnap);
  }, []);

  if (!Number.isFinite(orderId)) return { status: "loading" };
  if (!snap) return { status: "loading" };
  return snap.openOrderIds.has(orderId as number) ? { status: "open" } : { status: "closed" };
}

export type LivePositionState =
  | { status: "loading" }
  | { status: "open"; isLong: boolean; absSize: number }
  | { status: "closed" };

/**
 * Returns the live state of a position by market symbol. Symbol can be
 * either "ETH/USD" or "ETHUSD"; both normalize to the same key.
 *
 * If `expectedSide` is provided, a position with the wrong side counts
 * as `closed` for the caller's purpose — useful for cards that need to
 * verify "this exact long is still open" (a flipped-to-short position
 * is no longer the original close target).
 */
export function useLivePositionState(
  symbol: string | null | undefined,
  expectedSide?: "Long" | "Short",
): LivePositionState {
  const [snap, setSnap] = useState<AccountSnapshot | null>(cached);

  useEffect(() => {
    return subscribe(setSnap);
  }, []);

  if (!symbol) return { status: "loading" };
  if (!snap) return { status: "loading" };
  const key = normalizeSymbol(symbol);
  const pos = snap.positionsBySymbol.get(key);
  if (!pos) return { status: "closed" };
  if (expectedSide) {
    const sideMatches = expectedSide === "Long" ? pos.isLong : !pos.isLong;
    if (!sideMatches) return { status: "closed" };
  }
  return { status: "open", isLong: pos.isLong, absSize: pos.absSize };
}

/**
 * Manually invalidate the cache — call after the user takes an action
 * that should change account state immediately (cancel, close, place).
 * Triggers a fresh fetch within the next tick.
 */
export function refreshLiveAccountState(): void {
  cached = null;
  void fetchSnapshot();
}
