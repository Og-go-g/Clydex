/**
 * Fire-and-forget signal that a user is engaging with a leader's account.
 *
 * Powers the dormant tier-2 leaderboard refresh: each call inserts (at
 * most one per hour, server-side de-duped) a row into
 * `account_interactions`, which `selectTier2()` reads to decide which
 * accounts to refresh hourly.
 *
 * Three kinds along the discovery → commitment funnel:
 *   - 'search': user surfaced a leader (e.g. clicked "Copy" in the
 *     leaderboard table — a discovery signal, not yet a follow)
 *   - 'view':   user opened the full profile data
 *   - 'follow': user committed to copy-trading the leader
 *
 * Tier-2's selector treats all three identically (any interaction within
 * 7 days), so the choice of kind affects observability and the displayed
 * `reason` column but not which accounts get refreshed.
 *
 * Safety: this MUST never throw or surface errors to the user. The
 * endpoint already returns 200 on every error path (auth-less, malformed,
 * unknown account, even insert failure) — but we still wrap in `.catch`
 * to swallow network errors before they bubble to React.
 */

import { apiFetch } from "@/lib/apiFetch";

export type InteractionKind = "view" | "search" | "follow";

export function trackInteraction(walletAddr: string, kind: InteractionKind): void {
  if (typeof window === "undefined") return;
  if (!walletAddr || walletAddr.startsWith("account:")) return;

  void apiFetch("/api/track/account-interaction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddr, kind }),
  }).catch(() => {
    /* instrumentation must never surface errors */
  });
}
