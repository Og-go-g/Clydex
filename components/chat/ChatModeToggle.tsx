"use client";

import type { ChatMode } from "@/lib/chat/chart-panel-context";

interface ChatModeToggleProps {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
}

export function ChatModeToggle({ mode, onChange }: ChatModeToggleProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-px w-fit">
      <button
        type="button"
        onClick={() => onChange("trading")}
        className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
          mode === "trading"
            ? "bg-accent/15 text-accent"
            : "text-muted hover:text-foreground"
        }`}
      >
        Trade
      </button>
      <button
        type="button"
        onClick={() => onChange("copytrade")}
        className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
          mode === "copytrade"
            ? "bg-accent/15 text-accent"
            : "text-muted hover:text-foreground"
        }`}
      >
        Analyze
      </button>
    </div>
  );
}
