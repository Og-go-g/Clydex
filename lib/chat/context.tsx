"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
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
  // On a new browser session — start a fresh chat (old ones stay in history).
  // Within the same tab session — restore the active chat.
  useEffect(() => {
    let stored = getSessions();
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
      // New browser session — reuse last chat if empty, otherwise create fresh
      sessionStorage.setItem("clydex_visited", "1");
      const latest = stored[0];
      const lastMessages = latest ? getMessages(latest.id) : [];

      if (latest && lastMessages.length === 0) {
        // Last chat is empty — reuse it
        storeSetActiveId(latest.id);
        setSessions(stored);
        setActiveId(latest.id);
      } else {
        // Last chat has messages — create new one
        const fresh = createSession();
        setSessions(getSessions());
        setActiveId(fresh.id);
      }
    }

    setMounted(true);
  }, []);

  // Reset dbSynced when user signs out so re-auth triggers a fresh sync
  useEffect(() => {
    if (!isAuthenticated) setDbSynced(false);
  }, [isAuthenticated]);

  // Sync from DB when user authenticates — merge remote sessions into localStorage
  useEffect(() => {
    if (!isAuthenticated || dbSynced) return;
    setDbSynced(true);

    (async () => {
      const remoteSessions = await loadSessionsFromDb();
      if (!remoteSessions || remoteSessions.length === 0) return;

      const local = getSessions();
      const localIds = new Set(local.map((s) => s.id));
      let merged = false;

      for (const rs of remoteSessions) {
        if (localIds.has(rs.id)) continue;

        // Session exists in DB but not locally — restore it
        const remoteMessages = await loadMessagesFromDb(rs.id);

        // Add session to localStorage
        const restored: ChatSession = {
          id: rs.id,
          title: rs.title,
          createdAt: new Date(rs.createdAt).getTime(),
          updatedAt: new Date(rs.updatedAt).getTime(),
        };
        local.push(restored);

        // Save messages to localStorage
        if (remoteMessages && remoteMessages.length > 0) {
          saveMessages(rs.id, remoteMessages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            parts: m.parts,
            createdAt: m.createdAt,
          })));
        }
        merged = true;
      }

      if (merged) {
        // Sort by updatedAt descending and persist via store helper
        local.sort((a, b) => b.updatedAt - a.updatedAt);
        saveSessions(local);
        setSessions([...local]);
      }
    })();
  }, [isAuthenticated, dbSynced]);

  const createChat = useCallback(() => {
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
