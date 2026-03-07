/**
 * Chat history sync — background sync between localStorage and Neon DB.
 *
 * Strategy:
 * - localStorage remains the primary source (fast, works offline)
 * - When authenticated, sync sessions/messages to DB in the background
 * - On login, merge DB sessions into localStorage (recover history across devices)
 * - Debounced writes — don't hammer the API on every keystroke
 */

// Per-session debounce to avoid cancelling syncs for different sessions
const syncTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

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

  syncTimeouts.set(sessionId, setTimeout(async () => {
    syncTimeouts.delete(sessionId);
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
    await fetch(`/api/history/sessions?id=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
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
