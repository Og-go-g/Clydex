/**
 * Provider fallback for chat routes — Anthropic primary, OpenAI rescue.
 *
 * Design:
 *   - Existing chat sessions are STICKY: the provider chosen for the
 *     first assistant turn is the provider for that session forever.
 *     We carry the choice in the assistant message's `metadata.provider`
 *     field, which the AI SDK preserves across requests. This avoids
 *     mid-conversation voice/tone shifts and the tool-call schema
 *     quirks that can pop up when models switch.
 *
 *   - NEW sessions (no assistant message yet) get a pre-flight probe.
 *     If Anthropic is rate-limited (429) or 5xx down, we open the
 *     session on OpenAI from the very first message. ~200 ms latency
 *     overhead on the first message only; subsequent messages skip
 *     the probe entirely.
 *
 *   - The probe is a tiny direct fetch against Anthropic's messages
 *     endpoint with max_tokens=1. Costs ~$0.00003 per probe (~one
 *     dollar per ~33,000 new sessions). RPM-wise it consumes one of
 *     the org's per-minute budget slots, which is the entire point:
 *     when we're close to the budget, the probe also fails, and the
 *     real request lands on OpenAI without ever touching Anthropic.
 *
 * Why not auto-fall back mid-stream:
 *   Anthropic 429s typically surface as stream errors AFTER the HTTP
 *   response has been sent to the client. By that point the user has
 *   already seen "ai thinking…" and a half-rendered response would
 *   be jarring to replace. Pre-flight probe lets us decide before
 *   committing the response shape.
 */

import * as Sentry from "@sentry/nextjs";

export type ChatProvider = "anthropic" | "openai";

/**
 * Extract the most recent assistant message's `metadata.provider`, if
 * any. Falls back to `null` when no assistant turn yet (new session).
 *
 * The metadata shape is whatever the AI SDK preserves between calls
 * via `messageMetadata` — see route handlers below. We use a
 * permissive type because the route deals with the unvalidated client
 * payload at this point; full validation happens in role/content
 * filtering upstream.
 */
export function getStickyProvider(
  messages: ReadonlyArray<{ role?: string; metadata?: unknown }>,
): ChatProvider | null {
  // Walk newest-first; the most recent assistant is the source of truth.
  // If a session has multiple assistant turns with different
  // metadata.provider values (shouldn't happen but defensive), the
  // most recent one wins.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const meta = m.metadata;
    if (meta && typeof meta === "object" && "provider" in meta) {
      const p = (meta as { provider?: unknown }).provider;
      if (p === "anthropic" || p === "openai") return p;
    }
  }
  return null;
}

/**
 * Returns true if the messages list contains zero assistant turns,
 * i.e. this request is the first user message of a new session.
 */
export function isNewSession(
  messages: ReadonlyArray<{ role?: string }>,
): boolean {
  return !messages.some((m) => m?.role === "assistant");
}

/** Small probe that returns true if Anthropic accepts a 1-token call. */
async function probeAnthropic(model: string): Promise<boolean> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return false;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
      // Hard cap so a long-tail latency spike doesn't lock the route.
      // We'd rather wrongly fall to OpenAI than hang the user.
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 200) return true;
    if (res.status === 429) return false;
    if (res.status >= 500) return false;
    // Other 4xx (auth, billing) — log + assume Anthropic is not the
    // right answer right now. Operator should see this in Sentry.
    Sentry.captureMessage(
      `[chat-fallback] probe non-200 from Anthropic: ${res.status}`,
      { level: "warning", tags: { component: "chat-fallback" } },
    );
    return false;
  } catch (err) {
    // Network failure / timeout / AbortError. Don't crash the route —
    // fall to OpenAI silently. Logged at warning level so a brewing
    // issue is visible without paging.
    Sentry.captureMessage(
      `[chat-fallback] probe threw: ${(err as Error).message}`,
      { level: "warning", tags: { component: "chat-fallback" } },
    );
    return false;
  }
}

/**
 * Resolve the provider for this request:
 *   - Existing session → sticky.
 *   - New session → probe Anthropic; on failure, OpenAI if available.
 *   - If only one provider is configured, that's the answer (no probe).
 *
 * `model` is the Anthropic model name to probe with — passing the same
 * model the route would use ensures probe outcome reflects the real
 * Anthropic capacity for that model.
 */
export async function pickChatProvider(
  messages: ReadonlyArray<{ role?: string; metadata?: unknown }>,
  anthropicModel: string,
): Promise<ChatProvider> {
  const sticky = getStickyProvider(messages);
  if (sticky) return sticky;

  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  if (hasAnthropic && !hasOpenAI) return "anthropic";
  if (!hasAnthropic && hasOpenAI) return "openai";
  if (!hasAnthropic && !hasOpenAI) {
    // Both keys absent — the route will error elsewhere; return
    // anthropic so the existing model-creation path logs the
    // expected "missing key" error rather than something cryptic.
    return "anthropic";
  }

  // Both configured + new session — probe time.
  if (!isNewSession(messages)) {
    // Shouldn't reach here (sticky would've matched) but defensive:
    // continuing sessions without metadata go to Anthropic by default.
    return "anthropic";
  }

  const ok = await probeAnthropic(anthropicModel);
  if (ok) return "anthropic";
  Sentry.captureMessage(
    "[chat-fallback] new session opened on OpenAI (Anthropic unavailable)",
    { level: "info", tags: { component: "chat-fallback" } },
  );
  return "openai";
}
