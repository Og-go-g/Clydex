"use client";

/**
 * Subscribe to live account-stream events for the signed-in user.
 *
 * The hook delivers EVERY account update (fills/places/cancels/balances)
 * through `onUpdate` and refreshes its own bookkeeping (`lastEventAt`,
 * `eventCount`). It is intentionally a *signal* — the manager confirmed
 * elsewhere that account WS payloads are deltas keyed by orderId, not
 * snapshots. Replicating the server-side `/api/account` aggregate
 * client-side would be fragile, so the recommended use is:
 *
 *   useNordAccount(accountId, () => debouncedRefetchAccount());
 *
 * i.e. fan a WS event into a debounced REST refetch. That's the strategy
 * approved in `tier2_websocket_migration_plan.md` and it keeps server-side
 * `/api/account` (5-call SDK aggregate) as the single source of truth.
 *
 * If `enabled` is false or `accountId` is null/0, the hook is a no-op:
 * no subscription is created, no connection is opened. This matches how
 * `app/portfolio/page.tsx` will gate the WS path behind the feature flag.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WebSocketAccountUpdate } from "@n1xyz/nord-ts";
import { getNordWsManager } from "@/lib/n1/ws-manager";

export type UseNordAccountOptions = {
  /** Manager only opens the socket when at least one listener is enabled.
   *  Pass `false` to keep the hook mounted but inert (e.g. behind a flag). */
  enabled?: boolean;
};

export type UseNordAccountResult = {
  /** Wall-clock timestamp of the last received account event, or null. */
  lastEventAt: number | null;
  /** Total number of account events seen during this hook's lifetime. */
  eventCount: number;
};

export function useNordAccount(
  accountId: number | null | undefined,
  onUpdate: (data: WebSocketAccountUpdate) => void,
  opts: UseNordAccountOptions = {},
): UseNordAccountResult {
  const enabled = opts.enabled !== false;
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [eventCount, setEventCount] = useState(0);

  // Latest onUpdate kept in a ref so the WS subscription doesn't get
  // torn down on every parent re-render (which would happen if we put
  // `onUpdate` directly in the effect deps).
  const cbRef = useRef(onUpdate);
  cbRef.current = onUpdate;

  const handler = useCallback((data: WebSocketAccountUpdate) => {
    setLastEventAt(Date.now());
    setEventCount((n) => n + 1);
    try {
      cbRef.current(data);
    } catch (err) {
      console.error("[useNordAccount] onUpdate threw:", err);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (
      typeof accountId !== "number" ||
      !Number.isFinite(accountId) ||
      accountId <= 0
    ) {
      return;
    }
    const off = getNordWsManager().subscribeAccount(accountId, handler);
    return off;
  }, [accountId, enabled, handler]);

  return { lastEventAt, eventCount };
}
