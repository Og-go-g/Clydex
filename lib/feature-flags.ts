/**
 * Build-time feature flags. Inlined by Next.js into the client bundle, so
 * flipping a flag requires a redeploy — that's intentional: feature flags
 * here are deploy gates, not runtime A/B tests.
 *
 * Naming convention: `useNordWs` etc. — past tense ("isXEnabled") reads
 * confusingly when negated. Prefer plain boolean predicates.
 */

/**
 * When true (the default), frontend hooks listen to live WebSocket streams
 * from @n1xyz/nord-ts; when false they no-op and existing REST polling
 * stays in charge.
 *
 * Phase 7 rollout flipped the default to ON: Phases 0–2 ran behind an
 * opt-in flag for ~a week with no regressions reported, so the rollout
 * decision was to ship WS to all users by default. The env var stays as
 * an emergency kill-switch — set `NEXT_PUBLIC_USE_NORD_WS=false` and
 * rebuild to revert globally.
 *
 * UI on the `/dev/ws-spike` debug page IGNORES this flag — that page
 * exists specifically to verify WS plumbing regardless of rollout state.
 */
export const NORD_WS_ENABLED: boolean =
  process.env.NEXT_PUBLIC_USE_NORD_WS !== "false";

/**
 * Per-browser override for self-testing or hot-rollback for a single user.
 *
 *   localStorage.setItem('clydex.nordWs', '1')  // force WS on  (default anyway)
 *   localStorage.setItem('clydex.nordWs', '0')  // force WS off (kill switch)
 *   localStorage.removeItem('clydex.nordWs')    // follow the global default
 *
 * Note: the explicit '0' override wins over the global flag, so a user who
 * hits a regression can drop themselves back to REST polling without
 * waiting on a redeploy. Read this inside a useEffect (not in render) —
 * it touches localStorage, which is fine on the client but irrelevant on
 * the server during SSR/static generation.
 */
export function isNordWsEnabledForSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const override = window.localStorage.getItem("clydex.nordWs");
    if (override === "0") return false;
    if (override === "1") return true;
  } catch {
    // localStorage can throw in private mode / when storage is full.
  }
  return NORD_WS_ENABLED;
}
