/**
 * Build-time feature flags. Inlined by Next.js into the client bundle, so
 * flipping a flag requires a redeploy — that's intentional: feature flags
 * here are deploy gates, not runtime A/B tests.
 *
 * Naming convention: `useNordWs` etc. — past tense ("isXEnabled") reads
 * confusingly when negated. Prefer plain boolean predicates.
 */

/**
 * When true, frontend hooks listen to live WebSocket streams from
 * @n1xyz/nord-ts; when false they no-op and existing REST polling stays
 * in charge. Default: false. Flipping requires `NEXT_PUBLIC_USE_NORD_WS=true`
 * in `.env.local` (or in the Hetzner container env) and a rebuild.
 *
 * Used by Phase 2-5 hooks as a kill-switch for the migration. UI on the
 * `/dev/ws-spike` debug page IGNORES this flag — that page exists
 * specifically to verify WS plumbing regardless of the rollout state.
 */
export const NORD_WS_ENABLED: boolean =
  process.env.NEXT_PUBLIC_USE_NORD_WS === "true";

/**
 * For local self-testing without redeploying. If a developer wants to flip
 * WS on for their browser only (without changing the env var), they can run
 * `localStorage.setItem('clydex.nordWs', '1')` in DevTools and reload.
 *
 * Returns whether WS should be active for this browser session. Read this
 * inside hooks once on mount (not per render) — it accesses localStorage,
 * which is sync but still belongs in a useEffect to keep SSR happy.
 */
export function isNordWsEnabledForSession(): boolean {
  if (NORD_WS_ENABLED) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("clydex.nordWs") === "1";
  } catch {
    // localStorage can throw in private mode / when storage is full.
    return false;
  }
}
