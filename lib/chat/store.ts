// Chat session persistence — localStorage CRUD

import type { ChatMode } from "@/lib/chat/chart-panel-context";

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Mode the chat was created in. Cannot be changed after creation
   * (toggling Trade ↔ Analyze in the UI always creates a NEW chat).
   * Acts as the single source of truth for which API route the
   * transport hits for this chat.
   *
   * Legacy sessions without `mode` are treated as `"trading"` by
   * `getSessions()`'s migration shim.
   */
  mode: ChatMode;
}

const KEYS = {
  sessions: "clydex_sessions",
  active: "clydex_active",
  messages: (id: string) => `clydex_msg_${id}`,
} as const;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const MAX_AGE_MS = 50 * 24 * 60 * 60 * 1000; // 50 days

// --- Sessions ---

function isValidSession(s: unknown): s is ChatSession {
  if (typeof s !== "object" || s === null) return false;
  const v = s as Partial<ChatSession>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}

/** Coerce a parsed session to the current schema. Legacy rows missing
 * `mode` get the historical default `"trading"`. */
function migrate(s: Partial<ChatSession> & { id: string; title: string; createdAt: number; updatedAt: number }): ChatSession {
  const mode: ChatMode = s.mode === "copytrade" ? "copytrade" : "trading";
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, mode };
}

export function getSessions(): ChatSession[] {
  return safe(() => {
    const raw = localStorage.getItem(KEYS.sessions);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate shape to protect against tampered localStorage, then
    // migrate legacy rows (no `mode` field) to the current schema.
    const all: ChatSession[] = parsed
      .filter(isValidSession)
      .map((s) => migrate(s as ChatSession));
    const now = Date.now();
    const fresh = all.filter((s) => now - s.updatedAt < MAX_AGE_MS);
    // Clean up expired sessions and their messages
    if (fresh.length < all.length) {
      const expired = all.filter((s) => now - s.updatedAt >= MAX_AGE_MS);
      expired.forEach((s) => localStorage.removeItem(KEYS.messages(s.id)));
      saveSessions(fresh);
    }
    return fresh;
  }, []);
}

export function saveSessions(sessions: ChatSession[]) {
  try {
    localStorage.setItem(KEYS.sessions, JSON.stringify(sessions));
  } catch {
    // QuotaExceededError — silently fail rather than crash
  }
}

export function createSession(mode: ChatMode = "trading"): ChatSession {
  const session: ChatSession = {
    id: crypto.randomUUID(),
    title: "New Chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode,
  };
  const sessions = getSessions();
  sessions.unshift(session);
  saveSessions(sessions);
  setActiveId(session.id);
  return session;
}

export function deleteSession(id: string) {
  const sessions = getSessions().filter((s) => s.id !== id);
  saveSessions(sessions);
  localStorage.removeItem(KEYS.messages(id));
}

export function updateTitle(id: string, title: string) {
  const sessions = getSessions();
  const s = sessions.find((s) => s.id === id);
  if (s) {
    s.title = title;
    saveSessions(sessions);
  }
}

export function updateTimestamp(id: string) {
  const sessions = getSessions();
  const s = sessions.find((s) => s.id === id);
  if (s) {
    s.updatedAt = Date.now();
    saveSessions(sessions);
  }
}

// --- Active session ---

export function getActiveId(): string | null {
  return safe(() => localStorage.getItem(KEYS.active), null);
}

export function setActiveId(id: string) {
  try {
    localStorage.setItem(KEYS.active, id);
  } catch {}
}

// --- Messages ---

export interface PersistedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts?: unknown;
  createdAt?: string | number;
}

const VALID_ROLES = new Set(["user", "assistant", "system"]);

function isValidMessage(m: unknown): m is PersistedMessage {
  return (
    typeof m === "object" && m !== null &&
    typeof (m as PersistedMessage).id === "string" &&
    typeof (m as PersistedMessage).role === "string" &&
    VALID_ROLES.has((m as PersistedMessage).role)
  );
}

export function getMessages(id: string): PersistedMessage[] {
  return safe(() => {
    const raw = localStorage.getItem(KEYS.messages(id));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidMessage);
  }, []);
}

export function saveMessages(id: string, messages: Array<{ id: string; role: string; content?: string; parts?: unknown; createdAt?: string | number }>) {
  // Only save serializable parts — strip functions, refs, etc.
  const serializable = messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content ?? "",
    parts: m.parts,
    createdAt: m.createdAt,
  }));
  try {
    localStorage.setItem(KEYS.messages(id), JSON.stringify(serializable));
  } catch {
    // QuotaExceededError — try to free space by removing oldest session messages
    const sessions = getSessions();
    if (sessions.length > 1) {
      const oldest = sessions[sessions.length - 1];
      localStorage.removeItem(KEYS.messages(oldest.id));
      try {
        localStorage.setItem(KEYS.messages(id), JSON.stringify(serializable));
      } catch {}
    }
  }
}
