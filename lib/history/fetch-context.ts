/**
 * FetchContext — optional proxy agent + retry wrapper for sync functions.
 *
 * When used from HTTP routes (in-process Next.js), ctx is undefined → native fetch, no proxy.
 * When used from worker, ctx carries a rotated HttpsProxyAgent so we can bypass 01.xyz WAF.
 *
 * Backward-compatible: all sync functions accept ctx as optional trailing param.
 */

import type { Agent } from "http";
import { HttpsProxyAgent } from "https-proxy-agent";

export interface FetchContext {
  /** Optional HTTP agent (typically HttpsProxyAgent). */
  agent?: Agent;
  /** Delay applied after each fetch for WAF pacing (ms). */
  postDelayMs?: number;
  /** Label used in retry/error logs. */
  label?: string;
}

export function buildAgent(proxyUrl: string | undefined): Agent | undefined {
  if (!proxyUrl) return undefined;
  const normalized = proxyUrl.startsWith("http") ? proxyUrl : `http://${proxyUrl}`;
  return new HttpsProxyAgent(normalized) as unknown as Agent;
}

// ─── Proxy pool (round-robin, module-level) ──────────────────────
// Shared across all jobs in a worker process so rotation covers concurrent jobs too.

let pIdx = 0;

export function getProxyPool(): string[] {
  return (process.env.SYNC_PROXIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function hasProxies(): boolean {
  return getProxyPool().length > 0;
}

export function nextProxyAgent(): Agent | undefined {
  const pool = getProxyPool();
  if (pool.length === 0) return undefined;
  const next = pool[pIdx++ % pool.length];
  return buildAgent(next);
}

// ─── Retryable fetch with WAF-aware backoff ──────────────────────

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_BACKOFF_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RetryableFetchInit extends RequestInit {
  agent?: Agent;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

/**
 * Fetch with retries, proxy support, and 429/403 backoff.
 * Throws on final failure.
 */
export async function retryableFetch(
  url: string,
  init: RetryableFetchInit = {},
): Promise<Response> {
  const {
    agent,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRY_COUNT,
    backoffMs = DEFAULT_BACKOFF_MS,
    ...rest
  } = init;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    // Node fetch supports agent via (init as any).agent; TS fetch types don't expose it
    const fetchInit: RequestInit = { ...rest, signal };
    if (agent) (fetchInit as Record<string, unknown>).agent = agent;

    try {
      const res = await fetch(url, fetchInit);

      // WAF throttling — back off aggressively
      if (res.status === 429 || res.status === 403) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader
          ? Math.max(parseInt(retryAfterHeader, 10) * 1000, backoffMs)
          : backoffMs * (attempt + 1);

        if (attempt < retries - 1) {
          console.warn(`[retryableFetch] ${res.status} for ${url} — waiting ${retryAfterMs}ms`);
          await new Promise((r) => setTimeout(r, retryAfterMs));
          continue;
        }
      }

      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        const delay = backoffMs * (attempt + 1);
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[retryableFetch] ${url} attempt ${attempt + 1} failed (${msg}), retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Fetch failed for ${url}`);
}

// BROWSER_HEADERS was used to spoof a browser when calling the 01.xyz
// frontend API. That API is now aggregated locally (see lib/history/aggregate.ts),
// so the helper is no longer needed. Kept this comment as a breadcrumb —
// if we ever re-introduce a browser-emulating fetch path, redefine here.
