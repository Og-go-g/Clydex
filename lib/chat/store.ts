// Chat session persistence — localStorage CRUD

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
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

export function getSessions(): ChatSession[] {
  return safe(() => {
    const raw = localStorage.getItem(KEYS.sessions);
    if (!raw) return [];
    const all: ChatSession[] = JSON.parse(raw);
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

function saveSessions(sessions: ChatSession[]) {
  try {
    localStorage.setItem(KEYS.sessions, JSON.stringify(sessions));
  } catch {
    // QuotaExceededError — silently fail rather than crash
  }
}

export function createSession(): ChatSession {
  const session: ChatSession = {
    id: crypto.randomUUID(),
    title: "New Chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

export function getMessages(id: string): any[] {
  return safe(() => {
    const raw = localStorage.getItem(KEYS.messages(id));
    return raw ? JSON.parse(raw) : [];
  }, []);
}

export function saveMessages(id: string, messages: any[]) {
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
