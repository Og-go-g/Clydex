"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet/context";
import { useChatSessions } from "@/lib/chat/context";
import { getMessages, saveMessages } from "@/lib/chat/store";
import { syncSessionToDb } from "@/lib/chat/sync";
import { useAuth } from "@/lib/auth/context";

// --- Types for AI SDK message parts ---

interface ToolMessagePart {
  type: string; // "dynamic-tool" | "tool-*"
  toolName?: string;
  toolCallId?: string;
  state?: string;
  output?: Record<string, unknown>;
  errorText?: string;
}

interface PriceData {
  symbol: string;
  name: string;
  priceUsd: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  address?: string;
}

interface TokenData {
  symbol: string;
  priceUsd: number;
  priceChange24h: number;
}

interface YieldPool {
  protocol: string;
  pair: string;
  apy: number;
  apyBase?: number;
  apyReward?: number;
  tvl: number;
}

interface SwapQuoteData {
  fromToken: { symbol: string; address: string; decimals: number };
  toToken: { symbol: string; address: string; decimals: number };
  fromAmount: string;
  fromAmountRaw: string;
  toAmount: string;
  toAmountRaw: string;
  priceImpact: number;
  estimatedGas: number;
  exchangeProxy: string;
  provider: string;
  requestedUsd?: string;
  isMax?: boolean;
  error?: string;
}

// Helper: extract text from a message (handles AI SDK v6 parts + persisted .content)
function msgText(msg: Record<string, unknown>): string {
  const parts = msg.parts as Array<{ type: string; text?: string }> | undefined;
  if (parts) {
    const tp = parts.find((p) => p.type === "text");
    if (tp?.text) return tp.text;
  }
  return typeof msg.content === "string" ? msg.content : "";
}

export default function ChatPage() {
  const { activeId } = useChatSessions();
  if (!activeId) return null;
  // key={activeId} forces full remount when switching chats → clean useChat state
  return <ChatContent key={activeId} chatId={activeId} />;
}

function ChatContent({ chatId }: { chatId: string }) {
  const { address } = useWallet();
  const { isAuthenticated } = useAuth();
  const { renameChat, touchChat, sessions } = useChatSessions();
  const addressRef = useRef(address);
  addressRef.current = address;

  // Load stored messages for this chat
  const initialMessages = useMemo(() => getMessages(chatId), [chatId]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: () => ({
          "x-wallet-address": addressRef.current || "",
        }),
      }),
    []
  );

  const { messages, sendMessage, status, error } = useChat({
    transport,
    id: chatId,
    messages: initialMessages.length > 0 ? initialMessages : undefined,
  });

  const [input, setInput] = useState("");

  // Track how many messages existed on mount (loaded from persistence).
  // Swap cards from persisted messages should be frozen (no refresh, no actions).
  const initialMsgCountRef = useRef(messages.length);

  const isLoading = status === "submitted" || status === "streaming";
  const showWelcome = messages.length === 0;

  // Persist messages to localStorage when streaming finishes
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasStreaming = prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted";
    const nowReady = status === "ready";
    prevStatusRef.current = status;

    if (wasStreaming && nowReady && messages.length > 0) {
      saveMessages(chatId, messages);
      touchChat(chatId);

      // Auto-title: set title from first user message
      let title: string | undefined;
      const session = sessions.find((s) => s.id === chatId);
      if (session?.title === "New Chat") {
        const firstUserMsg = messages.find((m) => m.role === "user");
        if (firstUserMsg) {
          const text = msgText(firstUserMsg as unknown as Record<string, unknown>);
          if (text) {
            title = text.slice(0, 40);
            renameChat(chatId, title);
          }
        }
      }

      // Background sync to database
      if (isAuthenticated) {
        const serializable = messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: (m as unknown as Record<string, unknown>).content as string ?? "",
          parts: m.parts,
          createdAt: (m as unknown as Record<string, unknown>).createdAt as string | undefined,
        }));
        syncSessionToDb(chatId, title ?? session?.title ?? "New Chat", serializable);
      }
    }
  }, [status, messages, chatId, touchChat, renameChat, sessions, isAuthenticated]);

  // Find the last prepareSwap tool call ID — only that card should be actionable.
  // Swap cards are frozen (not refreshing, not actionable) when:
  // 1. They are not the latest swap card
  // 2. A user message was sent after the swap (user moved on)
  // 3. The swap card was loaded from persistence (page remount / navigation)
  const lastSwapToolCallId = useMemo(() => {
    let swapMsgIndex = -1;
    let swapId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const parts = messages[i].parts;
      if (!parts) continue;
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j] as unknown as ToolMessagePart;
        const tn = part.toolName || part.type?.replace("tool-", "");
        if (tn === "prepareSwap" && part.toolCallId) {
          swapMsgIndex = i;
          swapId = part.toolCallId;
          break;
        }
      }
      if (swapId) break;
    }
    if (!swapId) return null;
    // If swap was from persisted messages (existed on mount), freeze it
    if (swapMsgIndex < initialMsgCountRef.current) return null;
    // If any user message exists after the swap, freeze it
    for (let i = swapMsgIndex + 1; i < messages.length; i++) {
      if (messages[i].role === "user") return null;
    }
    return swapId;
  }, [messages]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const onSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput("");
  }, [input, isLoading, sendMessage]);

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {showWelcome && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-relaxed text-foreground">
                <div className="whitespace-pre-wrap">
                  {"Hey! I'm Clydex, your AI DeFi companion. I can help you:\n\n"}
                  {"- "}
                  <strong>Check prices</strong>
                  {" — "}
                  <button type="button" onClick={() => setInput("price of ETH")} className="text-muted underline hover:text-foreground transition-colors">{'"price of ETH"'}</button>
                  {"\n- "}
                  <strong>Swap tokens</strong>
                  {" — "}
                  <button type="button" onClick={() => setInput("swap 10 USDC to ETH")} className="text-muted underline hover:text-foreground transition-colors">{'"swap 10 USDC to ETH"'}</button>
                  {"\n- "}
                  <strong>Find yields</strong>
                  {" — "}
                  <button type="button" onClick={() => setInput("best yields for USDC on Base")} className="text-muted underline hover:text-foreground transition-colors">{'"best yields for USDC on Base"'}</button>
                  {"\n- "}
                  <strong>Top tokens</strong>
                  {" — "}
                  <button type="button" onClick={() => setInput("top tokens on Base")} className="text-muted underline hover:text-foreground transition-colors">{'"top tokens on Base"'}</button>
                  {"\n- "}
                  <strong><Link href="/portfolio" className="text-muted underline hover:text-foreground transition-colors">Portfolio</Link></strong>
                  {" — view multi-chain balances\n\nWhat would you like to do?"}
                </div>
              </div>
            </div>
          )}
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
                  lastSwapToolCallId={lastSwapToolCallId}
                />
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="rounded-2xl border border-border bg-card px-4 py-3">
                <div className="flex gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-muted [animation-delay:0ms]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-muted [animation-delay:150ms]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-muted [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}
          {error && (
            <div className="flex justify-start">
              <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                Error: {error.message}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border bg-background p-4">
        <form
          onSubmit={onSubmit}
          className="mx-auto flex max-w-2xl items-center gap-3"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Clydex anything about DeFi..."
            className="flex-1 rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="rounded-xl bg-accent px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function MessageContent({
  content,
  parts,
  lastSwapToolCallId,
}: {
  content: string;
  parts?: ToolMessagePart[];
  lastSwapToolCallId?: string | null;
}) {
  if (parts && parts.length > 0) {
    return (
      <div className="space-y-2">
        {parts.map((part, i) => {
          if (part.type === "text") {
            const textPart = part as unknown as { type: "text"; text: string };
            return (
              <div key={i} className="whitespace-pre-wrap">
                <SimpleMarkdown text={textPart.text} />
              </div>
            );
          }
          if (part.type === "dynamic-tool" || part.type?.startsWith("tool-")) {
            return <ToolResult key={i} part={part} lastSwapToolCallId={lastSwapToolCallId} />;
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

/** Parse inline markdown tokens from a string into React nodes. */
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
      // **bold** — recurse to handle links inside bold
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

/** Safe markdown renderer — no dangerouslySetInnerHTML. */
function SimpleMarkdown({ text }: { text: string }) {
  if (!text) return null;
  return <span>{parseInline(text)}</span>;
}

function ToolResult({ part, lastSwapToolCallId }: { part: ToolMessagePart; lastSwapToolCallId?: string | null }) {
  const toolName = part.toolName || part.type?.replace("tool-", "");
  const state = part.state;
  const result = part.output;

  if (state === "input-streaming" || state === "input-available") {
    return (
      <div className="my-1 rounded-lg border border-border bg-background p-3 text-xs text-muted">
        Fetching {toolName === "getTokenPrice" ? "price" : toolName === "searchYields" || toolName === "getTopYields" ? "yields" : toolName === "prepareSwap" ? "swap quote" : "data"}...
      </div>
    );
  }

  if (state === "output-error") {
    return (
      <div className="my-1 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400">
        {part.errorText || "Tool call failed"}
      </div>
    );
  }

  if (!result) return null;

  if (result.error) {
    return (
      <div className="my-1 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400">
        {String(result.error)}
      </div>
    );
  }

  switch (toolName) {
    case "getTokenPrice":
      return <PriceCard data={result as unknown as PriceData} />;
    case "getTopTokens":
      return <TokenList data={(result as Record<string, unknown>).tokens as TokenData[]} />;
    case "searchYields":
    case "getTopYields": {
      const r = result as Record<string, unknown>;
      return <YieldTable pools={(r.pools || r.top10) as YieldPool[]} />;
    }
    case "prepareSwap":
      return <SwapCard data={result as unknown as SwapQuoteData} isLatest={part.toolCallId != null && part.toolCallId === lastSwapToolCallId} toolCallId={part.toolCallId} />;
    default:
      return (
        <pre className="my-1 overflow-x-auto rounded-lg bg-background p-3 text-xs">
          {JSON.stringify(result, null, 2)}
        </pre>
      );
  }
}

function PriceCard({ data }: { data: PriceData }) {
  const change = data.priceChange24h;
  const isPositive = change >= 0;
  const [chartPrices, setChartPrices] = useState<number[]>([]);

  useEffect(() => {
    // Map native ETH (null address) to WETH for chart lookup
    const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
    const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";
    const tokenAddr = !data.address || data.address === NULL_ADDRESS
      ? WETH_ADDRESS
      : data.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddr)) return;
    fetch(`/api/chart?token=${tokenAddr}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.prices?.length > 1) setChartPrices(d.prices);
      })
      .catch(() => {});
  }, [data.address]);

  return (
    <div className="my-2 rounded-xl border border-border bg-background p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-muted">{data.name}</div>
          <div className="text-lg font-bold">{data.symbol}</div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold">
            $
            {Number(data.priceUsd).toLocaleString(undefined, {
              maximumFractionDigits: 6,
            })}
          </div>
          <div
            className={`text-sm ${isPositive ? "text-success" : "text-error"}`}
          >
            {isPositive ? "+" : ""}
            {change?.toFixed(2)}%
          </div>
        </div>
      </div>
      {chartPrices.length > 1 && (
        <div className="mt-3">
          <Sparkline prices={chartPrices} positive={isPositive} />
          <div className="mt-1 flex justify-between text-[10px] text-muted">
            <span>7d ago</span>
            <span>Now</span>
          </div>
        </div>
      )}
      <div className="mt-3 flex gap-4 text-xs text-muted">
        <span>Vol 24h: ${formatCompact(data.volume24h)}</span>
        <span>Liq: ${formatCompact(data.liquidity)}</span>
      </div>
    </div>
  );
}

/** SVG sparkline chart — pure client-side, no dependencies. */
function Sparkline({ prices, positive }: { prices: number[]; positive: boolean }) {
  const width = 320;
  const height = 50;
  const padding = 2;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const points = prices.map((p, i) => ({
    x: padding + (i / (prices.length - 1)) * (width - padding * 2),
    y: padding + (1 - (p - min) / range) * (height - padding * 2),
  }));

  // Build smooth path using cubic bezier curves
  const linePath = points
    .map((pt, i) => {
      if (i === 0) return `M ${pt.x} ${pt.y}`;
      const prev = points[i - 1];
      const cpx = (prev.x + pt.x) / 2;
      return `C ${cpx} ${prev.y}, ${cpx} ${pt.y}, ${pt.x} ${pt.y}`;
    })
    .join(" ");

  // Area fill path (line + close to bottom)
  const lastPt = points[points.length - 1];
  const firstPt = points[0];
  const areaPath = `${linePath} L ${lastPt.x} ${height} L ${firstPt.x} ${height} Z`;

  const color = positive ? "#22c55e" : "#ef4444";
  const gradientId = positive ? "sparkGreen" : "sparkRed";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      preserveAspectRatio="none"
      style={{ height: "50px" }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function TokenList({ data }: { data: TokenData[] }) {
  if (!data?.length)
    return <div className="text-xs text-muted">No tokens found</div>;
  return (
    <div className="my-2 space-y-1">
      {data.map((t, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <span className="font-medium">{t.symbol}</span>
          <div className="flex items-center gap-3">
            <span>
              $
              {Number(t.priceUsd).toLocaleString(undefined, {
                maximumFractionDigits: 4,
              })}
            </span>
            <span
              className={`text-xs ${t.priceChange24h >= 0 ? "text-success" : "text-error"}`}
            >
              {t.priceChange24h >= 0 ? "+" : ""}
              {t.priceChange24h?.toFixed(1)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function YieldTable({ pools }: { pools: YieldPool[] }) {
  if (!pools?.length)
    return <div className="text-xs text-muted">No pools found</div>;
  return (
    <div className="my-2 overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-background text-left text-muted">
            <th className="px-3 py-2">Protocol</th>
            <th className="px-3 py-2">Pair</th>
            <th className="px-3 py-2 text-right">APY</th>
            <th className="px-3 py-2 text-right">TVL</th>
          </tr>
        </thead>
        <tbody>
          {pools.map((p, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              <td className="px-3 py-2 capitalize">{p.protocol}</td>
              <td className="px-3 py-2 font-medium">{p.pair}</td>
              <td className="px-3 py-2 text-right font-medium text-success">
                {p.apy?.toFixed(2)}%
              </td>
              <td className="px-3 py-2 text-right text-muted">
                ${formatCompact(p.tvl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Persist / restore swap card final state so it survives navigation & reload
const SWAP_STATE_KEY = "clydex_swap_states";
type SwapPersistedState = { status: "confirmed" | "error"; txHash?: string; errorMsg?: string };

function saveSwapState(id: string, state: SwapPersistedState) {
  try {
    const all = JSON.parse(localStorage.getItem(SWAP_STATE_KEY) || "{}");
    all[id] = state;
    localStorage.setItem(SWAP_STATE_KEY, JSON.stringify(all));
  } catch {}
}
function loadSwapState(id: string): SwapPersistedState | null {
  try {
    const all = JSON.parse(localStorage.getItem(SWAP_STATE_KEY) || "{}");
    return all[id] || null;
  } catch { return null; }
}

function SwapCard({ data, isLatest = true, toolCallId }: { data: SwapQuoteData; isLatest?: boolean; toolCallId?: string }) {
  const { address, chainId, switchToBase } = useWallet();

  // Restore persisted final state (confirmed / error) on mount
  const persisted = toolCallId ? loadSwapState(toolCallId) : null;

  const [status, setStatus] = useState<
    "idle" | "approving" | "swapping" | "confirming" | "confirmed" | "error"
  >(persisted?.status || "idle");
  const [txHash, setTxHash] = useState<string | null>(persisted?.txHash || null);
  const [errorMsg, setErrorMsg] = useState<string | null>(persisted?.errorMsg || null);
  const [balance, setBalance] = useState<bigint | null>(null);

  // Live quote state — refreshes every REFRESH_INTERVAL seconds
  const REFRESH_INTERVAL = 15;
  const [quote, setQuote] = useState<SwapQuoteData>(data);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [refreshing, setRefreshing] = useState(false);

  // Slippage tolerance (%)
  const [slippage, setSlippage] = useState(0.5);
  const [customSlippage, setCustomSlippage] = useState("");
  const [showSlippageMenu, setShowSlippageMenu] = useState(false);

  // AbortController to cancel in-flight refresh when user clicks Confirm
  const refreshAbortRef = useRef<AbortController | null>(null);

  const isFromNativeETH =
    quote.fromToken?.address === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

  // Fetch fromToken balance on mount and after each quote refresh (skip for final states)
  useEffect(() => {
    if (status === "confirmed" || status === "error") return;
    if (!address || !quote.fromToken?.address) return;
    if (!window.ethereum) return;

    clientGetBalance(quote.fromToken.address, address, window.ethereum)
      .then(setBalance)
      .catch(() => setBalance(null));
  }, [address, quote.fromToken?.address, quote.fromAmountRaw]);

  // Periodic quote refresh — only for latest card in idle state
  useEffect(() => {
    if (!isLatest || status !== "idle" || !address) return;
    if (!quote.fromToken?.symbol || !quote.toToken?.symbol || !quote.fromAmount) return;

    setCountdown(REFRESH_INTERVAL);

    const ticker = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return REFRESH_INTERVAL;
        return prev - 1;
      });
    }, 1000);

    let cancelled = false;
    const refresher = setInterval(async () => {
      if (cancelled) return;
      setRefreshing(true);
      const controller = new AbortController();
      refreshAbortRef.current = controller;
      try {
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromToken: quote.fromToken.symbol,
            toToken: quote.toToken.symbol,
            amount: quote.fromAmount,
            userAddress: address,
          }),
          signal: controller.signal,
        });
        if (res.ok && !cancelled) {
          const { quote: fresh } = await res.json();
          setQuote((prev) => ({ ...prev, ...fresh }));
        }
      } catch {
        // Silently fail — keep old quote (or aborted by user clicking Confirm)
      }
      if (!cancelled) {
        refreshAbortRef.current = null;
        setRefreshing(false);
        setCountdown(REFRESH_INTERVAL);
      }
    }, REFRESH_INTERVAL * 1000);

    return () => {
      cancelled = true;
      clearInterval(ticker);
      clearInterval(refresher);
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
    };
  }, [isLatest, status, address, quote.fromToken?.symbol, quote.toToken?.symbol, quote.fromAmount]);

  const insufficientBalance =
    balance !== null &&
    quote.fromAmountRaw &&
    BigInt(quote.fromAmountRaw) > balance;

  async function handleConfirmSwap() {
    // Cancel any in-flight quote refresh immediately — we don't want
    // the UI updating while the user is confirming in MetaMask
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;

    const ethereum = window.ethereum;
    if (!ethereum || !address) {
      setErrorMsg("Please connect your wallet.");
      setStatus("error");
      if (toolCallId) saveSwapState(toolCallId, { status: "error", errorMsg: "Please connect your wallet." });
      return;
    }

    if (chainId !== 8453) {
      await switchToBase();
      // Verify chain actually switched before proceeding
      const currentChain = await ethereum.request({ method: "eth_chainId" }) as string;
      if (parseInt(currentChain, 16) !== 8453) {
        setErrorMsg("Please switch to Base network to continue.");
        setStatus("error");
        if (toolCallId) saveSwapState(toolCallId, { status: "error", errorMsg: "Please switch to Base network." });
        return;
      }
    }

    try {
      // ERC20 approval if needed
      if (!isFromNativeETH) {
        setStatus("approving");
        const allowance = await checkAllowance(
          quote.fromToken.address,
          address,
          quote.exchangeProxy,
          ethereum
        );
        if (BigInt(allowance) < BigInt(quote.fromAmountRaw)) {
          const approveTxHash = await sendApproval(
            quote.fromToken.address,
            quote.exchangeProxy,
            ethereum,
            address
          );
          await waitForTx(approveTxHash, ethereum);
        }
      }

      // Fetch fresh calldata from the SAME provider that generated the quote.
      // Critical: approval was granted to this provider's router address.
      setStatus("swapping");
      const res = await fetch("/api/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromToken: quote.fromToken.symbol,
          toToken: quote.toToken.symbol,
          amount: quote.fromAmount,
          userAddress: address,
          slippage,
          provider: quote.provider,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json();
        throw new Error(errBody.error || "Failed to get swap data");
      }

      const { transaction } = await res.json();

      // Validate transaction target against known DEX router addresses
      const TRUSTED_ROUTERS = [
        "0x6352a56caadc4f1e25cd6c75970fa768a3304e64", // OpenOcean
        "0x6a000f20005980200259b80c5102003040001068", // Paraswap Augustus V6
      ];
      if (!transaction?.to || !TRUSTED_ROUTERS.includes(transaction.to.toLowerCase())) {
        throw new Error("Untrusted swap router address");
      }

      // Send swap transaction
      const hash = await ethereum.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: address,
            to: transaction.to,
            data: transaction.data,
            value: transaction.value,
            gas: transaction.gasLimit,
          },
        ],
      }) as string;

      setTxHash(hash);
      setStatus("confirming");

      // Record swap in database (non-blocking)
      const { recordSwap } = await import("@/lib/chat/sync");
      const swapDbId = await recordSwap({
        fromToken: quote.fromToken.symbol,
        fromAddress: quote.fromToken.address,
        toToken: quote.toToken.symbol,
        toAddress: quote.toToken.address,
        fromAmount: quote.fromAmount,
        toAmount: quote.toAmount,
        provider: quote.provider,
        txHash: hash,
      });

      await waitForTx(hash, ethereum);
      setStatus("confirmed");
      if (toolCallId) saveSwapState(toolCallId, { status: "confirmed", txHash: hash });

      // Update swap status in database
      if (swapDbId) {
        const { updateSwapStatus } = await import("@/lib/chat/sync");
        updateSwapStatus(swapDbId, "confirmed", hash);
      }
    } catch (err: unknown) {
      const walletErr = err as { code?: number; message?: string };
      const isSlippage = walletErr.message?.includes("Return amount is not enough") || walletErr.message?.includes("INSUFFICIENT_OUTPUT");
      const msg = walletErr.code === 4001
        ? "Transaction rejected"
        : isSlippage
        ? "Price moved too much. Try increasing slippage or retry."
        : (walletErr.message || "Swap failed");
      setErrorMsg(msg);
      setStatus("error");
      if (toolCallId) saveSwapState(toolCallId, { status: "error", errorMsg: msg });
    }
  }

  return (
    <div className="my-2 rounded-xl border border-border bg-background p-4">
      {/* Header with provider + refresh indicator */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted">Swap Quote</span>
          {quote.provider && (
            <span className="rounded-full bg-card px-2 py-0.5 text-[10px] text-muted">
              via {quote.provider}
            </span>
          )}
        </div>
        {isLatest && status === "idle" && address && (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            {refreshing ? (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                Updating...
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray={`${(countdown / REFRESH_INTERVAL) * 40.84} 40.84`} strokeLinecap="round" className="origin-center -rotate-90 transition-all duration-1000" />
                </svg>
                {countdown}s
              </span>
            )}
          </div>
        )}
      </div>

      {/* From → To */}
      <div className="flex items-center gap-3">
        <div className="flex-1 rounded-lg bg-card p-3">
          <div className="text-xs text-muted">From</div>
          <div className="text-lg font-bold">
            {quote.fromAmount} {quote.fromToken?.symbol}
          </div>
        </div>
        <div className="text-muted">&rarr;</div>
        <div className={`flex-1 rounded-lg bg-card p-3 transition-opacity duration-300 ${refreshing ? "opacity-60" : ""}`}>
          <div className="text-xs text-muted">To (estimated)</div>
          <div className="text-lg font-bold">
            {Number(quote.toAmount).toLocaleString(undefined, {
              maximumFractionDigits: 6,
            })}{" "}
            {quote.toToken?.symbol}
          </div>
        </div>
      </div>

      {/* Details */}
      <div className="mt-3 flex items-center gap-4 text-xs text-muted">
        <span>Price Impact: {Number(quote.priceImpact || 0).toFixed(2)}%</span>
        <div className="relative">
          <button
            onClick={() => setShowSlippageMenu((v) => !v)}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-card hover:text-foreground"
          >
            Slippage: {slippage}%
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
              <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showSlippageMenu && (
            <div className="absolute bottom-full left-0 mb-1 rounded-lg border border-border bg-background p-2 shadow-lg z-10">
              <div className="flex gap-1">
                {[0.3, 0.5, 1.0].map((v) => (
                  <button
                    key={v}
                    onClick={() => { setSlippage(v); setCustomSlippage(""); setShowSlippageMenu(false); }}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      slippage === v && !customSlippage
                        ? "bg-accent text-white"
                        : "bg-card text-muted hover:text-foreground"
                    }`}
                  >
                    {v}%
                  </button>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Custom"
                  value={customSlippage}
                  onChange={(e) => {
                    const val = e.target.value.replace(/[^0-9.]/g, "");
                    setCustomSlippage(val);
                    const num = parseFloat(val);
                    if (num > 0 && num <= 5) setSlippage(num);
                  }}
                  className="w-16 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
                />
                <span className="text-xs text-muted">%</span>
              </div>
              {slippage > 3 && (
                <div className="mt-1 text-[10px] text-yellow-400">Warning: High slippage</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Action */}
      <div className="mt-4">
        {status === "idle" && (
          !isLatest ? (
            <button
              disabled
              className="w-full rounded-xl bg-card py-3 text-sm font-medium text-muted"
            >
              Quote expired
            </button>
          ) : address && balance === null ? (
            <button
              disabled
              className="w-full rounded-xl bg-card py-3 text-sm font-medium text-muted"
            >
              Checking balance...
            </button>
          ) : insufficientBalance ? (
            <button
              disabled
              className="w-full rounded-xl bg-red-500/10 py-3 text-sm font-medium text-red-400"
            >
              Insufficient {quote.fromToken?.symbol} balance
            </button>
          ) : (
            <button
              onClick={handleConfirmSwap}
              disabled={refreshing}
              className={`w-full rounded-xl py-3 text-sm font-medium text-white transition-all ${
                refreshing
                  ? "bg-accent/40 cursor-not-allowed"
                  : "bg-accent hover:bg-accent-hover"
              }`}
            >
              {refreshing ? "Updating quote..." : "Confirm Swap"}
            </button>
          )
        )}

        {status === "approving" && (
          <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-3 text-sm text-muted">
            <Spinner /> Approving {data.fromToken?.symbol}...
          </div>
        )}

        {status === "swapping" && (
          <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-3 text-sm text-muted">
            <Spinner /> Preparing swap...
          </div>
        )}

        {status === "confirming" && (
          <div className="space-y-2">
            <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-3 text-sm text-muted">
              <Spinner /> Confirming transaction...
            </div>
            {txHash && (
              <a
                href={`https://basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-center text-xs text-accent underline"
              >
                View on BaseScan
              </a>
            )}
          </div>
        )}

        {status === "confirmed" && (
          <div className="space-y-2">
            <div className="rounded-xl bg-success/10 py-3 text-center text-sm font-medium text-success">
              Swap confirmed!
            </div>
            {txHash && (
              <a
                href={`https://basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-center text-xs text-accent underline"
              >
                View on BaseScan
              </a>
            )}
          </div>
        )}

        {status === "error" && (
          <div className="space-y-2">
            <div className="rounded-xl bg-red-500/10 py-3 text-center text-sm text-red-400">
              {errorMsg}
            </div>
            {isLatest && (
              <button
                onClick={() => {
                  setStatus("idle");
                  setErrorMsg(null);
                  if (toolCallId) {
                    try {
                      const all = JSON.parse(localStorage.getItem(SWAP_STATE_KEY) || "{}");
                      delete all[toolCallId];
                      localStorage.setItem(SWAP_STATE_KEY, JSON.stringify(all));
                    } catch {}
                  }
                }}
                className="w-full rounded-xl bg-card py-2 text-xs text-muted transition-colors hover:text-foreground"
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:300ms]" />
    </div>
  );
}

// --- Swap helpers (raw EIP-1193 calls) ---

async function clientGetBalance(
  tokenAddress: string,
  owner: string,
  ethereum: EIP1193Provider
): Promise<bigint> {
  if (tokenAddress === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE") {
    // Native ETH
    const hex = await ethereum.request({
      method: "eth_getBalance",
      params: [owner, "latest"],
    }) as string;
    return BigInt(hex);
  }
  // ERC20 balanceOf(address)
  const ownerPadded = owner.slice(2).toLowerCase().padStart(64, "0");
  const data = `0x70a08231${ownerPadded}`;
  const hex = await ethereum.request({
    method: "eth_call",
    params: [{ to: tokenAddress, data }, "latest"],
  }) as string;
  return BigInt(hex);
}

async function checkAllowance(
  tokenAddress: string,
  owner: string,
  spender: string,
  ethereum: EIP1193Provider
): Promise<string> {
  const ownerPadded = owner.slice(2).toLowerCase().padStart(64, "0");
  const spenderPadded = spender.slice(2).toLowerCase().padStart(64, "0");
  const data = `0xdd62ed3e${ownerPadded}${spenderPadded}`;

  const result = await ethereum.request({
    method: "eth_call",
    params: [{ to: tokenAddress, data }, "latest"],
  }) as string;
  return BigInt(result).toString();
}

async function sendApproval(
  tokenAddress: string,
  spender: string,
  ethereum: EIP1193Provider,
  from: string
): Promise<string> {
  const spenderPadded = spender.slice(2).toLowerCase().padStart(64, "0");
  const maxUint256 = "f".repeat(64);
  const data = `0x095ea7b3${spenderPadded}${maxUint256}`;

  return ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from, to: tokenAddress, data }],
  }) as Promise<string>;
}

async function waitForTx(txHash: string, ethereum: EIP1193Provider): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const receipt = await ethereum.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    }) as { status: string } | null;
    if (receipt) {
      if (receipt.status === "0x0") {
        throw new Error("Transaction reverted on-chain");
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Transaction confirmation timeout");
}

function formatCompact(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}
