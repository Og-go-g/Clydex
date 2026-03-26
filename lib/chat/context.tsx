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
import { useAuth } from "@/lib/auth/context";
import { loadSessionsFromDb, loadMessagesFromDb, deleteSessionFromDb } from "./sync";

interface ChatContextValue {
  sessions: ChatSession[];
  activeId: string | null;
  createChat: () => void;
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

          // Add session to localStorage
          const restored: ChatSession = {
            id: rs.id,
            title: rs.title,
            createdAt: new Date(rs.createdAt).getTime(),
            updatedAt: new Date(rs.updatedAt).getTime(),
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

  const createChat = useCallback(() => {
    // Limit: max 2 empty chats (no messages) at a time
    const current = getSessions();
    const emptyCount = current.filter((s) => getMessages(s.id).length === 0).length;
    if (emptyCount >= 2) {
      // Switch to the most recent empty chat instead of creating
      const emptyChat = current.find((s) => getMessages(s.id).length === 0);
      if (emptyChat) {
        storeSetActiveId(emptyChat.id);
        setActiveId(emptyChat.id);
        return;
      }
    }
    const session = createSession();
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
