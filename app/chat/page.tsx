"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRef, useEffect, useState, useMemo, useCallback, lazy, Suspense } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet/context";
import { useChatSessions } from "@/lib/chat/context";
import { getMessages, saveMessages } from "@/lib/chat/store";
import { syncSessionToDb } from "@/lib/chat/sync";
import { useAuth } from "@/lib/auth/context";
import { useRealtimePrices } from "@/hooks/useRealtimePrices";
import { useOrderExecution, isPreviewConsumed, getConfirmedPosition } from "@/hooks/useOrderExecution";
import { useToast } from "@/components/alerts/ToastProvider";
import { useChartPanel } from "@/lib/chat/chart-panel-context";

const PriceChart = lazy(() =>
  import("@/components/charts/PriceChart").then((m) => ({ default: m.PriceChart }))
);

// ─── Types for AI SDK message parts ──────────────────────────────

interface ToolMessagePart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  output?: Record<string, unknown>;
  errorText?: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** Minimum position size threshold — below this, position is considered empty */
const MIN_POS_SIZE = 1e-12;
const WELCOME_MESSAGE = "Hey! I'm Clydex, your AI trading assistant for 01 Exchange perpetual futures on Solana.\n\n";
const WELCOME_FOOTER = "\n\nWhat would you like to do?";
function formatTxHash(hash: string): string {
  return hash.length > 14 ? hash.slice(0, 8) + "..." + hash.slice(-6) : hash;
}

// ─── Helpers ─────────────────────────────────────────────────────

function msgText(m: Record<string, unknown>): string {
  if (typeof m.content === "string") return m.content;
  return "";
}

function formatUsd(n: number | null | undefined): string {
  // Guards: null, undefined, non-number, NaN, +Infinity, -Infinity all return "—"
  if (n == null || typeof n !== "number" || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1) return sign + "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sign + "$" + abs.toPrecision(4);
}

/** Format price with auto-precision (used across all cards) */
function fmtPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(n as number)) return "—";
  if (n >= 1000) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(6);
}

/** Format size with consistent precision: .toFixed(4) for sizes >= 0.01, .toFixed(6) for smaller */
function fmtSize(n: number | null | undefined): string {
  if (n == null || !isFinite(n as number)) return "0";
  const abs = Math.abs(n);
  return abs >= 0.01 ? n.toFixed(4) : n.toFixed(6);
}

/** Normalize symbol: remove slash, uppercase (e.g. "SOL/USD" → "SOLUSD") */
function normSym(s: string): string { return s.replace(/\//, "").toUpperCase(); }

/** Extract base asset from symbol (e.g. "SOLUSD" → "SOL") */
function baseAssetFrom(sym: string): string { return sym.replace(/USD$/, ""); }


// ─── Chart panel toggle button (inline in chat input area) ──────
function ChartToggleButton() {
  let panelCtx: ReturnType<typeof useChartPanel> | null = null;
  try { panelCtx = useChartPanel(); } catch { /* not inside provider — hide button */ }
  if (!panelCtx) return null;
  const { isOpen, toggle } = panelCtx;
  return (
    <button
      type="button"
      onClick={toggle}
      className={`hidden md:flex items-center justify-center rounded-xl border px-3 py-3 transition-colors ${
        isOpen
          ? "border-accent/50 bg-accent/10 text-accent"
          : "border-border bg-card text-muted hover:text-foreground hover:border-accent/30"
      }`}
      aria-label={isOpen ? "Close chart" : "Open chart"}
      title={isOpen ? "Close chart" : "Open chart"}
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13h2v8H3zM9 8h2v13H9zM15 11h2v10h-2zM21 4h2v17h-2z" />
      </svg>
    </button>
  );
}

// ─── Toast on status transition hook ─────────────────────────────
// Fires toast when execution status changes. Each card passes its own labels.
type ExecStatus = "idle" | "signing" | "submitting" | "verifying" | "confirmed" | "error";

function useStatusToast(
  status: ExecStatus,
  error: string | null,
  toasts: {
    confirmed?: { title: string; message?: string };
    error?: { title: string };
  }
) {
  const { addToast } = useToast();
  const prevStatus = useRef<ExecStatus>("idle");

  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (prev === status) return; // no change

    if (status === "confirmed" && toasts.confirmed) {
      addToast({ type: "success", ...toasts.confirmed, duration: 5000 });
    }

    if (status === "error") {
      const isUserReject = error?.includes("cancelled by user") || error?.includes("Transaction cancelled");
      if (isUserReject) {
        addToast({ type: "warning", title: "Transaction Cancelled", message: "You rejected the transaction in your wallet.", duration: 3000 });
      } else {
        addToast({ type: "error", title: toasts.error?.title ?? "Action Failed", message: error ?? undefined, duration: 6000 });
      }
    }
  }, [status, error, toasts, addToast]);
}

// ─── Main Page ───────────────────────────────────────────────────

export default function ChatPage() {
  const { activeId } = useChatSessions();
  if (!activeId) return null;
  return <ChatContent key={activeId} chatId={activeId} />;
}

function ChatContent({ chatId }: { chatId: string }) {
  const { address } = useWallet();
  const { isAuthenticated } = useAuth();
  const { renameChat, touchChat, sessions } = useChatSessions();
  // NordUser session is created on-demand when user clicks Execute/Close button.
  // No auto-init — wallet popup only happens on explicit user action.
  const addressRef = useRef(address);
  addressRef.current = address;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initialMessages = useMemo(() => getMessages(chatId) as any[], [chatId]);

  // Intentionally memoized with empty deps — DefaultChatTransport is stateless
  // (only holds the API endpoint URL), so it never needs to be recreated.
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    []
  );

  const { messages, sendMessage, status, error } = useChat({
    transport,
    id: chatId,
    messages: initialMessages.length > 0 ? initialMessages : undefined,
  });

  const [input, setInput] = useState("");
  const isLoading = status === "submitted" || status === "streaming";
  const showWelcome = messages.length === 0;

  // Accumulate market symbols from all getMarketPrice tool results for WS
  const priceSymbols = useMemo(() => {
    const syms = new Set<string>();
    for (const msg of messages) {
      const parts = (msg as unknown as { parts?: ToolMessagePart[] }).parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part.output || part.output.error) continue;
        const tName = part.toolName || part.type?.replace("tool-", "");
        // Collect from price cards
        if (tName === "getMarketPrice") {
          const sym = part.output.symbol as string | undefined;
          if (sym) syms.add(sym);
        }
        // Collect from position cards
        if (tName === "getPositions") {
          const positions = part.output.positions as Array<{ symbol?: string }> | undefined;
          if (positions) for (const p of positions) { if (p.symbol) syms.add(p.symbol); }
        }
        // Collect from order previews (prepareOrder) — needed for LivePositionCard
        if (tName === "prepareOrder") {
          const market = part.output.market as string | undefined;
          if (market) syms.add(market);
        }
        // Collect from close results
        if (tName === "closePosition") {
          const market = part.output.market as string | undefined;
          if (market) syms.add(market);
        }
        // Collect from open orders (getAccountInfo) for real-time price on order cards
        if (tName === "getAccountInfo") {
          const oo = part.output.openOrders as Array<{ symbol?: string }> | undefined;
          if (oo) for (const o of oo) { if (o.symbol) syms.add(o.symbol); }
        }
      }
    }
    return [...syms];
  }, [messages]);
  const realtimePrices = useRealtimePrices(priceSymbols);

  // Collect symbols of positions/orders that have been closed/cancelled in this conversation
  const closedSymbols = useMemo(() => {
    const closed = new Set<string>();
    for (const msg of messages) {
      const parts = (msg as unknown as { parts?: ToolMessagePart[] }).parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part.output || part.output.error) continue;
        const tName = part.toolName || part.type?.replace("tool-", "");
        // closePosition tool — user initiated a close
        if (tName === "closePosition" && part.output.action === "close_position") {
          const sym = part.output.market as string | undefined;
          if (sym) closed.add(sym);
        }
        // cancelOrder — mark order as cancelled
        if (tName === "cancelOrder" && !part.output.error) {
          const sym = part.output.market as string | undefined;
          if (sym) closed.add(`order:${sym}`);
        }
      }
    }
    return closed;
  }, [messages]);

  // Persist messages when streaming finishes (status transitions from streaming/submitted → ready).
  // We use a ref for messages so the effect only fires on `status` changes, not every streamed token.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasStreaming = prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted";
    const nowReady = status === "ready";
    prevStatusRef.current = status;

    if (!wasStreaming || !nowReady) return;

    const msgs = messagesRef.current;
    if (msgs.length === 0) return;

    saveMessages(chatId, msgs);
    touchChat(chatId);

    let title: string | undefined;
    const session = sessions.find((s) => s.id === chatId);
    if (session?.title === "New Chat") {
      const firstUserMsg = msgs.find((m) => m.role === "user");
      if (firstUserMsg) {
        const text = msgText(firstUserMsg as unknown as Record<string, unknown>);
        if (text) {
          title = text.slice(0, 40);
          renameChat(chatId, title);
        }
      }
    }

    if (isAuthenticated) {
      const serializable = msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: (m as unknown as Record<string, unknown>).content as string ?? "",
        parts: m.parts,
        createdAt: (m as unknown as Record<string, unknown>).createdAt as string | undefined,
      }));
      syncSessionToDb(chatId, title ?? session?.title ?? "New Chat", serializable);
    }
  }, [status, chatId, touchChat, renameChat, sessions, isAuthenticated]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput("");
  }, [input, isLoading, sendMessage]);

  // Send message from card buttons (close position, cancel order)
  const handleCardAction = useCallback((text: string) => {
    if (isLoading) return;
    sendMessage({ text });
  }, [isLoading, sendMessage]);

  return (
    <div className="flex h-[calc(100vh-4rem+1px)] flex-col">
      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {/* Welcome message */}
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-relaxed text-foreground">
              <div className="whitespace-pre-wrap">
                {showWelcome ? WELCOME_MESSAGE : ""}
                {"- "}
                <strong>Check prices</strong>
                {" — "}
                <button type="button" onClick={() => setInput("price of BTC")} className="text-muted underline hover:text-foreground transition-colors">{'"price of BTC"'}</button>
                {"\n- "}
                <strong>Trade perps</strong>
                {" — "}
                <button type="button" onClick={() => setInput("long ETH 5x $500")} className="text-muted underline hover:text-foreground transition-colors">{'"long ETH 5x $500"'}</button>
                {"\n- "}
                <strong>My positions</strong>
                {" — "}
                <button type="button" onClick={() => setInput("show my positions")} className="text-muted underline hover:text-foreground transition-colors">{'"show my positions"'}</button>
                {"\n- "}
                <strong>Funding rates</strong>
                {" — "}
                <button type="button" onClick={() => setInput("funding rates")} className="text-muted underline hover:text-foreground transition-colors">{'"funding rates"'}</button>
                {"\n- "}
                <strong>Markets</strong>
                {" — "}
                <button type="button" onClick={() => setInput("list all markets")} className="text-muted underline hover:text-foreground transition-colors">{'"list all markets"'}</button>
                {showWelcome ? WELCOME_FOOTER : ""}
              </div>
            </div>
          </div>

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-accent text-white"
                    : "border border-border bg-card text-foreground"
                }`}
              >
                <MessageContent
                  content={msgText(msg as unknown as Record<string, unknown>)}
                  parts={msg.parts as unknown as ToolMessagePart[]}
                  realtimePrices={realtimePrices}
                  closedSymbols={closedSymbols}
                  onSendMessage={handleCardAction}
                />
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="rounded-2xl border border-border bg-card px-4 py-3">
                <Spinner />
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-start">
              <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                Error: {error.message?.slice(0, 200)}
              </div>
            </div>
          )}
          {/* end of messages */}
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border bg-background p-4">
        <form onSubmit={onSubmit} className="mx-auto flex max-w-2xl items-center gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Trade, check prices, ask anything..."
            className="flex-1 rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="rounded-xl bg-accent px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            Send
          </button>
          <ChartToggleButton />
        </form>
      </div>
    </div>
  );
}

// ─── Message Rendering ───────────────────────────────────────────

function MessageContent({
  content,
  parts,
  realtimePrices,
  closedSymbols,
  onSendMessage,
}: {
  content: string;
  parts?: ToolMessagePart[];
  realtimePrices?: Record<string, number>;
  closedSymbols?: Set<string>;
  onSendMessage?: (msg: string) => void;
}) {
  if (Array.isArray(parts) && parts.length > 0) {
    return (
      <div className="space-y-2">
        {parts.map((part, i) => {
          if (part.type === "text") {
            const textPart = part as unknown as { type: "text"; text: string };
            return (
              <div key={`part-text-${i}`} className="whitespace-pre-wrap">
                <SimpleMarkdown text={textPart.text} />
              </div>
            );
          }
          if (part.type === "dynamic-tool" || part.type?.startsWith("tool-")) {
            return <ToolResult key={`part-tool-${i}`} part={part} realtimePrices={realtimePrices} closedSymbols={closedSymbols} onSendMessage={onSendMessage} />;
          }
          return null;
        })}
      </div>
    );
  }

  return (
    <div className="whitespace-pre-wrap">
      <SimpleMarkdown text={content} />
    </div>
  );
}

// ─── Markdown ────────────────────────────────────────────────────

function parseInline(text: string, keyPrefix = ""): React.ReactNode[] {
  const tokenRe = /\*\*(.*?)\*\*|`(.*?)`|\[(.*?)\]\(((?:https?:\/\/|\/)[^\s"<>)]*)\)/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const k = `${keyPrefix}${match.index}`;

    if (match[1] !== undefined) {
      nodes.push(<strong key={k}>{parseInline(match[1], `${k}-`)}</strong>);
    } else if (match[2] !== undefined) {
      nodes.push(
        <code key={k} className="rounded bg-white/10 px-1 py-0.5 text-xs">
          {match[2]}
        </code>
      );
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const href = match[4];
      const isInternal = href.startsWith("/");
      nodes.push(
        isInternal ? (
          <Link key={k} href={href} className="text-muted underline hover:text-foreground transition-colors">
            {match[3]}
          </Link>
        ) : (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="text-muted underline hover:text-foreground transition-colors">
            {match[3]}
          </a>
        )
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function SimpleMarkdown({ text }: { text: string }) {
  if (!text) return null;
  return <span>{parseInline(text)}</span>;
}

// ─── Tool Result Rendering ───────────────────────────────────────

function ToolResult({ part, realtimePrices, closedSymbols, onSendMessage }: { part: ToolMessagePart; realtimePrices?: Record<string, number>; closedSymbols?: Set<string>; onSendMessage?: (msg: string) => void }) {
  const toolName = part.toolName || part.type?.replace("tool-", "");
  const state = part.state;
  const result = part.output;

  if (state === "input-streaming" || state === "input-available") {
    return (
      <div className="my-1 rounded-lg border border-border bg-background p-3 text-xs text-muted">
        {toolName === "getMarketPrice" ? "Fetching price..."
          : toolName === "getMarketsList" ? "Loading markets..."
          : toolName === "getOrderbook" ? "Loading orderbook..."
          : toolName === "getFundingRates" ? "Fetching funding rates..."
          : toolName === "getPositions" ? "Loading positions..."
          : toolName === "getAccountInfo" ? "Loading account..."
          : toolName === "prepareOrder" ? "Preparing order..."
          : toolName === "setTrigger" ? "Setting trigger..."
          : toolName === "cancelOrder" ? "Looking up order..."
          : toolName === "closePosition" ? "Preparing close..."
          : "Loading..."}
      </div>
    );
  }

  if (state === "output-error") {
    return (
      <div className="my-1 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
        {part.errorText || "Tool execution failed"}
      </div>
    );
  }

  if (!result) return null;

  // Error result
  if (result.error) {
    return (
      <div className="my-1 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
        {result.error as string}
      </div>
    );
  }

  // Render based on tool type
  if (toolName === "getMarketPrice") {
    const sym = result.symbol as string | undefined;
    return <MarketPriceCard data={result} livePrice={sym ? realtimePrices?.[sym] : undefined} />;
  }
  if (toolName === "getPositions" && (result.positions as unknown[])?.length > 0) {
    return <PositionsCard data={result} realtimePrices={realtimePrices} closedSymbols={closedSymbols} onSendMessage={onSendMessage} />;
  }
  if (toolName === "getAccountInfo" && (result.openOrders as unknown[])?.length > 0) {
    return <OpenOrdersCard data={result} realtimePrices={realtimePrices} closedSymbols={closedSymbols} onSendMessage={onSendMessage} />;
  }
  if (toolName === "prepareOrder") return <OrderPreviewCard data={result} realtimePrices={realtimePrices} onSendMessage={onSendMessage} />;
  if (toolName === "closePosition") return <ClosePositionCard data={result} />;
  if (toolName === "setTrigger") return <TriggerCard data={result} />;
  if (toolName === "cancelOrder") return <CancelOrderCard data={result} />;

  // Default: don't render a card for info tools — the AI formats the response
  return null;
}

// ─── Positions Card (live PnL + close button) ───────────────────

interface PosData {
  symbol: string;
  baseAsset: string;
  side: string;
  size: number;
  absSize: number;
  entryPrice: number;
  markPrice: number;
  positionValue: number;
  unrealizedPnl: number;
  pnlPercent: number;
  fundingPnl: number;
  liqPrice: number;
  usedMargin: number;
  maxLeverage: number;
}

function PositionsCard({
  data,
  realtimePrices,
  closedSymbols,
  onSendMessage,
}: {
  data: Record<string, unknown>;
  realtimePrices?: Record<string, number>;
  closedSymbols?: Set<string>;
  onSendMessage?: (msg: string) => void;
}) {
  const positions = (data.positions as PosData[]) ?? [];
  const totalValue = data.totalValue as number | undefined;
  const availableMargin = data.availableMargin as number | undefined;

  return (
    <div className="my-2 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-background">
      <div className="border-b border-border px-4 py-2">
        <span className="text-sm font-semibold text-foreground">Positions</span>
        <span className="ml-2 rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold text-accent">
          {positions.length}
        </span>
      </div>

      {positions.map((pos, i) => {
        const wsKey = pos.symbol;
        const isClosed = closedSymbols?.has(wsKey) ?? false;
        const liveMarkPrice = realtimePrices?.[wsKey] ?? pos.markPrice;
        const priceDiff = liveMarkPrice - pos.entryPrice;
        const livePnl = pos.side === "Long" ? priceDiff * pos.absSize : -priceDiff * pos.absSize;
        const livePnlFunding = livePnl + pos.fundingPnl;
        const livePnlPct = pos.usedMargin > 0 ? (livePnlFunding / pos.usedMargin) * 100 : 0;
        const isProfit = livePnlFunding >= 0;
        const isLong = pos.side === "Long";
        const baseAsset = pos.baseAsset || baseAssetFrom(pos.symbol);

        return (
          <div key={i} className={`border-b border-border/50 px-4 py-3 ${i === positions.length - 1 ? "border-b-0" : ""} ${isClosed ? "opacity-40 pointer-events-none" : ""}`}>
            {/* Row 1: Market + Side + Size */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{baseAsset}/USD</span>
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-muted">{pos.maxLeverage}x</span>
                {isClosed && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-muted">CLOSED</span>}
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${isLong ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                  {pos.side}
                </span>
                <span className="text-sm font-mono text-foreground">{(() => { const s = pos.size ?? 0; return s < 0.01 ? s.toFixed(6) : s < 1 ? s.toFixed(4) : s.toFixed(2); })()}</span>
              </div>
            </div>

            {/* Row 2: Prices */}
            <div className="grid grid-cols-3 gap-2 text-xs mb-2">
              <div>
                <span className="text-muted">Entry</span>
                <div className="font-mono text-foreground">{fmtPrice(pos.entryPrice)}</div>
              </div>
              <div>
                <span className="text-muted">Mark</span>
                <div className="font-mono text-foreground">{fmtPrice(liveMarkPrice)}</div>
              </div>
              <div>
                <span className="text-muted">Value</span>
                <div className="font-mono text-foreground">${(pos.absSize * liveMarkPrice).toFixed(2)}</div>
              </div>
            </div>

            {/* Row 3: PnL + Liq */}
            <div className="grid grid-cols-3 gap-2 text-xs mb-2">
              <div>
                <span className="text-muted">PnL</span>
                <div className={`font-mono font-semibold ${isProfit ? "text-green-400" : "text-red-400"}`}>
                  {isProfit ? "+" : "-"}${Math.abs(livePnlFunding).toFixed(2)}
                  <span className="ml-1 text-[10px] opacity-75">({livePnlPct >= 0 ? "+" : ""}{(livePnlPct ?? 0).toFixed(2)}%)</span>
                </div>
              </div>
              <div>
                <span className="text-muted">Liq Price</span>
                <div className="font-mono text-red-400">{pos.liqPrice > 0 ? fmtPrice(pos.liqPrice) : "—"}</div>
              </div>
              <div>
                <span className="text-muted">Used Margin</span>
                <div className="font-mono text-foreground">{formatUsd(pos.usedMargin)}</div>
              </div>
            </div>

            {/* Close button */}
            {onSendMessage && (
              <button
                onClick={() => onSendMessage(`close ${baseAsset} 100%`)}
                disabled={isClosed}
                className="w-full rounded-lg border border-red-500/30 bg-red-500/5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-red-500/5"
              >
                Close Position
              </button>
            )}
          </div>
        );
      })}

      {/* Summary footer */}
      {(totalValue != null || availableMargin != null) && (
        <div className="flex justify-between px-4 py-2 text-xs text-muted bg-card/50">
          {totalValue != null && <span>Total Value: <span className="text-foreground font-mono">{formatUsd(totalValue)}</span></span>}
          {availableMargin != null && <span>Available: <span className="text-foreground font-mono">{formatUsd(availableMargin)}</span></span>}
        </div>
      )}
    </div>
  );
}

// ─── Open Orders Card ───────────────────────────────────────────

interface LiveOrder {
  orderId: number;
  symbol: string;
  baseAsset: string;
  side: string;
  size: number;
  price: number;
  orderValue: number;
  status: "active" | "filled" | "cancelled";
  fillPct: number;
  /** Market price frozen at the moment of fill/cancel — used in resolved cards instead of live WS price */
  frozenMarketPrice?: number;
}

function OpenOrdersCard({
  data,
  realtimePrices,
  closedSymbols,
  onSendMessage,
}: {
  data: Record<string, unknown>;
  realtimePrices?: Record<string, number>;
  closedSymbols?: Set<string>;
  onSendMessage?: (msg: string) => void;
}) {
  const { addToast } = useToast();
  const initialOrders = (data.openOrders as Array<{
    orderId: number; symbol: string; baseAsset: string;
    side: string; size: number; price: number; orderValue: number;
  }>) ?? [];

  // ── Persist resolved order states in sessionStorage ──
  // Prevents stale "active" flash when switching chats / remounting
  const RESOLVED_KEY = "__order_resolved";
  const getResolvedCache = useCallback((): Record<string, { status: "filled" | "cancelled"; fillPct: number; frozenMarketPrice?: number }> => {
    try {
      const s = sessionStorage.getItem(RESOLVED_KEY);
      return s ? JSON.parse(s) : {};
    } catch { return {}; }
  }, []);
  const saveResolved = useCallback((orderId: number, status: "filled" | "cancelled", fillPct: number, frozenMarketPrice?: number) => {
    try {
      const cache = JSON.parse(sessionStorage.getItem(RESOLVED_KEY) ?? "{}");
      cache[String(orderId)] = { status, fillPct, frozenMarketPrice };
      sessionStorage.setItem(RESOLVED_KEY, JSON.stringify(cache));
    } catch { /* quota */ }
  }, []);

  // Live order state — initialize from resolved cache to avoid stale "active" flash
  const [liveOrders, setLiveOrders] = useState<LiveOrder[]>(() => {
    const resolved = (() => { try { const s = sessionStorage.getItem(RESOLVED_KEY); return s ? JSON.parse(s) : {}; } catch { return {}; } })();
    return initialOrders.map(o => {
      const cached = resolved[String(o.orderId)] as { status: "filled" | "cancelled"; fillPct: number; frozenMarketPrice?: number } | undefined;
      if (cached) {
        return {
          ...o,
          baseAsset: o.baseAsset || baseAssetFrom(o.symbol),
          status: cached.status,
          fillPct: cached.fillPct,
          frozenMarketPrice: cached.frozenMarketPrice,
        };
      }
      return {
        ...o,
        baseAsset: o.baseAsset || baseAssetFrom(o.symbol),
        status: "active" as const,
        fillPct: 0,
      };
    });
  });
  const initialSizesRef = useRef<Record<number, number>>({});
  // Track whether first poll has confirmed actual order state
  // If any orders initialized as "active" (not from cache), we need verification
  const needsVerification = liveOrders.some(o => o.status === "active");
  const [verified, setVerified] = useState(!needsVerification);
  // Persist toasted order IDs in sessionStorage to survive remounts & tab switches
  const toastedRef = useRef<Set<string>>(new Set<string>());
  const toastedInitialized = useRef(false);
  if (!toastedInitialized.current) {
    toastedInitialized.current = true;
    try {
      const stored = sessionStorage.getItem("__order_toasted");
      if (stored) toastedRef.current = new Set(JSON.parse(stored) as string[]);
    } catch { /* ignore */ }
  }
  const persistToasted = useCallback(() => {
    try {
      sessionStorage.setItem("__order_toasted", JSON.stringify([...toastedRef.current]));
    } catch { /* quota */ }
  }, []);

  // Snapshot initial sizes on mount
  useEffect(() => {
    const sizes: Record<number, number> = {};
    for (const o of initialOrders) sizes[o.orderId] = o.size;
    initialSizesRef.current = sizes;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Polling: track order state changes (max 30 min) ──────────────
  // Uses refs for mutable data (realtimePrices, toasts) to avoid stale closures.
  // The effect itself has stable deps — it runs once and self-manages lifecycle.
  const realtimePricesRef = useRef(realtimePrices);
  realtimePricesRef.current = realtimePrices; // always fresh

  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;

  const persistToastedRef = useRef(persistToasted);
  persistToastedRef.current = persistToasted;

  const saveResolvedRef = useRef(saveResolved);
  saveResolvedRef.current = saveResolved;

  useEffect(() => {
    // Skip if no orders or all already resolved from cache
    const hasActive = initialOrders.some(o => {
      try {
        const s = sessionStorage.getItem(RESOLVED_KEY);
        const cache = s ? JSON.parse(s) : {};
        return !cache[String(o.orderId)];
      } catch { return true; }
    });
    if (initialOrders.length === 0 || !hasActive) {
      setVerified(true); // all from cache — no need to check
      return;
    }

    let active = true;
    let timerRef: ReturnType<typeof setTimeout> | null = null;
    const startTime = Date.now();
    const MAX_DURATION = 30 * 60_000;
    const trackedIds = new Set(initialOrders.map(o => o.orderId));
    let failCount = 0;

    const check = async () => {
      if (!active || Date.now() - startTime > MAX_DURATION) return;
      try {
        const res = await fetch(`/api/account?_t=${Date.now()}`);
        if (!res.ok) {
          failCount++;
          // After 5 consecutive failures, mark verified anyway to unblock UI
          if (failCount >= 5) setVerified(true);
          scheduleNext();
          return;
        }
        failCount = 0;
        const acc = await res.json();
        const currentOrders = acc.orders ?? acc.openOrders ?? [];
        const positions = acc.positions ?? [];

        // Mark verified on first successful poll
        setVerified(true);

        let allResolved = true;
        setLiveOrders(prev => {
          const updated = prev.map(order => {
            if (order.status !== "active") return order;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const found = currentOrders.find((co: any) => co.orderId === order.orderId);

            if (found) {
              allResolved = false; // still active
              const origSize = initialSizesRef.current[order.orderId] ?? order.size;
              const remaining = Math.abs(found.size ?? order.size);
              const filled = Math.max(0, origSize - remaining);
              const pct = origSize > 0 ? (filled / origSize) * 100 : 0;

              if (pct > 0 && !toastedRef.current.has(`partial:${order.orderId}`)) {
                toastedRef.current.add(`partial:${order.orderId}`);
                persistToastedRef.current();
                addToastRef.current({ type: "info", title: "Order Partially Filled", message: `${order.baseAsset} ${order.side} — ${pct.toFixed(0)}%`, duration: 4000 });
              }
              return { ...order, size: remaining, fillPct: pct };
            }

            // Order gone — filled or cancelled?
            const sym = order.symbol.toUpperCase();
            const ba = order.baseAsset.toUpperCase();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pos = positions.find((p: any) => {
              const pSym = (p.symbol ?? "").toUpperCase();
              return (pSym === sym || pSym.startsWith(ba)) && Math.abs(p.perp?.baseSize ?? 0) > MIN_POS_SIZE;
            });

            const tKey = `resolved:${order.orderId}`;
            if (!toastedRef.current.has(tKey)) {
              toastedRef.current.add(tKey);
              persistToastedRef.current();
              if (pos) {
                addToastRef.current({ type: "success", title: "Order Filled", message: `${order.baseAsset} ${order.side} @ ${fmtPrice(order.price)}`, duration: 5000 });
              } else {
                addToastRef.current({ type: "warning", title: "Order Cancelled", message: `${order.baseAsset} ${order.side} @ ${fmtPrice(order.price)}`, duration: 5000 });
              }
            }

            // Freeze market price from latest WS data (via ref — always fresh)
            const frozenMarketPrice = realtimePricesRef.current?.[normSym(order.symbol)] ?? order.price;
            const resolvedStatus = pos ? "filled" as const : "cancelled" as const;
            const resolvedFillPct = pos ? 100 : order.fillPct;
            saveResolvedRef.current(order.orderId, resolvedStatus, resolvedFillPct, frozenMarketPrice);
            return { ...order, status: resolvedStatus, fillPct: resolvedFillPct, frozenMarketPrice };
          });
          return updated;
        });

        // Stop polling if all tracked orders resolved (checked via `allResolved` flag set inside map)
        if (allResolved) { active = false; return; }
      } catch {
        failCount++;
        if (failCount >= 5) setVerified(true);
      }
      scheduleNext();
    };

    const scheduleNext = () => {
      if (!active) return;
      const elapsed = Date.now() - startTime;
      const interval = elapsed < 5 * 60_000 ? 10_000 : elapsed < 30 * 60_000 ? 30_000 : null;
      if (interval) timerRef = setTimeout(check, interval);
    };

    const onVis = () => { if (!document.hidden && active) { if (timerRef) clearTimeout(timerRef); check(); } };
    document.addEventListener("visibilitychange", onVis);
    check(); // immediate first check

    return () => { active = false; if (timerRef) clearTimeout(timerRef); document.removeEventListener("visibilitychange", onVis); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Stable: uses refs for mutable data, initialOrders from closure is stable (tool result doesn't change)

  const activeCount = liveOrders.filter(o => o.status === "active").length;

  return (
    <div className="my-2 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-background">
      <div className="border-b border-border px-4 py-2 flex items-center gap-2">
        {!verified ? (
          <span className="h-2 w-2 animate-spin rounded-full border border-muted border-t-accent" />
        ) : activeCount > 0 ? (
          <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-400" />
        ) : null}
        <span className="text-sm font-semibold text-foreground">Orders</span>
        {!verified && <span className="text-[10px] text-muted ml-1">Checking...</span>}
        <span className="ml-1 rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold text-accent">
          {liveOrders.length}
        </span>
        {verified && activeCount > 0 && activeCount < liveOrders.length && (
          <span className="text-[10px] text-muted">{activeCount} active</span>
        )}
      </div>

      {liveOrders.map((o, i) => {
        const isBuy = o.side === "Buy";
        const isCancelled = o.status === "cancelled" || (closedSymbols?.has(`order:${o.symbol}`) ?? false);
        const isFilled = o.status === "filled";
        const isResolved = isCancelled || isFilled;
        // Use frozen price for resolved orders — no more WS updates on dead cards
        const livePrice = isResolved
          ? (o.frozenMarketPrice ?? o.price)
          : (realtimePrices?.[o.symbol] ?? null);
        const distance = livePrice != null && o.price > 0 ? ((livePrice - o.price) / o.price) * 100 : null;
        const isClose = !isResolved && distance !== null && Math.abs(distance) < 1;
        const isVeryClose = !isResolved && distance !== null && Math.abs(distance) < 0.3;

        return (
          <div key={o.orderId} className={`px-4 py-3 ${i < liveOrders.length - 1 ? "border-b border-border/50" : ""} ${isResolved ? "opacity-50" : ""} ${!verified && !isResolved ? "opacity-60" : ""}`}>
            {/* Row 1: Market, Side, Size, Status */}
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground">{o.baseAsset}/USD</span>
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${isBuy ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                  {o.side}
                </span>
                <span className="text-xs font-mono text-foreground">{o.size.toFixed(4)}</span>
                {isFilled && <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-bold text-green-400">FILLED</span>}
                {isCancelled && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-muted">CANCELLED</span>}
              </div>
              {onSendMessage && !isResolved && verified && (
                <button
                  onClick={() => onSendMessage(`cancel order ${o.baseAsset}`)}
                  className="rounded-md border border-orange-500/30 bg-orange-500/5 px-2 py-0.5 text-[10px] font-medium text-orange-400 hover:bg-orange-500/10 transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>

            {/* Row 2: Prices + Distance */}
            <div className="grid grid-cols-3 gap-2 text-[11px] mb-1.5">
              <div>
                <span className="text-muted">Limit</span>
                <div className="font-mono text-foreground">{fmtPrice(o.price)}</div>
              </div>
              <div>
                <span className="text-muted">{isResolved ? "Market (at close)" : "Market"}</span>
                <div className={`font-mono ${isVeryClose ? "text-yellow-400 font-semibold" : "text-foreground"}`}>
                  {livePrice ? fmtPrice(livePrice) : "—"}
                </div>
              </div>
              <div>
                <span className="text-muted">Distance</span>
                <div className={`font-mono ${isVeryClose ? "text-yellow-400 font-semibold" : isClose ? "text-yellow-400" : "text-muted"}`}>
                  {distance !== null ? `${distance >= 0 ? "+" : ""}${distance.toFixed(2)}%` : "—"}
                </div>
              </div>
            </div>

            {/* Row 3: Fill progress */}
            {!isCancelled && (
              <div className="flex items-center justify-between mt-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted">Filled:</span>
                  {o.fillPct > 0 ? (
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-700 ${isFilled ? "bg-green-400" : "bg-green-400/70"}`} style={{ width: `${Math.min(100, o.fillPct)}%` }} />
                      </div>
                      <span className="text-[10px] font-mono text-green-400">{o.fillPct.toFixed(0)}%</span>
                    </div>
                  ) : (
                    <span className="text-[10px] font-mono text-muted">0%</span>
                  )}
                </div>
                {!isResolved && (
                  <span className={`text-[10px] ${isVeryClose ? "text-yellow-400" : isClose ? "text-yellow-400/70" : "text-muted"}`}>
                    {isVeryClose ? "Price very close" : isClose ? "Price approaching" : "Waiting for price"}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Market Price Card (live chart) ──────────────────────────────

function MarketPriceCard({ data, livePrice }: { data: Record<string, unknown>; livePrice?: number }) {
  const symbol = data.symbol as string;
  const baseAsset = (data.baseAsset as string) ?? baseAssetFrom(symbol ?? "");
  const marketId = data.marketId as number;
  const markPrice = (livePrice ?? data.markPrice) as number | null;
  const change24h = data.change24h as number | null;
  const volume24h = data.volume24h as number | null;
  const fundingRate = data.fundingRate as number | null;
  const maxLeverage = data.maxLeverage as number | null;
  const tier = data.tier as number | null;

  const isPositive = change24h != null && change24h >= 0;
  const fmtVol = (n: number | null) => {
    if (n == null) return "—";
    if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
    return "$" + n.toFixed(0);
  };

  return (
    <div className="my-2 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-background">
      {/* Header + Price */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{baseAsset}/USD</span>
          {maxLeverage && (
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-muted">
              {maxLeverage}x
            </span>
          )}
          {tier != null && (
            <span className="text-[10px] text-muted">Tier {tier}</span>
          )}
        </div>
        <div className="text-right">
          <span className="text-lg font-bold text-foreground font-mono">{fmtPrice(markPrice)}</span>
          {change24h != null && (
            <span className={`ml-2 text-xs font-medium ${isPositive ? "text-green-400" : "text-red-400"}`}>
              {isPositive ? "+" : ""}{change24h.toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="flex gap-3 px-4 pb-1 text-[11px] text-muted">
        <span>Vol {fmtVol(volume24h)}</span>
        {fundingRate != null && <span>FR {(fundingRate * 100).toFixed(4)}%</span>}
      </div>

      {/* Mini Chart */}
      {marketId != null && baseAsset && (
        <Suspense fallback={<div className="h-[120px] animate-pulse bg-[#0a0a0a]" />}>
          <PriceChart
            marketId={marketId}
            baseAsset={baseAsset}
            currentPrice={livePrice ?? (markPrice ?? undefined)}
            change24h={change24h}
            compact
          />
        </Suspense>
      )}
    </div>
  );
}

// ─── Live Position Card (polls /api/account to detect external close) ──

interface PositionData {
  symbol: unknown; baseAsset: unknown; side: unknown; size: unknown; absSize: unknown;
  entryPrice: unknown; markPrice: unknown; positionValue: unknown; unrealizedPnl: unknown;
  fundingPnl: unknown; liqPrice: unknown; usedMargin: unknown; maxLeverage: unknown;
  pnlPercent: unknown;
}

function LivePositionCard({ initialPos, txHash, realtimePrices, onSendMessage }: {
  initialPos: PositionData;
  txHash?: string | null;
  realtimePrices?: Record<string, number>;
  onSendMessage?: (msg: string) => void;
}) {
  const [closed, setClosed] = useState(false);
  // Live position data from polling (updates entry price, PnL after partial close etc.)
  const [livePos, setLivePos] = useState(initialPos);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sym = (initialPos.symbol as string) ?? "";
  const baseAsset = (initialPos.baseAsset as string) || baseAssetFrom(sym);
  // Identity: match by symbol + side + entry price (tracks drift from partial fills)
  const initSide = initialPos.side as string;
  // Track entry price dynamically — updates as partial fills shift average entry
  const trackedEntryRef = useRef(initialPos.entryPrice as number);

  // Poll /api/account to detect external close + update live data (max 5 min)
  useEffect(() => {
    let active = true;
    let pollCount = 0;
    const MAX_POLLS = 30; // 30 × 10s = 5 minutes
    const check = async () => {
      pollCount++;
      if (pollCount > MAX_POLLS) {
        if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
        return;
      }
      try {
        const res = await fetch(`/api/account?_t=${Date.now()}`);
        if (!res.ok) return;
        const data = await res.json();
        const symUp = sym.toUpperCase();

        // Find THIS specific position by symbol + side + entry price proximity
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const match = (data.positions ?? []).find((p: any) => {
          const pSym = (p.symbol ?? "").toUpperCase();
          if (pSym !== symUp && !pSym.startsWith(baseAsset.toUpperCase())) return false;
          if (Math.abs(p.perp?.baseSize ?? 0) < MIN_POS_SIZE) return false;
          // Match side
          const pSide = p.perp?.isLong ? "Long" : "Short";
          if (pSide !== initSide) return false;
          // Match entry price within 1% (tight enough to avoid false matches, allows for minor drift from partial fills)
          const pEntry = p.perp?.price ?? 0;
          const refEntry = trackedEntryRef.current;
          if (refEntry > 0 && pEntry > 0 && Math.abs(pEntry - refEntry) / refEntry > 0.01) return false;
          return true;
        });

        if (!match && active) {
          setClosed(true);
          if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
        } else if (match && active) {
          // Update tracked entry price to follow drift (partial fills shift average)
          const newEntry = match.perp?.price ?? trackedEntryRef.current;
          if (newEntry > 0) trackedEntryRef.current = newEntry;
          // Update live position data (PnL, mark price, size after partial close)
          setLivePos({
            symbol: match.symbol ?? sym,
            baseAsset: match.baseAsset ?? baseAsset,
            side: match.perp?.isLong ? "Long" : "Short",
            size: match.perp?.baseSize ?? 0,
            absSize: Math.abs(match.perp?.baseSize ?? 0),
            entryPrice: newEntry,
            markPrice: match.markPrice ?? match.perp?.price ?? 0,
            positionValue: Math.abs(match.perp?.baseSize ?? 0) * (match.markPrice ?? match.perp?.price ?? 0),
            unrealizedPnl: match.perp?.sizePricePnl ?? 0,
            fundingPnl: match.perp?.fundingPnl ?? 0,
            liqPrice: match.liqPrice ?? 0,
            usedMargin: match.usedMargin ?? 0,
            maxLeverage: match.maxLeverage ?? 1,
            pnlPercent: 0,
          });
        }
      } catch { /* silent */ }
    };
    const t = setTimeout(() => {
      if (!active) return;
      check();
      pollingRef.current = setInterval(check, 10_000);
    }, 5000);
    return () => {
      active = false;
      clearTimeout(t);
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [sym, baseAsset, initSide]);

  // Use livePos for dynamic data (updates from polling), WS for mark price
  // Freeze mark price on close — stop WS updates for dead cards
  const frozenMarkRef = useRef<number | null>(null);
  useEffect(() => {
    if (closed && frozenMarkRef.current === null) {
      frozenMarkRef.current = realtimePrices?.[sym] ?? (livePos.markPrice as number);
    }
  }, [closed, realtimePrices, sym, livePos.markPrice]);
  const liveMarkPrice = closed
    ? (frozenMarkRef.current ?? (livePos.markPrice as number))
    : (realtimePrices?.[sym] ?? (livePos.markPrice as number));
  const absSize = livePos.absSize as number;
  const entryP = livePos.entryPrice as number;
  const posIsLong = livePos.side === "Long";
  const priceDiff = liveMarkPrice - entryP;
  const livePnl = posIsLong ? priceDiff * absSize : -priceDiff * absSize;
  const livePnlFunding = livePnl + ((livePos.fundingPnl as number) ?? 0);
  const usedMargin = (livePos.usedMargin as number) ?? 0;
  const rawPnlPct = usedMargin > 0 ? (livePnlFunding / usedMargin) * 100 : 0;
  const livePnlPct = isFinite(rawPnlPct) ? rawPnlPct : 0;
  const isProfit = livePnlFunding >= 0;

  // Freeze PnL at time of close so the closed card shows the final result
  const frozenPnlRef = useRef<number | null>(null);
  useEffect(() => {
    if (closed && frozenPnlRef.current === null) {
      frozenPnlRef.current = livePnlFunding;
    }
  }, [closed, livePnlFunding]);

  if (closed) {
    return (
      <div className="my-2 w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-background opacity-40">
        <div className="border-b border-border px-4 py-2 flex items-center gap-2">
          <span className="text-muted">—</span>
          <span className="text-sm font-semibold text-muted">Position Closed</span>
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{baseAsset}/USD {String(initialPos.side)} {absSize.toFixed(4)} @ {fmtPrice(entryP)}</span>
            {frozenPnlRef.current != null && (
              <span className={`text-xs font-medium ${frozenPnlRef.current >= 0 ? "text-green-400" : "text-red-400"}`}>
                PnL: {formatUsd(frozenPnlRef.current)}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 w-full max-w-lg overflow-hidden rounded-xl border border-green-500/30 bg-background">
      <div className="border-b border-border px-4 py-2 flex items-center gap-2">
        <span className="text-green-400">✓</span>
        <span className="text-sm font-semibold text-green-400">Position Opened</span>
        {txHash && <span className="ml-auto text-[10px] text-muted">Tx: {formatTxHash(txHash)}</span>}
      </div>
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{baseAsset}/USD</span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-muted">{String(livePos.maxLeverage)}x</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${posIsLong ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
              {String(livePos.side)}
            </span>
            <span className="text-sm font-mono text-foreground">{absSize.toFixed(2)}</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs mb-2">
          <div><span className="text-muted">Entry</span><div className="font-mono text-foreground">{fmtPrice(entryP)}</div></div>
          <div><span className="text-muted">Mark</span><div className="font-mono text-foreground">{fmtPrice(liveMarkPrice)}</div></div>
          <div><span className="text-muted">Value</span><div className="font-mono text-foreground">${(absSize * liveMarkPrice).toFixed(2)}</div></div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs mb-2">
          <div>
            <span className="text-muted">PnL</span>
            <div className={`font-mono font-semibold ${isProfit ? "text-green-400" : "text-red-400"}`}>
              {isProfit ? "+" : "-"}${Math.abs(livePnlFunding).toFixed(4)}
              <span className="ml-1 text-[10px] opacity-75">({livePnlPct >= 0 ? "+" : ""}{livePnlPct.toFixed(2)}%)</span>
            </div>
          </div>
          <div>
            <span className="text-muted">Liq Price</span>
            <div className="font-mono text-red-400">{(livePos.liqPrice as number) > 0 ? fmtPrice(livePos.liqPrice as number) : "—"}</div>
          </div>
          <div>
            <span className="text-muted">Used Margin</span>
            <div className="font-mono text-foreground">${usedMargin.toFixed(2)}</div>
          </div>
        </div>
        {onSendMessage && (
          <button
            onClick={() => onSendMessage(`close ${baseAsset} 100%`)}
            className="w-full rounded-lg border border-red-500/30 bg-red-500/5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
          >
            Close Position
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Live Order Card (limit orders — polls until filled → becomes LivePositionCard) ──

function LiveOrderCard({ market, side, size, limitPrice, leverage, txHash, realtimePrices, onSendMessage }: {
  market: string;
  side: "Long" | "Short";
  size: number;
  limitPrice: number;
  leverage: number;
  txHash?: string | null;
  realtimePrices?: Record<string, number>;
  onSendMessage?: (msg: string) => void;
}) {
  const { addToast } = useToast();
  const [orderState, setOrderState] = useState<"pending" | "filled" | "cancelled" | "expired">("pending");
  const [positionData, setPositionData] = useState<PositionData | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Fill progress tracking
  const [fillProgress, setFillProgress] = useState({ filled: 0, remaining: size, percent: 0 });
  const trackedOrderIdRef = useRef<string | number | null>(null);
  const posSnapshotRef = useRef<number | null>(null);
  const prevOrderState = useRef(orderState);

  // ── Real open time: persisted in sessionStorage, survives remounts ──
  // Key: market+side+price+txHash for uniqueness (txHash distinguishes identical orders)
  const orderTimeKey = `order_time:${market}:${side}:${limitPrice}:${txHash ?? size}`;
  const [openedAt] = useState<number>(() => {
    try {
      const stored = sessionStorage.getItem(orderTimeKey);
      if (stored) return Number(stored);
    } catch { /* ignore */ }
    // First mount — record current time
    const now = Date.now();
    try { sessionStorage.setItem(orderTimeKey, String(now)); } catch { /* quota */ }
    return now;
  });
  // Update openedAt from real API placedAt when discovered during polling
  const [realPlacedAt, setRealPlacedAt] = useState<number | null>(null);
  const effectiveOpenTime = realPlacedAt ?? openedAt;

  const sym = normSym(market);
  const baseAsset = baseAssetFrom(sym);
  const isLong = side === "Long";

  // Unique key for this order's toast dedup (survives remounts via sessionStorage)
  const toastKey = `live_order:${sym}:${side}:${limitPrice}:${size}`;

  const wasToasted = useCallback((key: string) => {
    try {
      const stored = sessionStorage.getItem("__order_toasted");
      const set: string[] = stored ? JSON.parse(stored) : [];
      return set.includes(key);
    } catch { return false; }
  }, []);

  const markToasted = useCallback((key: string) => {
    try {
      const stored = sessionStorage.getItem("__order_toasted");
      const set: string[] = stored ? JSON.parse(stored) : [];
      if (!set.includes(key)) { set.push(key); sessionStorage.setItem("__order_toasted", JSON.stringify(set)); }
    } catch { /* quota */ }
  }, []);

  // Toast on order state transitions (fill, cancel) — deduped via sessionStorage
  useEffect(() => {
    const prev = prevOrderState.current;
    prevOrderState.current = orderState;
    if (prev === orderState) return;

    if (orderState === "filled" && !wasToasted(`filled:${toastKey}`)) {
      markToasted(`filled:${toastKey}`);
      addToast({
        type: "success",
        title: "Limit Order Filled!",
        message: `${baseAsset} ${side} position opened @ ${fmtPrice(limitPrice)}`,
        duration: 6000,
      });
    } else if (orderState === "cancelled" && !wasToasted(`cancelled:${toastKey}`)) {
      markToasted(`cancelled:${toastKey}`);
      addToast({
        type: "warning",
        title: "Limit Order Cancelled",
        message: `${baseAsset} ${side} @ ${fmtPrice(limitPrice)}`,
        duration: 5000,
      });
    }
  }, [orderState, addToast, baseAsset, side, limitPrice, toastKey, wasToasted, markToasted]);

  // Toast on first partial fill detection — deduped via sessionStorage
  useEffect(() => {
    if (fillProgress.percent > 0 && fillProgress.percent < 100 && !wasToasted(`partial:${toastKey}`)) {
      markToasted(`partial:${toastKey}`);
      addToast({
        type: "info",
        title: "Order Partially Filled",
        message: `${baseAsset} ${side} — ${fillProgress.percent.toFixed(1)}% filled`,
        duration: 4000,
      });
    }
  }, [fillProgress.percent, addToast, baseAsset, side, toastKey, wasToasted, markToasted]);

  // Freeze market price when order reaches terminal state — no more WS updates
  const frozenPriceRef = useRef<number | null>(null);
  const isPending = orderState === "pending";
  useEffect(() => {
    if (!isPending && frozenPriceRef.current === null) {
      frozenPriceRef.current = realtimePrices?.[sym] ?? limitPrice;
    }
  }, [isPending, realtimePrices, sym, limitPrice]);
  const liveMarkPrice = isPending
    ? (realtimePrices?.[sym] ?? limitPrice)
    : (frozenPriceRef.current ?? limitPrice);

  const rawDistance = limitPrice > 0 ? ((liveMarkPrice - limitPrice) / limitPrice) * 100 : 0;
  const isClose = isPending && Math.abs(rawDistance) < 1;
  const isVeryClose = isPending && Math.abs(rawDistance) < 0.3;

  // Elapsed time ticker — uses real open time, stops when order resolves
  useEffect(() => {
    if (!isPending) return;
    // Immediate update + tick every second
    setElapsed(Date.now() - effectiveOpenTime);
    const id = setInterval(() => setElapsed(Date.now() - effectiveOpenTime), 1000);
    return () => clearInterval(id);
  }, [isPending, effectiveOpenTime]);

  const fmtElapsed = (ms: number) => {
    const s = Math.floor(Math.max(0, ms) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  };

  // ── Adaptive polling with order-ID tracking ──
  // Strategy: track the specific order by ID (not position size).
  // 1. First poll: find our order in open orders by matching symbol+side+price, store its ID.
  //    Also snapshot position size at that moment.
  // 2. Subsequent polls: check if that order ID still exists.
  //    - Order exists → still pending (keep polling)
  //    - Order gone + position size grew → filled (show LivePositionCard)
  //    - Order gone + position didn't grow → cancelled (show cancelled state)
  // This correctly handles: existing positions, multiple orders in same market,
  // external trades changing position size, partial fills.
  useEffect(() => {
    let active = true;
    let timerRef: ReturnType<typeof setTimeout> | null = null;
    const startTime = Date.now();
    // Adaptive polling phases — slows down over time to reduce API load.
    // After 2 hours total, getInterval() returns null and polling stops
    // (orderState is set to "expired" so the UI shows a paused state).
    const PHASES = [
      { until: 5 * 60_000, interval: 10_000 },   // 0-5 min:   every 10s
      { until: 30 * 60_000, interval: 30_000 },   // 5-30 min:  every 30s
      { until: 2 * 60 * 60_000, interval: 60_000 }, // 30 min-2h: every 60s
    ];

    // Returns the polling interval for the current phase, or null after 2 hours
    // to stop polling. When null, scheduleNext() sets orderState to "expired".
    const getInterval = (): number | null => {
      const el = Date.now() - startTime;
      for (const p of PHASES) { if (el < p.until) return p.interval; }
      return null;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildPosition = (pos: any): PositionData => ({
      symbol: pos.symbol ?? sym,
      baseAsset: pos.baseAsset ?? baseAsset,
      side: pos.perp?.isLong ? "Long" : "Short",
      size: pos.perp?.baseSize ?? 0,
      absSize: Math.abs(pos.perp?.baseSize ?? 0),
      entryPrice: pos.perp?.price ?? limitPrice,
      markPrice: pos.markPrice ?? pos.perp?.price ?? 0,
      positionValue: Math.abs(pos.perp?.baseSize ?? 0) * (pos.markPrice ?? pos.perp?.price ?? 0),
      unrealizedPnl: pos.perp?.sizePricePnl ?? 0,
      fundingPnl: pos.perp?.fundingPnl ?? 0,
      liqPrice: pos.liqPrice ?? 0,
      usedMargin: pos.usedMargin ?? 0,
      maxLeverage: pos.maxLeverage ?? leverage,
      pnlPercent: 0,
    });

    // Find our specific order: match symbol + side, then pick CLOSEST price match
    // This handles multiple orders at similar prices correctly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findOurOrder = (orders: any[]) => {
      const targetSide = isLong ? "bid" : "ask";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let bestMatch: any = null;
      let bestDist = Infinity;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const o of orders) {
        const oSym = (o.symbol ?? o.marketSymbol ?? "").toUpperCase();
        const oSide = (o.side ?? "").toLowerCase();
        const oPrice = o.price ?? 0;
        const symMatch = oSym === sym || oSym.startsWith(baseAsset);
        const sideMatch = oSide === targetSide || oSide === side.toLowerCase();
        if (!symMatch || !sideMatch) continue;
        const dist = limitPrice > 0 ? Math.abs(oPrice - limitPrice) / limitPrice : 0;
        if (dist < 0.005 && dist < bestDist) { // within 0.5% tolerance, pick closest
          bestDist = dist;
          bestMatch = o;
        }
      }
      return bestMatch;
    };

    const check = async () => {
      if (!active) return;
      try {
        const res = await fetch(`/api/account?_t=${Date.now()}`);
        if (!res.ok) { scheduleNext(); return; }
        const data = await res.json();
        const positions = data.positions ?? [];
        const orders = data.orders ?? data.openOrders ?? [];

        // Find current position in this market
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pos = positions.find((p: any) => {
          const pSym = (p.symbol ?? "").toUpperCase();
          return (pSym === sym || pSym.startsWith(baseAsset)) && Math.abs(p.perp?.baseSize ?? 0) > MIN_POS_SIZE;
        });
        const currentPosSize = pos ? Math.abs(pos.perp?.baseSize ?? 0) : 0;

        // ── Phase 1: Identify and lock onto our specific order ──
        if (trackedOrderIdRef.current === null) {
          const ourOrder = findOurOrder(orders);
          if (ourOrder) {
            // Found our order — track it by ID
            trackedOrderIdRef.current = ourOrder.orderId ?? ourOrder.id ?? "matched";
            posSnapshotRef.current = currentPosSize;
            // Capture real placement time from API (if available)
            if (ourOrder.placedAt) {
              const apiTime = new Date(ourOrder.placedAt).getTime();
              if (!isNaN(apiTime) && apiTime > 0) {
                setRealPlacedAt(apiTime);
                try { sessionStorage.setItem(orderTimeKey, String(apiTime)); } catch { /* quota */ }
              }
            }
            scheduleNext();
            return;
          }
          // Order not in open orders yet (may still be settling) or already filled instantly
          // Wait a few more polls before deciding
          if (Date.now() - startTime < 30_000) {
            // Order might not be on-chain yet — keep waiting
            scheduleNext();
            return;
          }
          // After 30s, if never found in open orders, check position
          if (currentPosSize > 0 && pos && active) {
            // Position exists and we never saw the order → instant fill
            setPositionData(buildPosition(pos));
            setOrderState("filled");
            return;
          }
          // No order, no position → probably cancelled before reaching chain
          if (active) setOrderState("cancelled");
          return;
        }

        // ── Phase 2: Track our identified order ──
        const trackedId = trackedOrderIdRef.current;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const orderStillExists = trackedId === "matched"
          ? !!findOurOrder(orders) // re-match by attributes if no unique ID
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : orders.some((o: any) => (o.orderId ?? o.id) === trackedId);

        if (orderStillExists) {
          // Order still pending — track partial fill progress
          // Remaining size from the order itself (most accurate)
          const ourOrder = trackedId === "matched"
            ? findOurOrder(orders)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            : orders.find((o: any) => (o.orderId ?? o.id) === trackedId);
          const remainingSize = ourOrder ? Math.abs(ourOrder.size ?? size) : size;
          const filledAmount = Math.max(0, size - remainingSize);
          const fillPct = size > 0 ? (filledAmount / size) * 100 : 0;

          // Also check position growth as secondary signal
          const baseline = posSnapshotRef.current ?? 0;
          const posGrowth = Math.max(0, currentPosSize - baseline);
          const bestFilled = Math.max(filledAmount, posGrowth);
          const bestPct = size > 0 ? Math.min(100, (bestFilled / size) * 100) : 0;

          // Only update state if values actually changed (avoid unnecessary re-renders)
          if (active) {
            setFillProgress(prev => {
              if (Math.abs(prev.percent - bestPct) < 0.01) return prev;
              return { filled: bestFilled, remaining: size - bestFilled, percent: bestPct };
            });
          }
          posSnapshotRef.current = currentPosSize;
          scheduleNext();
          return;
        }

        // ── Order disappeared — determine if filled or cancelled ──
        const snapshotSize = posSnapshotRef.current ?? 0;
        const posGrew = currentPosSize > snapshotSize + MIN_POS_SIZE;

        if (pos && posGrew && active) {
          // Position grew after order disappeared → filled
          setPositionData(buildPosition(pos));
          setOrderState("filled");
          return;
        }

        if (!posGrew && active) {
          // Order gone but position didn't grow → cancelled
          // BUT: give it one more check — fill might be settling
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 3000);
            const prevCleanup = () => { clearTimeout(t); resolve(); };
            if (!active) { clearTimeout(t); resolve(); return; }
            // Store so effect cleanup can cancel
            timerRef = t as unknown as ReturnType<typeof setTimeout>;
          });
          if (!active) return;
          const res2 = await fetch(`/api/account?_t=${Date.now()}`);
          if (res2.ok) {
            const data2 = await res2.json();
            const positions2 = data2.positions ?? [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pos2 = positions2.find((p: any) => {
              const pSym = (p.symbol ?? "").toUpperCase();
              return (pSym === sym || pSym.startsWith(baseAsset)) && Math.abs(p.perp?.baseSize ?? 0) > MIN_POS_SIZE;
            });
            const newSize = pos2 ? Math.abs(pos2.perp?.baseSize ?? 0) : 0;
            if (newSize > snapshotSize + MIN_POS_SIZE && pos2 && active) {
              setPositionData(buildPosition(pos2));
              setOrderState("filled");
              return;
            }
          }
          if (active) setOrderState("cancelled");
          return;
        }
      } catch { /* retry */ }

      scheduleNext();
    };

    const scheduleNext = () => {
      if (!active) return;
      const nextInterval = getInterval();
      if (nextInterval !== null) {
        timerRef = setTimeout(check, nextInterval);
      } else if (active) {
        setOrderState("expired");
      }
    };

    // Instant check when tab becomes visible
    const onVisibility = () => {
      if (!document.hidden && active) {
        if (timerRef) clearTimeout(timerRef);
        check();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    timerRef = setTimeout(check, 3000);

    return () => {
      active = false;
      if (timerRef) clearTimeout(timerRef);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sym, baseAsset, limitPrice, leverage, isLong, side]);

  // ── Filled → LivePositionCard ──
  if (orderState === "filled" && positionData) {
    return (
      <LivePositionCard
        initialPos={positionData}
        txHash={txHash}
        realtimePrices={realtimePrices}
        onSendMessage={onSendMessage}
      />
    );
  }

  // ── Cancelled ──
  if (orderState === "cancelled") {
    return (
      <div className="my-2 w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-background opacity-50">
        <div className="border-b border-border px-4 py-2 flex items-center gap-2">
          <span className="text-muted">✗</span>
          <span className="text-sm font-semibold text-muted">Limit Order Cancelled</span>
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted">{baseAsset}/USD</span>
              <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${isLong ? "bg-green-500/10 text-green-400/50" : "bg-red-500/10 text-red-400/50"}`}>{side}</span>
              <span className="text-xs font-mono text-muted">{size.toFixed(4)}</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-muted">CANCELLED</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div><span className="text-muted">Limit</span><div className="font-mono text-muted">{fmtPrice(limitPrice)}</div></div>
            <div><span className="text-muted">Notional</span><div className="font-mono text-muted">${(size * limitPrice).toFixed(2)}</div></div>
          </div>
          {txHash && <div className="mt-2 text-[10px] text-muted">Tx: {formatTxHash(txHash)}</div>}
        </div>
      </div>
    );
  }

  // ── Expired polling (order may still be active, WS prices still live) ──
  if (orderState === "expired") {
    return (
      <div className={`my-2 w-full max-w-lg overflow-hidden rounded-xl border ${isLong ? "border-green-500/30" : "border-red-500/30"} bg-background`}>
        <div className="border-b border-border px-4 py-2 flex items-center gap-2">
          <span className="text-sm font-semibold text-yellow-400">Limit Order</span>
          <span className="ml-auto text-[10px] text-muted">Auto-check paused — check Portfolio</span>
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">{baseAsset}/USD</span>
              <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${isLong ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>{side}</span>
              <span className="text-xs font-mono text-foreground">{size.toFixed(4)}</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div><span className="text-muted">Limit</span><div className="font-mono text-foreground">{fmtPrice(limitPrice)}</div></div>
            <div><span className="text-muted">Market (last)</span><div className="font-mono text-foreground">{fmtPrice(liveMarkPrice)}</div></div>
            <div><span className="text-muted">Distance</span><div className={`font-mono ${isClose ? "text-yellow-400" : "text-muted"}`}>{rawDistance >= 0 ? "+" : ""}{rawDistance.toFixed(2)}%</div></div>
          </div>
        </div>
      </div>
    );
  }

  // ── Pending — live order card ──
  return (
    <div className={`my-2 w-full max-w-lg overflow-hidden rounded-xl border ${isLong ? "border-green-500/30" : "border-red-500/30"} bg-background`}>
      {/* Header */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-400" />
        <span className="text-sm font-semibold text-yellow-400">Limit Order Active</span>
        <span className="ml-auto text-[10px] text-muted">{fmtElapsed(elapsed)}</span>
      </div>

      <div className="px-4 py-3">
        {/* Market + Side */}
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{baseAsset}/USD</span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-muted">{leverage}x</span>
          </div>
          <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${isLong ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
            {side}
          </span>
        </div>

        {/* Prices */}
        <div className="grid grid-cols-3 gap-2 text-xs mb-2.5">
          <div>
            <span className="text-muted">Limit Price</span>
            <div className="font-mono text-foreground">{fmtPrice(limitPrice)}</div>
          </div>
          <div>
            <span className="text-muted">Market Price</span>
            <div className={`font-mono ${isVeryClose ? "text-yellow-400 font-semibold" : "text-foreground"}`}>{fmtPrice(liveMarkPrice)}</div>
          </div>
          <div>
            <span className="text-muted">Distance</span>
            <div className={`font-mono ${isVeryClose ? "text-yellow-400 font-semibold" : isClose ? "text-yellow-400" : "text-muted"}`}>
              {rawDistance >= 0 ? "+" : ""}{rawDistance.toFixed(2)}%
            </div>
          </div>
        </div>

        {/* Size — with fill progress */}
        <div className="grid grid-cols-3 gap-2 text-xs mb-2.5">
          <div>
            <span className="text-muted">Total Size</span>
            <div className="font-mono text-foreground">{size.toFixed(4)}</div>
          </div>
          <div>
            <span className="text-muted">Filled</span>
            <div className={`font-mono ${fillProgress.percent > 0 ? "text-green-400" : "text-muted"}`}>
              {fillProgress.filled > 0 ? fillProgress.filled.toFixed(4) : "0"}
            </div>
          </div>
          <div>
            <span className="text-muted">Remaining</span>
            <div className="font-mono text-foreground">{fillProgress.remaining.toFixed(4)}</div>
          </div>
        </div>

        {/* Fill progress */}
        <div className="mb-2.5">
          <div className="flex justify-between text-[10px] mb-1">
            <span className={fillProgress.percent > 0 ? "text-green-400 font-medium" : "text-muted"}>
              Filled: {fillProgress.percent > 0 ? `${fillProgress.percent.toFixed(1)}%` : "0%"}
            </span>
            <span className={isVeryClose ? "text-yellow-400" : isClose ? "text-yellow-400/70" : "text-muted"}>
              {isVeryClose ? "Price very close" : isClose ? "Price approaching" : "Waiting for price"}
            </span>
          </div>
          {fillProgress.percent > 0 && (
            <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-green-400 transition-all duration-700"
                style={{ width: `${fillProgress.percent}%` }}
              />
            </div>
          )}
        </div>

        {/* Tx hash */}
        {txHash && <div className="mt-2 text-[10px] text-muted">Tx: {formatTxHash(txHash)}</div>}

        {/* Cancel button */}
        {onSendMessage && (
          <button
            onClick={() => onSendMessage(`cancel ${baseAsset} limit order`)}
            className="mt-3 w-full rounded-lg border border-red-500/30 bg-red-500/5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
          >
            Cancel Order
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Order Preview Card ──────────────────────────────────────────

function OrderPreviewCard({ data, realtimePrices, onSendMessage }: { data: Record<string, unknown>; realtimePrices?: Record<string, number>; onSendMessage?: (msg: string) => void }) {
  const { executeOrder, status, error, txHash, reset, recheck, hasSession } = useOrderExecution();

  const market = data.market as string;
  const side = data.side as "Long" | "Short";
  const size = data.size as number;
  const leverage = data.leverage as number;
  const entryPrice = data.estimatedEntryPrice as number;
  const orderType = data.orderType as string | undefined;
  // For limit orders, the limit price is stored in estimatedEntryPrice or limitPrice
  const limitPrice = (data.limitPrice as number | undefined) ?? (orderType === "limit" ? entryPrice : undefined);
  const previewId = data.previewId as string;
  const isExecuted = previewId ? isPreviewConsumed(previewId) : false;
  const isLong = side === "Long";
  const borderColor = isLong ? "border-green-500/30" : "border-red-500/30";
  const sideColor = isLong ? "text-green-400" : "text-red-400";
  const sideBg = isLong ? "bg-green-500/10" : "bg-red-500/10";
  const fmtEntry = entryPrice ? "$" + entryPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

  const isLimit = (orderType ?? "market") === "limit";
  const baseAssetPreview = baseAssetFrom(market);

  // Toast on status change
  const toastLabels = useMemo(() => ({
    confirmed: {
      title: isLimit ? "Limit Order Placed" : "Position Opened",
      message: `${baseAssetPreview} ${side} ${size?.toFixed(4)} @ ${fmtEntry}`,
    },
    error: { title: isLimit ? "Limit Order Failed" : "Order Failed" },
  }), [isLimit, baseAssetPreview, side, size, fmtEntry]);
  useStatusToast(status, error, toastLabels);

  // On page reload: if preview was consumed but position cache is empty,
  // fetch account data to determine actual state:
  // - Position exists → hydrate cache → LivePositionCard
  // - Open order exists → LiveOrderCard
  // - Neither → static "Order Completed" (everything closed already)
  const [reloadChecked, setReloadChecked] = useState(!isExecuted);
  const [reloadState, setReloadState] = useState<"loading" | "position" | "order" | "completed">("loading");
  useEffect(() => {
    if (!isExecuted || reloadChecked) return;
    if (previewId && getConfirmedPosition(previewId)) { setReloadState("position"); setReloadChecked(true); return; }
    (async () => {
      try {
        const res = await fetch(`/api/account?_t=${Date.now()}`);
        if (!res.ok) { setReloadState("completed"); setReloadChecked(true); return; }
        const acc = await res.json();
        const sym = normSym(market);
        const ba = baseAssetFrom(sym);
        // Check for position
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pos = (acc.positions ?? []).find((p: any) => {
          const pSym = (p.symbol ?? "").toUpperCase();
          return (pSym === sym || pSym.startsWith(ba)) && Math.abs(p.perp?.baseSize ?? 0) > MIN_POS_SIZE;
        });
        if (pos && previewId) {
          const { confirmedPositionsCache } = await import("@/hooks/useOrderExecution");
          confirmedPositionsCache.set(previewId, {
            symbol: pos.symbol ?? sym, baseAsset: pos.baseAsset ?? ba,
            side: pos.perp?.isLong ? "Long" : "Short",
            size: pos.perp?.baseSize ?? 0, absSize: Math.abs(pos.perp?.baseSize ?? 0),
            entryPrice: pos.perp?.price ?? 0, markPrice: pos.markPrice ?? pos.perp?.price ?? 0,
            positionValue: Math.abs(pos.perp?.baseSize ?? 0) * (pos.markPrice ?? 0),
            unrealizedPnl: pos.perp?.sizePricePnl ?? 0, fundingPnl: pos.perp?.fundingPnl ?? 0,
            liqPrice: pos.liqPrice ?? 0, usedMargin: pos.usedMargin ?? 0,
            maxLeverage: pos.maxLeverage ?? 1, pnlPercent: 0,
          });
          setReloadState("position");
          setReloadChecked(true);
          return;
        }
        // Check for open order in this market
        const orders = acc.orders ?? acc.openOrders ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hasOrder = orders.some((o: any) => {
          const oSym = (o.symbol ?? o.marketSymbol ?? "").toUpperCase();
          return oSym === sym || oSym.startsWith(ba);
        });
        setReloadState(hasOrder ? "order" : "completed");
      } catch { setReloadState("completed"); }
      setReloadChecked(true);
    })();
  }, [isExecuted, reloadChecked, previewId, market]);

  const handleExecute = () => {
    executeOrder({ market, side, size, leverage, estimatedEntryPrice: entryPrice, orderType, price: limitPrice, previewId });
  };

  // Show loading while hydrating cache on reload
  if (!reloadChecked) {
    return (
      <div className={`my-2 w-full max-w-lg overflow-hidden rounded-xl border ${borderColor} bg-background p-4`}>
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm text-muted">Loading position data...</span>
        </div>
      </div>
    );
  }

  // ── PRIORITY 1: Loading states always win (prevents isExecuted from skipping loading) ──
  if (status === "signing" || status === "submitting" || status === "verifying") {
    const isLimitLoading = (orderType ?? "market") === "limit";
    const headerText = isLimitLoading ? "Placing Limit Order" : "Opening Position";
    const stepLabel = status === "signing"
      ? (hasSession ? "Submitting order..." : "Sign in wallet to create session...")
      : status === "submitting"
        ? "Sending to 01 Exchange..."
        : isLimitLoading
          ? "Verifying order on-chain..."
          : "Verifying position on-chain...";
    const stepIndex = status === "signing" ? 0 : status === "submitting" ? 1 : 2;

    return (
      <div className={`my-2 w-full max-w-lg overflow-hidden rounded-xl border ${borderColor} bg-background`}>
        <div className="border-b border-border px-4 py-2.5 flex items-center gap-2.5">
          <svg className="h-4 w-4 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm font-semibold text-blue-400">{headerText}</span>
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${sideBg} ${sideColor}`}>{side}</span>
              <span className="text-sm font-semibold text-foreground">{market}</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-muted">{leverage}x</span>
            </div>
            {isLimitLoading && <span className="text-[10px] text-muted">limit</span>}
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs mb-3">
            <div><span className="text-muted">Size</span><div className="font-mono text-foreground">{size?.toFixed(4)}</div></div>
            <div><span className="text-muted">{isLimitLoading ? "Limit Price" : "Entry"}</span><div className="font-mono text-foreground">{fmtEntry}</div></div>
            <div><span className="text-muted">Margin</span><div className="font-mono text-foreground">{formatUsd(data.marginRequired as number)}</div></div>
          </div>
          <div className="flex items-center gap-1.5 mb-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-500 ${
                i < stepIndex ? "bg-blue-400" : i === stepIndex ? "bg-blue-400 animate-pulse" : "bg-white/10"
              }`} />
            ))}
          </div>
          <div className="text-xs text-blue-400">{stepLabel}</div>
          {txHash && <div className="mt-1 text-[10px] text-muted">Tx: {formatTxHash(txHash)}</div>}
        </div>
      </div>
    );
  }

  // ── PRIORITY 2: Confirmed state ──
  if (status === "confirmed" || isExecuted) {
    const isLimitConfirmed = (orderType ?? "market") === "limit";

    // Check if position already exists (instant fill for limits, or normal market fill)
    const cachedPos = previewId ? getConfirmedPosition(previewId) : null;
    if (cachedPos) {
      return (
        <LivePositionCard
          initialPos={cachedPos as unknown as PositionData}
          txHash={txHash}
          realtimePrices={realtimePrices}
          onSendMessage={onSendMessage}
        />
      );
    }

    // After reload: everything already closed → static completed card
    if (isExecuted && reloadState === "completed") {
      return (
        <div className={`my-2 w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-background opacity-40`}>
          <div className="border-b border-border px-4 py-2 flex items-center gap-2">
            <span className="text-muted">✓</span>
            <span className="text-sm font-semibold text-muted">{isLimitConfirmed ? "Limit Order Completed" : "Order Completed"}</span>
          </div>
          <div className="px-4 py-3 text-xs text-muted">
            {market} {side} {size?.toFixed(4)} @ {fmtEntry}
          </div>
        </div>
      );
    }

    // Limit orders: show live order card
    // Fresh confirmed (status==="confirmed") → always show LiveOrderCard
    // Reload (isExecuted, status==="idle") → show only if reloadState==="order"
    const isFreshConfirm = status === "confirmed";
    if (isLimitConfirmed && (isFreshConfirm || reloadState === "order")) {
      return (
        <LiveOrderCard
          market={market}
          side={side}
          size={size}
          limitPrice={limitPrice ?? entryPrice}
          leverage={leverage}
          txHash={txHash}
          realtimePrices={realtimePrices}
          onSendMessage={onSendMessage}
        />
      );
    }

    // After reload: still loading account data — show spinner instead of stale "Order Submitted"
    if (isExecuted && reloadState === "loading") {
      return (
        <div className={`my-2 w-full max-w-lg overflow-hidden rounded-xl border ${borderColor} bg-background p-4`}>
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm text-muted">Loading position data...</span>
          </div>
        </div>
      );
    }

    // Market fallback: confirmed but position not yet cached
    return (
      <div className={`my-2 w-full max-w-lg overflow-hidden rounded-xl border border-green-500/30 bg-background ${isExecuted ? "opacity-40" : ""}`}>
        <div className="border-b border-border px-4 py-2 flex items-center gap-2">
          <span className="text-green-400">✓</span>
          <span className="text-sm font-semibold text-green-400">Order Submitted</span>
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${sideBg} ${sideColor}`}>{side}</span>
              <span className="text-sm font-semibold text-foreground">{market}</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-muted">{leverage}x</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div><span className="text-muted">Size</span><div className="font-mono text-foreground">{size?.toFixed(4)}</div></div>
            <div><span className="text-muted">Entry</span><div className="font-mono text-foreground">{fmtEntry}</div></div>
            <div><span className="text-muted">Margin</span><div className="font-mono text-foreground">{formatUsd(data.marginRequired as number)}</div></div>
          </div>
          {txHash && <div className="mt-2 text-[10px] text-muted">Tx: {formatTxHash(txHash)}</div>}
          {error && !isExecuted && (
            <div className="mt-2 text-[11px] text-yellow-400">{error}</div>
          )}
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (status === "error") {
    // String matching is used here because the verification API returns plain error messages
    // (not structured error codes). Case-insensitive to handle message variations across SDK versions.
    const errorLower = error?.toLowerCase() ?? "";
    const isVerifyError = errorLower.includes("not found") || errorLower.includes("still appears");
    const isMarket = (orderType ?? "market") === "market";
    return (
      <div className={`my-2 rounded-xl border border-red-500/30 bg-red-500/5 p-4`}>
        <div className="flex items-center gap-2">
          <span className="text-red-400">✗</span>
          <span className="text-sm font-medium text-red-400">Order Failed</span>
        </div>
        <div className="mt-1 text-xs text-red-400/80">{error}</div>
        <div className="mt-2 text-xs text-muted">{market} {side} {fmtSize(size)} @ {fmtEntry}</div>
        {isVerifyError ? (
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => recheck(market, isMarket ? "position" : "order")}
              className="flex-1 rounded-lg border border-blue-500/30 bg-blue-500/5 py-2 text-xs font-medium text-blue-400 hover:bg-blue-500/10 transition-colors"
            >
              Check Again
            </button>
          </div>
        ) : (
          <button
            onClick={() => { reset(previewId); handleExecute(); }}
            className="mt-3 w-full rounded-lg border border-blue-500/30 bg-blue-500/5 py-2 text-xs font-medium text-blue-400 hover:bg-blue-500/10 transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  // ── Idle state — show preview + Execute button ──
  return (
    <div className={`my-2 rounded-xl border ${borderColor} bg-background p-4`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${sideBg} ${sideColor}`}>
            {side}
          </span>
          <span className="text-sm font-semibold text-foreground">{market}</span>
          <span className="text-xs text-muted">{leverage}x</span>
        </div>
        <span className="text-[10px] text-muted">{orderType ?? "market"}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted">Size</span>
          <div className="font-mono text-foreground">{fmtSize(size)}</div>
        </div>
        <div>
          <span className="text-muted">Notional</span>
          <div className="font-mono text-foreground">{formatUsd(data.notionalValue as number)}</div>
        </div>
        <div>
          <span className="text-muted">Entry Price</span>
          <div className="font-mono text-foreground">{fmtEntry}</div>
        </div>
        <div>
          <span className="text-muted">Liq. Price</span>
          <div className="font-mono text-red-400">{(data.estimatedLiquidationPrice as number) > 0 ? formatUsd(data.estimatedLiquidationPrice as number) : "—"}</div>
        </div>
        <div>
          <span className="text-muted">Margin Required</span>
          <div className="font-mono text-foreground">{formatUsd(data.marginRequired as number)}</div>
        </div>
        <div>
          <span className="text-muted">Est. Fee</span>
          <div className="font-mono text-foreground">{formatUsd(data.estimatedFee as number)}</div>
        </div>
      </div>

      {(data.warnings as string[])?.length > 0 && (
        <div className="mt-3 space-y-1">
          {(data.warnings as string[]).map((w, i) => (
            <div key={i} className="text-[11px] text-yellow-400">{w}</div>
          ))}
        </div>
      )}

      <button
        onClick={handleExecute}
        className={`mt-3 w-full rounded-lg py-2.5 text-sm font-medium text-white transition-colors ${isLong ? "bg-green-600 hover:bg-green-500" : "bg-red-600 hover:bg-red-500"}`}
      >
        {hasSession ? "Execute Order" : "Sign & Execute Order"}
      </button>
    </div>
  );
}

// ─── Close Position Card ─────────────────────────────────────────

function ClosePositionCard({ data }: { data: Record<string, unknown> }) {
  const { executeClose, status, error, txHash, reset, recheck, hasSession } = useOrderExecution();

  const market = data.market as string;
  const side = data.side as "Long" | "Short";
  const closeSize = data.closeSize as number;
  const pnl = data.estimatedPnl as number;
  const previewId = data.previewId as string | undefined;
  const isExecuted = previewId ? isPreviewConsumed(previewId) : false;
  const pnlColor = pnl >= 0 ? "text-green-400" : "text-red-400";
  const closeBaseAsset = baseAssetFrom(market);

  // Toast on status change
  const closeToasts = useMemo(() => ({
    confirmed: {
      title: "Position Closed",
      message: `${closeBaseAsset} ${side} ${fmtSize(closeSize)} — PnL: ${formatUsd(pnl)}`,
    },
    error: { title: "Close Failed" },
  }), [closeBaseAsset, side, closeSize, pnl]);
  useStatusToast(status, error, closeToasts);

  const handleClose = () => {
    executeClose({ market, side, size: closeSize, previewId });
  };

  // ── PRIORITY 1: Loading states always win ──
  if (status === "signing" || status === "submitting" || status === "verifying") {
    const stepLabel = status === "signing"
      ? (hasSession ? "Submitting close..." : "Sign in wallet...")
      : status === "submitting"
        ? "Sending to 01 Exchange..."
        : "Verifying position closed...";
    const stepIndex = status === "signing" ? 0 : status === "submitting" ? 1 : 2;

    return (
      <div className="my-2 w-full max-w-lg overflow-hidden rounded-xl border border-orange-500/30 bg-background">
        <div className="border-b border-border px-4 py-2.5 flex items-center gap-2.5">
          <svg className="h-4 w-4 animate-spin text-orange-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm font-semibold text-orange-400">Closing Position</span>
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-orange-400">CLOSE</span>
              <span className="text-sm font-semibold text-foreground">{market}</span>
              <span className="text-xs text-muted">{side}</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs mb-3">
            <div><span className="text-muted">Close Size</span><div className="font-mono text-foreground">{fmtSize(closeSize)}</div></div>
            <div><span className="text-muted">Price</span><div className="font-mono text-foreground">{formatUsd(data.currentPrice as number)}</div></div>
            <div><span className="text-muted">Est. PnL</span><div className={`font-mono ${pnlColor}`}>{formatUsd(pnl)}</div></div>
          </div>
          <div className="flex items-center gap-1.5 mb-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-500 ${
                i < stepIndex ? "bg-orange-400" : i === stepIndex ? "bg-orange-400 animate-pulse" : "bg-white/10"
              }`} />
            ))}
          </div>
          <div className="text-xs text-orange-400">{stepLabel}</div>
          {txHash && <div className="mt-1 text-[10px] text-muted">Tx: {formatTxHash(txHash)}</div>}
        </div>
      </div>
    );
  }

  // ── PRIORITY 2: Confirmed ──
  if (status === "confirmed") {
    return (
      <div className="my-2 rounded-xl border border-green-500/30 bg-green-500/5 p-4">
        <div className="flex items-center gap-2">
          <span className="text-green-400">✓</span>
          <span className="text-sm font-medium text-green-400">Position Closed</span>
        </div>
        <div className="mt-1 text-xs text-muted">{market} {side} — {fmtSize(closeSize)}</div>
        {txHash && <div className="mt-1 text-[10px] text-muted">Tx: {formatTxHash(txHash)}</div>}
      </div>
    );
  }

  // ── PRIORITY 3: Error ──
  if (status === "error") {
    const isVerifyError = error?.includes("not found") || error?.includes("still appears") || error?.includes("still open");
    return (
      <div className="my-2 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <div className="text-sm font-medium text-red-400">Close Failed</div>
        <div className="mt-1 text-xs text-red-400/80">{error}</div>
        {isVerifyError ? (
          <button onClick={() => recheck(market, "close")}
            className="mt-2 w-full rounded-lg border border-blue-500/30 bg-blue-500/5 py-2 text-xs font-medium text-blue-400 hover:bg-blue-500/10 transition-colors">
            Check Again
          </button>
        ) : (
          <button onClick={() => { reset(previewId); handleClose(); }}
            className="mt-2 w-full rounded-lg border border-orange-500/30 bg-orange-500/5 py-2 text-xs font-medium text-orange-400 hover:bg-orange-500/10 transition-colors">
            Retry
          </button>
        )}
      </div>
    );
  }

  // ── PRIORITY 4: Already executed (page reload) ──
  if (isExecuted) {
    return (
      <div className="my-2 rounded-xl border border-green-500/30 bg-green-500/5 p-4 opacity-40 pointer-events-none">
        <div className="flex items-center gap-2">
          <span className="text-green-400">✓</span>
          <span className="text-sm font-medium text-green-400">Position Closed</span>
        </div>
        <div className="mt-1 text-xs text-muted">{market} {side} — {fmtSize(closeSize)}</div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-orange-500/30 bg-background p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-bold text-orange-400">CLOSE</span>
        <span className="text-sm font-semibold text-foreground">{market}</span>
        <span className="text-xs text-muted">{side}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <div>
          <span className="text-muted">Close Size</span>
          <div className="font-mono text-foreground">{fmtSize(closeSize)} ({String(data.closePercentage)}%)</div>
        </div>
        <div>
          <span className="text-muted">Current Price</span>
          <div className="font-mono text-foreground">{formatUsd(data.currentPrice as number)}</div>
        </div>
        <div>
          <span className="text-muted">Entry Price</span>
          <div className="font-mono text-foreground">{formatUsd(data.entryPrice as number)}</div>
        </div>
        <div>
          <span className="text-muted">Est. PnL</span>
          <div className={`font-mono ${pnlColor}`}>{formatUsd(pnl)}</div>
        </div>
      </div>

      <button
        onClick={handleClose}
        className="w-full rounded-lg bg-orange-600 py-2.5 text-sm font-medium text-white hover:bg-orange-500 transition-colors"
      >
        {hasSession ? "Close Position" : "Sign & Close Position"}
      </button>
    </div>
  );
}

// ─── Cancel Order Card ───────────────────────────────────────────

function CancelOrderCard({ data }: { data: Record<string, unknown> }) {
  const { addToast } = useToast();
  const [cancelState, setCancelState] = useState<"idle" | "cancelling" | "confirmed" | "error">("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);

  const market = data.market as string;
  const orderId = data.orderId as string | number;
  const side = data.side as string;
  const size = data.size as number;
  const price = data.price as number;
  const cancelBaseAsset = baseAssetFrom(market);

  const handleCancel = async () => {
    if (cancelState === "cancelling") return;
    setCancelState("cancelling");
    setCancelError(null);
    try {
      const res = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", orderId: String(orderId) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to cancel order");
      }
      setCancelState("confirmed");
      addToast({ type: "success", title: "Order Cancelled", message: `${cancelBaseAsset} ${side} @ ${formatUsd(price)}`, duration: 5000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Cancel failed";
      setCancelState("error");
      setCancelError(msg);
      addToast({ type: "error", title: "Cancel Failed", message: msg, duration: 6000 });
    }
  };

  // Loading
  if (cancelState === "cancelling") {
    return (
      <div className="my-2 rounded-xl border border-orange-500/30 bg-background p-4">
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 animate-spin text-orange-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm font-medium text-orange-400">Cancelling order...</span>
        </div>
        <div className="mt-1 text-xs text-muted">{market} {side} @ {formatUsd(price)}</div>
      </div>
    );
  }

  if (cancelState === "confirmed") {
    return (
      <div className="my-2 rounded-xl border border-green-500/30 bg-green-500/5 p-4 opacity-40">
        <div className="flex items-center gap-2">
          <span className="text-green-400">✓</span>
          <span className="text-sm font-medium text-green-400">Order Cancelled</span>
        </div>
        <div className="mt-1 text-xs text-muted">{market} {side} {(size ?? 0).toFixed(4)} @ {formatUsd(price)}</div>
      </div>
    );
  }

  if (cancelState === "error") {
    return (
      <div className="my-2 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <div className="text-sm font-medium text-red-400">Cancel Failed</div>
        <div className="mt-1 text-xs text-red-400/80">{cancelError}</div>
        <button onClick={handleCancel}
          className="mt-2 w-full rounded-lg border border-orange-500/30 bg-orange-500/5 py-2 text-xs font-medium text-orange-400 hover:bg-orange-500/10 transition-colors">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-orange-500/30 bg-background p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-bold text-orange-400">CANCEL</span>
        <span className="text-sm font-semibold text-foreground">{market}</span>
        <span className={`text-xs ${side === "Buy" ? "text-green-400" : "text-red-400"}`}>{side}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <div>
          <span className="text-muted">Size</span>
          <div className="font-mono text-foreground">{(size ?? 0).toFixed(4)}</div>
        </div>
        <div>
          <span className="text-muted">Price</span>
          <div className="font-mono text-foreground">{formatUsd(price)}</div>
        </div>
      </div>
      <button
        onClick={handleCancel}
        className="w-full rounded-lg bg-orange-600 py-2.5 text-sm font-medium text-white hover:bg-orange-500 transition-colors"
      >
        Cancel Order
      </button>
    </div>
  );
}

// ─── Trigger Card ────────────────────────────────────────────────

function TriggerCard({ data }: { data: Record<string, unknown> }) {
  const { executeTrigger, status, error, txHash, reset, hasSession } = useOrderExecution();

  const market = data.market as string;
  const side = data.side as "Long" | "Short";
  const triggerPrice = data.triggerPrice as number;
  const kindLabel = (data.kind as string) || "Trigger"; // "Stop-Loss" or "Take-Profit"
  // Map display label to SDK kind
  const sdkKind = kindLabel?.includes("Stop") ? "StopLoss" : "TakeProfit";
  const isStopLoss = kindLabel?.includes("Stop");
  const color = isStopLoss ? "border-red-500/30" : "border-green-500/30";
  const textColor = isStopLoss ? "text-red-400" : "text-green-400";

  const triggerBaseAsset = baseAssetFrom(market);

  // Toast on status change
  const triggerToasts = useMemo(() => ({
    confirmed: {
      title: `${kindLabel} Set`,
      message: `${triggerBaseAsset} @ ${formatUsd(triggerPrice)}`,
    },
    error: { title: `${kindLabel} Failed` },
  }), [kindLabel, triggerBaseAsset, triggerPrice]);
  useStatusToast(status, error, triggerToasts);

  const handleActivate = () => {
    executeTrigger({ market, side, triggerPrice, kind: sdkKind as "StopLoss" | "TakeProfit" });
  };

  // ── PRIORITY 1: Loading ──
  if (status === "signing" || status === "submitting" || status === "verifying") {
    return (
      <div className={`my-2 rounded-xl border ${color} bg-background/50 p-4`}>
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm font-medium text-blue-400">{status === "verifying" ? "Verifying..." : `Setting ${kindLabel}...`}</span>
        </div>
        <div className="mt-1 text-xs text-muted">{market} @ {formatUsd(triggerPrice)}</div>
      </div>
    );
  }

  // ── PRIORITY 2: Confirmed ──
  if (status === "confirmed") {
    return (
      <div className={`my-2 rounded-xl border border-green-500/30 bg-green-500/5 p-4`}>
        <div className="flex items-center gap-2">
          <span className="text-green-400">✓</span>
          <span className="text-sm font-medium text-green-400">{kindLabel} Set</span>
        </div>
        <div className="mt-1 text-xs text-muted">{market} @ {formatUsd(triggerPrice)}</div>
        {txHash && <div className="mt-1 text-[10px] text-muted">Tx: {formatTxHash(txHash)}</div>}
      </div>
    );
  }

  // ── PRIORITY 3: Error ──
  if (status === "error") {
    return (
      <div className={`my-2 rounded-xl border border-red-500/30 bg-red-500/5 p-4`}>
        <div className="text-sm font-medium text-red-400">{kindLabel} Failed</div>
        <div className="mt-1 text-xs text-red-400/80">{error}</div>
        <button onClick={() => { reset(); handleActivate(); }}
          className="mt-2 w-full rounded-lg border border-blue-500/30 bg-blue-500/5 py-2 text-xs font-medium text-blue-400 hover:bg-blue-500/10 transition-colors">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={`my-2 rounded-xl border ${color} bg-background p-4`}>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold ${textColor}`}>{kindLabel}</span>
        <span className="text-sm font-semibold text-foreground">{market}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted">Trigger Price</span>
          <div className="font-mono text-foreground">{formatUsd(triggerPrice)}</div>
        </div>
        <div>
          <span className="text-muted">Entry Price</span>
          <div className="font-mono text-foreground">{formatUsd(data.entryPrice as number)}</div>
        </div>
      </div>
      <div className="mt-1 text-[11px] text-muted">
        {data.percentFromEntry as string}% from entry
      </div>
      <button
        onClick={handleActivate}
        className={`mt-3 w-full rounded-lg py-2.5 text-sm font-medium text-white transition-colors ${isStopLoss ? "bg-red-600 hover:bg-red-500" : "bg-green-600 hover:bg-green-500"}`}
      >
        {hasSession ? `Set ${kindLabel}` : `Sign & Set ${kindLabel}`}
      </button>
    </div>
  );
}

// ─── Shared Components ───────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:300ms]" />
    </div>
  );
}
