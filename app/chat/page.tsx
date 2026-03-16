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

// ─── Types for AI SDK message parts ──────────────────────────────

interface ToolMessagePart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  output?: Record<string, unknown>;
  errorText?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

function msgText(m: Record<string, unknown>): string {
  if (typeof m.content === "string") return m.content;
  return "";
}

function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  if (Math.abs(n) >= 1) return "$" + n.toFixed(2);
  return "$" + n.toPrecision(4);
}

function formatPct(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return sign + n.toFixed(2) + "%";
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
  const addressRef = useRef(address);
  addressRef.current = address;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initialMessages = useMemo(() => getMessages(chatId) as any[], [chatId]);

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

  // Persist messages when streaming finishes
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasStreaming = prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted";
    const nowReady = status === "ready";
    prevStatusRef.current = status;

    if (wasStreaming && nowReady && messages.length > 0) {
      saveMessages(chatId, messages);
      touchChat(chatId);

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
    <div className="flex h-[calc(100vh-4rem+1px)] flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {/* Welcome message */}
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-relaxed text-foreground">
              <div className="whitespace-pre-wrap">
                {showWelcome ? "Hey! I'm Clydex, your AI trading assistant for 01 Exchange perpetual futures on Solana.\n\n" : ""}
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
                {showWelcome ? "\n\nWhat would you like to do?" : ""}
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
                Error: {error.message}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
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
        </form>
      </div>
    </div>
  );
}

// ─── Message Rendering ───────────────────────────────────────────

function MessageContent({
  content,
  parts,
}: {
  content: string;
  parts?: ToolMessagePart[];
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
            return <ToolResult key={i} part={part} />;
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

function ToolResult({ part }: { part: ToolMessagePart }) {
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
          : toolName === "executeOrder" ? "Executing order..."
          : toolName === "setTrigger" ? "Setting trigger..."
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
  if (toolName === "prepareOrder") return <OrderPreviewCard data={result} />;
  if (toolName === "closePosition") return <ClosePositionCard data={result} />;
  if (toolName === "executeOrder") return <ExecuteResultCard data={result} />;
  if (toolName === "setTrigger") return <TriggerCard data={result} />;

  // Default: don't render a card for info tools — the AI formats the response
  return null;
}

// ─── Order Preview Card ──────────────────────────────────────────

function OrderPreviewCard({ data }: { data: Record<string, unknown> }) {
  const isLong = data.side === "Long";
  const borderColor = isLong ? "border-green-500/30" : "border-red-500/30";
  const sideColor = isLong ? "text-green-400" : "text-red-400";
  const sideBg = isLong ? "bg-green-500/10" : "bg-red-500/10";

  return (
    <div className={`my-2 rounded-xl border ${borderColor} bg-background p-4`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${sideBg} ${sideColor}`}>
            {data.side as string}
          </span>
          <span className="text-sm font-semibold text-foreground">{data.market as string}</span>
          <span className="text-xs text-muted">{data.leverage as number}x</span>
        </div>
        <span className="text-[10px] text-muted">{data.orderType as string}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted">Size</span>
          <div className="font-mono text-foreground">{(data.size as number)?.toFixed(6)}</div>
        </div>
        <div>
          <span className="text-muted">Notional</span>
          <div className="font-mono text-foreground">{formatUsd(data.notionalValue as number)}</div>
        </div>
        <div>
          <span className="text-muted">Entry Price</span>
          <div className="font-mono text-foreground">{formatUsd(data.estimatedEntryPrice as number)}</div>
        </div>
        <div>
          <span className="text-muted">Liq. Price</span>
          <div className="font-mono text-red-400">{formatUsd(data.estimatedLiquidationPrice as number)}</div>
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

      <div className="mt-3 text-[11px] text-muted">
        Reply <strong>&quot;yes&quot;</strong> or <strong>&quot;да&quot;</strong> to confirm.
      </div>
    </div>
  );
}

// ─── Close Position Card ─────────────────────────────────────────

function ClosePositionCard({ data }: { data: Record<string, unknown> }) {
  const pnl = data.estimatedPnl as number;
  const pnlColor = pnl >= 0 ? "text-green-400" : "text-red-400";

  return (
    <div className="my-2 rounded-xl border border-orange-500/30 bg-background p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-bold text-orange-400">CLOSE</span>
        <span className="text-sm font-semibold text-foreground">{data.market as string}</span>
        <span className="text-xs text-muted">{data.side as string}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted">Close Size</span>
          <div className="font-mono text-foreground">{(data.closeSize as number)?.toFixed(6)} ({String(data.closePercentage)}%)</div>
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

      <div className="mt-3 text-[11px] text-muted">
        Reply <strong>&quot;yes&quot;</strong> to confirm close.
      </div>
    </div>
  );
}

// ─── Execute Result Card ─────────────────────────────────────────

function ExecuteResultCard({ data }: { data: Record<string, unknown> }) {
  if (data.status === "awaiting_signature") {
    return (
      <div className="my-2 rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
          <span className="text-sm font-medium text-blue-400">Awaiting wallet signature</span>
        </div>
        <div className="mt-2 text-xs text-muted">
          {data.market as string} {data.side as string} {(data.size as number)?.toFixed(6)} @ {formatUsd(data.estimatedEntryPrice as number)}
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-green-500/30 bg-green-500/5 p-4">
      <div className="text-sm font-medium text-green-400">Order submitted</div>
    </div>
  );
}

// ─── Trigger Card ────────────────────────────────────────────────

function TriggerCard({ data }: { data: Record<string, unknown> }) {
  const isStopLoss = (data.kind as string)?.includes("Stop");
  const color = isStopLoss ? "border-red-500/30" : "border-green-500/30";
  const textColor = isStopLoss ? "text-red-400" : "text-green-400";

  return (
    <div className={`my-2 rounded-xl border ${color} bg-background p-4`}>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold ${textColor}`}>{data.kind as string}</span>
        <span className="text-sm font-semibold text-foreground">{data.market as string}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted">Trigger Price</span>
          <div className="font-mono text-foreground">{formatUsd(data.triggerPrice as number)}</div>
        </div>
        <div>
          <span className="text-muted">Entry Price</span>
          <div className="font-mono text-foreground">{formatUsd(data.entryPrice as number)}</div>
        </div>
      </div>
      <div className="mt-1 text-[11px] text-muted">
        {data.percentFromEntry as string}% from entry
      </div>
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
