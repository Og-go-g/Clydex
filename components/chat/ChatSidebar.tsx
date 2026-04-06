"use client";

import { useState } from "react";
import { useChatSessions } from "@/lib/chat/context";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function ChatSidebar() {
  const { sessions, activeId, createChat, selectChat, deleteChat } =
    useChatSessions();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  const sessionList = (
    <div className="flex-1 overflow-y-auto px-2 pb-3">
      {sorted.map((s) => {
        const isActive = s.id === activeId;
        const isHovered = s.id === hoveredId;

        return (
          <button
            key={s.id}
            onClick={() => {
              selectChat(s.id);
              setOpen(false);
            }}
            onMouseEnter={() => setHoveredId(s.id)}
            onMouseLeave={() => setHoveredId(null)}
            className={`group relative mb-0.5 flex w-full flex-col rounded-lg px-3 py-2.5 text-left transition-colors ${
              isActive
                ? "bg-[#1a1a1a] text-white"
                : "text-[#999] hover:bg-[#161616] hover:text-white"
            }`}
          >
            <span className="truncate text-sm leading-tight">{s.title}</span>
            <span className="mt-0.5 text-[11px] text-[#555]">
              {timeAgo(s.updatedAt)}
            </span>

            {isHovered && (
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChat(s.id);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[#555] transition-colors hover:bg-[#262626] hover:text-red-400"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" /><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                </svg>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div
        className={`hidden md:flex md:flex-col transition-all duration-200 ${
          collapsed ? "w-0" : "w-[260px]"
        }`}
      >
        {/* Sidebar content — flex-1 so it stops before the spacer */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <div className="flex h-full w-[260px] flex-col border-r border-[#262626] bg-[#0a0a0a]/15 backdrop-blur-sm">
            {/* Header: New Chat + Collapse */}
            <div className="flex items-center gap-2 p-3">
              <button
                onClick={() => createChat()}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-[#262626] bg-[#1a1a1a] px-3 py-2.5 text-sm text-white transition-colors hover:bg-[#222]"
              >
                <span className="text-base leading-none">+</span>
                New Chat
              </button>
              <button
                onClick={() => setCollapsed(true)}
                className="shrink-0 rounded-lg border border-[#262626] bg-[#1a1a1a] p-2 text-[#999] transition-colors hover:bg-[#222] hover:text-white"
                aria-label="Collapse sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 17l-5-5 5-5" /><path d="M18 17l-5-5 5-5" />
                </svg>
              </button>
            </div>
            {sessionList}
          </div>
        </div>
        {/* Spacer matching input area height (border-t aligns with chat input border) */}
        <div className="h-[78px] mt-px shrink-0 border-t border-border/40 bg-[#0a0a0a]/15 backdrop-blur-sm" />
      </div>

      {/* Desktop: expand button when collapsed */}
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          className="hidden md:flex fixed left-3 top-[4.5rem] z-30 items-center justify-center rounded-lg border border-[#262626] bg-[#141414] p-2 text-[#999] transition-colors hover:bg-[#222] hover:text-white"
          aria-label="Expand sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" />
          </svg>
        </button>
      )}

      {/* Mobile: hamburger toggle */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed left-3 top-[4.5rem] z-40 rounded-lg border border-[#262626] bg-[#141414] p-2 text-white md:hidden"
        aria-label="Toggle chat history"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 12h18M3 6h18M3 18h18" />
        </svg>
      </button>

      {/* Mobile overlay */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setOpen(false)}
          />
          <div className="fixed left-0 top-16 z-50 h-[calc(100vh-4rem)] md:hidden">
            <div className="flex h-full w-[260px] flex-col border-r border-[#262626] bg-[#0a0a0a]/15 backdrop-blur-sm">
              <div className="p-3">
                <button
                  onClick={() => {
                    createChat();
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#262626] bg-[#1a1a1a] px-3 py-2.5 text-sm text-white transition-colors hover:bg-[#222]"
                >
                  <span className="text-base leading-none">+</span>
                  New Chat
                </button>
              </div>
              {sessionList}
            </div>
          </div>
        </>
      )}
    </>
  );
}
