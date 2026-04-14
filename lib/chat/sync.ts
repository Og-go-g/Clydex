/**
 * Chat history sync — background sync between localStorage and PostgreSQL.
 *
 * Strategy:
 * - localStorage remains the primary source (fast, works offline)
 * - When authenticated, sync sessions/messages to DB in the background
 * - On login, merge DB sessions into localStorage (recover history across devices)
 * - Debounced writes — don't hammer the API on every keystroke
 */

// Per-session debounce to avoid cancelling syncs for different sessions
const syncTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// Pending sync payloads — used by beforeunload to flush via sendBeacon
const pendingSyncs = new Map<string, { sessionId: string; title: string; messages: unknown[] }>();

// Register beforeunload handler to flush pending syncs before tab close.
// Uses fetch() with keepalive instead of sendBeacon — keepalive guarantees
// delivery on page unload AND properly sends Origin header (required by
// our CSRF middleware). sendBeacon omits Origin in some browsers → 403.
// Browser keepalive fetches have a 64KB total body limit across all pending requests.
// Only send the most recent session, and truncate messages to fit within budget.
const KEEPALIVE_BUDGET = 50_000; // 50KB safe margin under 64KB
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    let budgetLeft = KEEPALIVE_BUDGET;

    for (const [sessionId, payload] of pendingSyncs) {
      const timeout = syncTimeouts.get(sessionId);
      if (timeout) clearTimeout(timeout);

      // Session upsert — always small (~200 bytes)
      const sessionBody = JSON.stringify({ id: payload.sessionId, title: payload.title });
      if (sessionBody.length < budgetLeft) {
        budgetLeft -= sessionBody.length;
        fetch("/api/history/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: sessionBody,
          keepalive: true,
        }).catch(() => {});
      }

      // Messages — truncate from the front (keep newest) to fit budget
      if (payload.messages.length > 0 && budgetLeft > 1000) {
        let msgs = payload.messages;
        let msgBody = JSON.stringify({ sessionId: payload.sessionId, messages: msgs });
        // Trim oldest messages until it fits within remaining budget
        while (msgBody.length > budgetLeft && msgs.length > 1) {
          msgs = msgs.slice(Math.ceil(msgs.length / 4)); // drop oldest 25%
          msgBody = JSON.stringify({ sessionId: payload.sessionId, messages: msgs });
        }
        if (msgBody.length <= budgetLeft) {
          budgetLeft -= msgBody.length;
          fetch("/api/history/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: msgBody,
            keepalive: true,
          }).catch(() => {});
        }
      }
    }
    pendingSyncs.clear();
    syncTimeouts.clear();
  });
}

/**
 * Sync a session + its messages to the database (debounced per session).
 */
export function syncSessionToDb(
  sessionId: string,
  title: string,
  messages: Array<{ id: string; role: string; content?: string; parts?: unknown; createdAt?: string | number }>
) {
  const existing = syncTimeouts.get(sessionId);
  if (existing) clearTimeout(existing);

  // Track pending payload for beforeunload flush
  pendingSyncs.set(sessionId, { sessionId, title, messages });

  syncTimeouts.set(sessionId, setTimeout(async () => {
    syncTimeouts.delete(sessionId);
    pendingSyncs.delete(sessionId);
    try {
      // Upsert the session
      await fetch("/api/history/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sessionId, title }),
      });

      // Sync messages
      if (messages.length > 0) {
        await fetch("/api/history/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, messages }),
        });
      }
    } catch {
      // Silently fail — localStorage is the primary source
    }
  }, 2000)); // 2 second debounce
}

/**
 * Delete a session from the database.
 */
export async function deleteSessionFromDb(sessionId: string) {
  try {
    await fetch(`/api/history/sessions?id=${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    // Non-critical — will be cleaned up eventually
  }
}

/**
 * Load sessions from DB and merge into localStorage.
 * Called once on login to recover cross-device history.
 */
export async function loadSessionsFromDb(): Promise<
  Array<{ id: string; title: string; createdAt: string; updatedAt: string }> | null
> {
  try {
    const res = await fetch("/api/history/sessions");
    if (!res.ok) return null;
    const { sessions } = await res.json();
    return sessions ?? null;
  } catch {
    return null;
  }
}

/**
 * Load messages for a session from DB.
 */
export async function loadMessagesFromDb(
  sessionId: string
): Promise<Array<{ id: string; role: string; content: string; parts?: unknown; createdAt: string }> | null> {
  try {
    const res = await fetch(`/api/history/messages?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const { messages } = await res.json();
    return messages ?? null;
  } catch {
    return null;
  }
}

/**
 * Record a swap in the database.
 */
export async function recordSwap(data: {
  fromToken: string;
  fromAddress: string;
  toToken: string;
  toAddress: string;
  fromAmount: string;
  toAmount: string;
  provider: string;
  txHash?: string;
}): Promise<string | null> {
  try {
    const res = await fetch("/api/history/swaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) return null;
    const { swap } = await res.json();
    return swap?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Update swap status after tx confirmation.
 */
export async function updateSwapStatus(id: string, status: "confirmed" | "failed", txHash?: string) {
  try {
    await fetch("/api/history/swaps", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status, txHash }),
    });
  } catch {
    // Non-critical
  }
}
