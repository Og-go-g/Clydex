"use client";

/**
 * WebSocket Spike — Phase 0 of the Tier 2 migration.
 *
 * Internal dev page at `/dev/ws-spike`. Verifies that `@n1xyz/nord-ts`
 * WebSocket clients actually connect from the browser to
 * `wss://zo-mainnet.n1.xyz/ws/...`, receive events, and clean up on
 * unmount. No production traffic touches this page; it exists purely so
 * a human can reproduce real WS behavior before any code in
 * `app/portfolio` or `components/chat` changes.
 *
 * Note: Next.js does not allow underscore-prefixed folders to become
 * routes (they're "private folders"), so this lives at `app/dev/...`
 * rather than the `app/_dev/...` mentioned in the plan memo. The page
 * is not linked from nav; only direct-URL access. Read-only WS test —
 * no secrets are exposed, no state is mutated server-side. Safe to ship.
 *
 * Acceptance criteria for Phase 0 (`tier2_websocket_migration_plan.md`):
 *   - Connects without CORS / Origin errors in the browser
 *   - Receives at least one `account` event after a real on-chain action
 *   - Cleanly closes — no zombie WS in DevTools after navigating away
 *
 * If/when Phase 0 passes and Phase 1 hooks land, this page becomes
 * obsolete and can be deleted (or kept as a debugging tool — it's
 * useful for diagnosing live WS issues against prod).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  N1WebSocketManager,
  type WebSocketAccountUpdate,
  type WebSocketTradeUpdate,
  type WebSocketDeltaUpdate,
  type WebSocketCandleUpdate,
} from "@/lib/n1/websocket";

// ─── Types ────────────────────────────────────────────────────────

type EventKind =
  | "connected"
  | "disconnected"
  | "error"
  | "account"
  | "trade"
  | "delta"
  | "candle";

type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

interface EventLogEntry {
  id: number;
  ts: number;
  kind: EventKind;
  summary: string;
  payload: unknown;
}

interface AccountResponse {
  exists?: boolean;
  accountId?: number;
  error?: string;
}

const MAX_LOG = 100;

// ─── Helpers ──────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function summarizeAccount(u: WebSocketAccountUpdate): string {
  const fills = Object.keys(u.fills ?? {}).length;
  const places = Object.keys(u.places ?? {}).length;
  const cancels = Object.keys(u.cancels ?? {}).length;
  const balKeys = Object.keys(u.balances ?? {}).length;
  return `update_id=${u.update_id} fills=${fills} places=${places} cancels=${cancels} balances=${balKeys}`;
}

function summarizeTrade(u: WebSocketTradeUpdate): string {
  // Trades type ≈ { trades: [{ price, size, side, time }, ...], market_symbol }
  // Be defensive — exact shape isn't documented; fallback to JSON length.
  const obj = u as unknown as Record<string, unknown>;
  const trades = obj.trades as unknown[] | undefined;
  const sym = obj.market_symbol as string | undefined;
  if (Array.isArray(trades)) {
    return `${sym ?? "?"} ×${trades.length}`;
  }
  return JSON.stringify(u).slice(0, 80);
}

function summarizeDelta(u: WebSocketDeltaUpdate): string {
  return `${u.market_symbol} update_id=${u.update_id} asks=${u.asks.length} bids=${u.bids.length}`;
}

function summarizeCandle(u: WebSocketCandleUpdate): string {
  return `m=${u.mid} res=${u.res} t=${u.t} OHLC=${u.o}/${u.h}/${u.l}/${u.c} v=${u.v}`;
}

function kindColor(k: EventKind): string {
  switch (k) {
    case "connected":    return "text-emerald-400";
    case "disconnected": return "text-amber-400";
    case "error":        return "text-red-400";
    case "account":      return "text-cyan-400";
    case "trade":        return "text-violet-400";
    case "delta":        return "text-blue-400";
    case "candle":       return "text-indigo-400";
  }
}

function stateBadge(s: ConnectionState): { color: string; text: string } {
  switch (s) {
    case "idle":         return { color: "bg-zinc-600",    text: "idle" };
    case "connecting":   return { color: "bg-amber-500",   text: "connecting…" };
    case "connected":    return { color: "bg-emerald-500", text: "connected" };
    case "disconnected": return { color: "bg-amber-500",   text: "disconnected" };
    case "error":        return { color: "bg-red-500",     text: "error" };
  }
}

// ─── Page ─────────────────────────────────────────────────────────

export default function WsSpikePage() {
  // Form state
  const [accountIdInput, setAccountIdInput] = useState<string>("");
  const [tradeSymbol, setTradeSymbol] = useState<string>("BTCUSD");
  const [subAccount, setSubAccount] = useState<boolean>(true);
  const [subTrades, setSubTrades] = useState<boolean>(true);
  const [subDeltas, setSubDeltas] = useState<boolean>(false);
  const [subCandles, setSubCandles] = useState<boolean>(false);

  // Runtime state
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [errorCount, setErrorCount] = useState<number>(0);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [autoDetectInfo, setAutoDetectInfo] = useState<string>("");

  // Manager held in ref — re-created on each Connect press, never stored
  // in React state (would cause spurious re-renders on every event).
  const managerRef = useRef<N1WebSocketManager | null>(null);
  const eventCounter = useRef<number>(0);

  // ─── Auto-detect accountId from /api/account ───────────────────

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AccountResponse | null) => {
        if (cancelled || !data) return;
        if (typeof data.accountId === "number") {
          setAccountIdInput(String(data.accountId));
          setAutoDetectInfo(`auto-detected accountId=${data.accountId} from /api/account`);
        } else if (data.error === "Not authenticated") {
          setAutoDetectInfo("not signed in — enter accountId manually");
        } else {
          setAutoDetectInfo("could not resolve accountId — enter manually");
        }
      })
      .catch(() => {
        if (!cancelled) setAutoDetectInfo("/api/account fetch failed — enter accountId manually");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Cleanup on unmount ─────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (managerRef.current) {
        managerRef.current.close();
        managerRef.current = null;
      }
    };
  }, []);

  // ─── Append to event log ────────────────────────────────────────

  const append = useCallback(
    (kind: EventKind, summary: string, payload: unknown): void => {
      const entry: EventLogEntry = {
        id: ++eventCounter.current,
        ts: Date.now(),
        kind,
        summary,
        payload,
      };
      setEvents((prev) => {
        const next = [entry, ...prev];
        return next.length > MAX_LOG ? next.slice(0, MAX_LOG) : next;
      });
    },
    []
  );

  // ─── Connect ────────────────────────────────────────────────────

  const connect = useCallback(async (): Promise<void> => {
    // If a previous manager is around, kill it first — never stack connections.
    if (managerRef.current) {
      managerRef.current.close();
      managerRef.current = null;
    }

    const accountIdNum = parseInt(accountIdInput.trim(), 10);
    const symbolTrim = tradeSymbol.trim().toUpperCase();

    const wantAccount = subAccount && Number.isFinite(accountIdNum) && accountIdNum > 0;
    const wantTrades = subTrades && symbolTrim.length > 0;
    const wantDeltas = subDeltas && symbolTrim.length > 0;
    const wantCandles = subCandles && symbolTrim.length > 0;

    if (!wantAccount && !wantTrades && !wantDeltas && !wantCandles) {
      append(
        "error",
        "no valid subscription selected — enable at least one stream and fill its inputs",
        null
      );
      return;
    }

    setConnectionState("connecting");
    setErrorCount(0);
    setConnectedAt(null);

    const manager = new N1WebSocketManager(
      {
        trades: wantTrades ? [symbolTrim] : undefined,
        deltas: wantDeltas ? [symbolTrim] : undefined,
        accounts: wantAccount ? [accountIdNum] : undefined,
        candles: wantCandles
          ? [{ symbol: symbolTrim, resolution: "1" }]
          : undefined,
      },
      {
        onConnect: () => {
          setConnectionState("connected");
          setConnectedAt(Date.now());
          append("connected", "WebSocket connected", null);
        },
        onDisconnect: () => {
          setConnectionState("disconnected");
          append("disconnected", "WebSocket disconnected", null);
        },
        onError: (err) => {
          setConnectionState("error");
          setErrorCount((n) => n + 1);
          append("error", err.message, { name: err.name, stack: err.stack });
        },
        onAccount: (data) => append("account", summarizeAccount(data), data),
        onTrade: (data) => append("trade", summarizeTrade(data), data),
        onDelta: (data) => append("delta", summarizeDelta(data), data),
        onCandle: (data) => append("candle", summarizeCandle(data), data),
      }
    );

    managerRef.current = manager;
    try {
      await manager.connect();
    } catch (err) {
      setConnectionState("error");
      setErrorCount((n) => n + 1);
      const msg = err instanceof Error ? err.message : String(err);
      append("error", `connect() threw: ${msg}`, err);
    }
  }, [
    accountIdInput,
    tradeSymbol,
    subAccount,
    subTrades,
    subDeltas,
    subCandles,
    append,
  ]);

  // ─── Disconnect ─────────────────────────────────────────────────

  const disconnect = useCallback((): void => {
    if (managerRef.current) {
      managerRef.current.close();
      managerRef.current = null;
    }
    setConnectionState("disconnected");
    setConnectedAt(null);
  }, []);

  // ─── Clear log ──────────────────────────────────────────────────

  const clearLog = useCallback((): void => {
    setEvents([]);
    setErrorCount(0);
    eventCounter.current = 0;
  }, []);

  // ─── Computed values ───────────────────────────────────────────

  const badge = stateBadge(connectionState);
  const connectedFor =
    connectedAt !== null && connectionState === "connected"
      ? `${Math.floor((Date.now() - connectedAt) / 1000)}s`
      : "—";

  // 1Hz tick to keep "connected for" fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // ─── Render ────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 text-sm">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-white">WebSocket Spike — Phase 0</h1>
        <p className="mt-1 text-muted">
          Verifies <code className="text-emerald-400">@n1xyz/nord-ts</code> WS connectivity
          from the browser. See{" "}
          <code className="text-emerald-400">tier2_websocket_migration_plan.md</code> for
          context.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <span className={`inline-flex h-2 w-2 rounded-full ${badge.color}`} />
          <span className="font-mono text-white">{badge.text}</span>
          {connectionState === "connected" && (
            <span className="text-muted">connected for {connectedFor}</span>
          )}
          <span className="ml-auto text-muted">
            events: {events.length} · errors: {errorCount}
          </span>
        </div>
      </header>

      {/* Controls */}
      <section className="mb-6 rounded-xl border border-[#262626] bg-[#0a0a0a] p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-muted">
              Account ID
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={accountIdInput}
              onChange={(e) => setAccountIdInput(e.target.value)}
              placeholder="e.g. 3560"
              className="w-full rounded-lg border border-[#262626] bg-[#111] px-3 py-2 font-mono text-white outline-none focus:border-emerald-500"
            />
            {autoDetectInfo && (
              <span className="mt-1 block text-xs text-muted">{autoDetectInfo}</span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-muted">
              Market Symbol (trades / deltas / candles)
            </span>
            <input
              type="text"
              value={tradeSymbol}
              onChange={(e) => setTradeSymbol(e.target.value)}
              placeholder="e.g. BTCUSD"
              className="w-full rounded-lg border border-[#262626] bg-[#111] px-3 py-2 font-mono text-white outline-none focus:border-emerald-500"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Toggle label="account" checked={subAccount} onChange={setSubAccount} />
          <Toggle label="trades"  checked={subTrades}  onChange={setSubTrades}  />
          <Toggle label="deltas"  checked={subDeltas}  onChange={setSubDeltas}  />
          <Toggle label="candle (1m)" checked={subCandles} onChange={setSubCandles} />

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={connect}
              disabled={connectionState === "connecting"}
              className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-emerald-400 transition hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {connectionState === "connected" ? "Reconnect" : "Connect"}
            </button>
            <button
              type="button"
              onClick={disconnect}
              disabled={
                connectionState === "idle" || connectionState === "disconnected"
              }
              className="rounded-lg border border-[#333] bg-[#1a1a1a] px-4 py-2 text-white transition hover:border-red-500/50 disabled:opacity-30"
            >
              Disconnect
            </button>
          </div>
        </div>
      </section>

      {/* Event log */}
      <section className="rounded-xl border border-[#262626] bg-[#0a0a0a]">
        <div className="flex items-center justify-between border-b border-[#262626] px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Event Log (newest first)</h2>
          <button
            type="button"
            onClick={clearLog}
            className="rounded-md px-3 py-1 text-xs text-muted transition hover:bg-[#1a1a1a] hover:text-white"
          >
            Clear
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {events.length === 0 ? (
            <div className="px-4 py-8 text-center text-muted">
              No events yet. Press <span className="text-white">Connect</span> to start.
            </div>
          ) : (
            <ul className="divide-y divide-[#1a1a1a]">
              {events.map((e) => (
                <EventRow key={e.id} entry={e} />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Help */}
      <section className="mt-6 rounded-xl border border-[#262626] bg-[#0a0a0a] p-4 text-muted">
        <h3 className="mb-2 text-sm font-semibold text-white">What to verify</h3>
        <ul className="ml-5 list-disc space-y-1 text-xs leading-relaxed">
          <li>
            <span className="text-white">Connect</span> succeeds within ~1s, status flips
            to <span className="text-emerald-400">connected</span> with no console errors
            (open DevTools to confirm).
          </li>
          <li>
            DevTools → Network → WS — there&apos;s exactly one open frame to{" "}
            <code className="text-emerald-400">wss://zo-mainnet.n1.xyz/ws/...</code>.
          </li>
          <li>
            Ticking markets emit <span className="text-violet-400">trade</span> events
            within seconds of subscribe.
          </li>
          <li>
            Triggering an account action on 01.xyz (place / cancel / fill) emits an{" "}
            <span className="text-cyan-400">account</span> event within 1s.
          </li>
          <li>
            <span className="text-white">Disconnect</span> closes the socket — the WS
            entry in DevTools shows <code>Closed</code>.
          </li>
          <li>
            Navigating away from this page also closes any open socket (cleanup test).
          </li>
        </ul>
      </section>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer rounded border-[#262626] bg-[#111]"
      />
      <span className="text-white">{label}</span>
    </label>
  );
}

function EventRow({ entry }: { entry: EventLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const json =
    entry.payload === null || entry.payload === undefined
      ? null
      : (() => {
          try {
            return JSON.stringify(entry.payload, null, 2);
          } catch {
            return "[unserializable payload]";
          }
        })();

  return (
    <li className="px-4 py-2">
      <div className="flex items-start gap-3">
        <span className="w-24 shrink-0 font-mono text-xs text-muted">
          {fmtTime(entry.ts)}
        </span>
        <span
          className={`w-20 shrink-0 font-mono text-xs uppercase ${kindColor(entry.kind)}`}
        >
          {entry.kind}
        </span>
        <span className="flex-1 break-all font-mono text-xs text-white">
          {entry.summary}
        </span>
        {json && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 rounded px-2 py-0.5 text-xs text-muted transition hover:bg-[#1a1a1a] hover:text-white"
          >
            {expanded ? "hide" : "json"}
          </button>
        )}
      </div>
      {expanded && json && (
        <pre className="mt-2 overflow-x-auto rounded-md border border-[#262626] bg-[#050505] p-3 text-xs text-muted">
          {json}
        </pre>
      )}
    </li>
  );
}
