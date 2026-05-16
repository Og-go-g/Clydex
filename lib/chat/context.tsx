"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  type ChatSession,
  getSessions,
  saveSessions,
  getActiveId,
  setActiveId as storeSetActiveId,
  createSession,
  deleteSession,
  updateTitle,
  updateTimestamp,
  getMessages,
  saveMessages,
} from "./store";
import type { ChatMode } from "@/lib/chat/chart-panel-context";
import { useAuth } from "@/lib/auth/context";
import { loadSessionsFromDb, loadMessagesFromDb, deleteSessionFromDb } from "./sync";

interface ChatContextValue {
  sessions: ChatSession[];
  activeId: string | null;
  /**
   * Create a new chat session. Pass `mode` to lock the session to a
   * specific API route (Trade vs Analyze); the chat keeps that mode
   * for its entire lifetime.
   */
  createChat: (mode?: ChatMode) => void;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  touchChat: (id: string) => void;
}

const ChatContext = createContext<ChatContextValue>({
  sessions: [],
  activeId: null,
  createChat: () => {},
  selectChat: () => {},
  deleteChat: () => {},
  renameChat: () => {},
  touchChat: () => {},
});

export function useChatSessions() {
  return useContext(ChatContext);
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [dbSynced, setDbSynced] = useState(false);

  // Load from localStorage on mount.
  // Guard against React strict mode double-execution.
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    let stored = getSessions();
    // (cleanup below resets initRef so re-mounts after error boundaries work)
    const visitedThisSession = sessionStorage.getItem("clydex_visited");

    if (visitedThisSession) {
      // Same tab session — restore active chat
      let active = getActiveId();
      if (stored.length === 0) {
        const first = createSession();
        stored = [first];
        active = first.id;
      } else if (!active || !stored.find((s) => s.id === active)) {
        active = stored[0].id;
        storeSetActiveId(active);
      }
      setSessions(stored);
      setActiveId(active);
    } else {
      // New browser session — reuse last chat, only create if none exist
      sessionStorage.setItem("clydex_visited", "1");

      if (stored.length === 0) {
        const first = createSession();
        stored = [first];
        setSessions(stored);
        setActiveId(first.id);
      } else {
        // Switch to the most recent chat (don't auto-create new ones)
        storeSetActiveId(stored[0].id);
        setSessions(stored);
        setActiveId(stored[0].id);
      }
    }

    // Retroactively rename "New Chat" sessions that already have messages
    for (const s of stored) {
      if (s.title === "New Chat") {
        const msgs = getMessages(s.id);
        const firstUser = msgs.find((m) => m.role === "user");
        if (firstUser) {
          // Content may be in .content (string) or .parts[0].text (AI SDK format)
          let text = (typeof firstUser.content === "string" ? firstUser.content : "").trim();
          if (!text && Array.isArray(firstUser.parts)) {
            const textPart = (firstUser.parts as Array<{ type?: string; text?: string }>).find(p => p.type === "text" && p.text);
            if (textPart?.text) text = textPart.text.trim();
          }
          if (text) {
            const title = text.length <= 35 ? text : (text.slice(0, 35).replace(/\s+\S*$/, "") || text.slice(0, 35)) + "…";
            s.title = title;
            updateTitle(s.id, title);
          }
        }
      }
    }

    setMounted(true);
    return () => { initRef.current = false; };
  }, []);

  // Reset dbSynced when user signs out so re-auth triggers a fresh sync
  useEffect(() => {
    if (!isAuthenticated) setDbSynced(false);
  }, [isAuthenticated]);

  // Sync from DB when user authenticates — merge remote sessions into localStorage
  useEffect(() => {
    if (!isAuthenticated || dbSynced) return;
    let cancelled = false;

    (async () => {
      try {
        const remoteSessions = await loadSessionsFromDb();
        if (cancelled) return;
        if (!remoteSessions || remoteSessions.length === 0) return;

        const local = getSessions();
        const localIds = new Set(local.map((s) => s.id));
        let merged = false;

        for (const rs of remoteSessions) {
          if (cancelled) return;
          if (localIds.has(rs.id)) continue;

          // Session exists in DB but not locally — restore it only if it has messages
          const remoteMessages = await loadMessagesFromDb(rs.id);
          if (cancelled) return;
          if (!remoteMessages || remoteMessages.length === 0) {
            // Empty session — don't restore, clean up from DB
            deleteSessionFromDb(rs.id);
            continue;
          }

          // Add session to localStorage. The DB schema doesn't yet
          // carry `mode`, so DB-only restores default to "trading"
          // (historical default). New sessions created post-refactor
          // will round-trip mode via localStorage.
          const restored: ChatSession = {
            id: rs.id,
            title: rs.title,
            createdAt: new Date(rs.createdAt).getTime(),
            updatedAt: new Date(rs.updatedAt).getTime(),
            mode: "trading",
          };
          local.push(restored);

          // Save messages to localStorage
          saveMessages(rs.id, remoteMessages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            parts: m.parts,
            createdAt: m.createdAt,
          })));
          merged = true;
        }

        if (merged && !cancelled) {
          // Sort by updatedAt descending and persist via store helper
          local.sort((a, b) => b.updatedAt - a.updatedAt);
          saveSessions(local);
          setSessions([...local]);
        }
      } finally {
        if (!cancelled) setDbSynced(true);
      }
    })();

    return () => { cancelled = true; };
  }, [isAuthenticated, dbSynced]);

  const createChat = useCallback((mode: ChatMode = "trading") => {
    // Limit: max 2 empty chats (no messages) at a time. When that cap
    // is hit AND there's already an empty chat in the requested mode,
    // reuse it. If the only empty chats are in a different mode, we
    // must create a fresh one anyway — otherwise toggling Trade ↔
    // Analyze would silently route into a chat locked to the wrong
    // mode (the original bug behind the trade-mode response in
    // Analyze UI). See lib/chat/store.ts → ChatSession.mode.
    const current = getSessions();
    const empties = current.filter((s) => getMessages(s.id).length === 0);
    const reusable = empties.find((s) => s.mode === mode);
    if (empties.length >= 2 && reusable) {
      storeSetActiveId(reusable.id);
      setActiveId(reusable.id);
      return;
    }
    const session = createSession(mode);
    setSessions(getSessions());
    setActiveId(session.id);
  }, []);

  const selectChat = useCallback((id: string) => {
    storeSetActiveId(id);
    setActiveId(id);
  }, []);

  const deleteChat = useCallback(
    (id: string) => {
      deleteSession(id);
      if (isAuthenticated) deleteSessionFromDb(id); // background DB cleanup
      const remaining = getSessions();

      if (remaining.length === 0) {
        // Deleted last chat — create a new one
        const fresh = createSession();
        setSessions(getSessions());
        setActiveId(fresh.id);
      } else if (id === activeId) {
        // Deleted active — switch to first
        setSessions(remaining);
        storeSetActiveId(remaining[0].id);
        setActiveId(remaining[0].id);
      } else {
        setSessions(remaining);
      }
    },
    [activeId, isAuthenticated]
  );

  const renameChat = useCallback((id: string, title: string) => {
    updateTitle(id, title);
    setSessions(getSessions());
  }, []);

  const touchChat = useCallback((id: string) => {
    updateTimestamp(id);
    setSessions(getSessions());
  }, []);

  // Don't render children until localStorage is loaded (prevents hydration mismatch)
  if (!mounted) return null;

  return (
    <ChatContext.Provider
      value={{ sessions, activeId, createChat, selectChat, deleteChat, renameChat, touchChat }}
    >
      {children}
    </ChatContext.Provider>
  );
}
