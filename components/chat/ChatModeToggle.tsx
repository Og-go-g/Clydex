"use client";

export type ChatMode = "trading" | "copytrade";

interface ChatModeToggleProps {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
}

export function ChatModeToggle({ mode, onChange }: ChatModeToggleProps) {
  return (
    <div className="mx-auto flex max-w-2xl items-center gap-1 rounded-lg border border-border bg-card p-0.5">
      <button
        type="button"
        onClick={() => onChange("trading")}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
          mode === "trading"
            ? "bg-accent/15 text-accent"
            : "text-muted hover:text-foreground"
        }`}
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 13h2v8H3zM9 8h2v13H9zM15 11h2v10h-2zM21 4h2v17h-2z" />
        </svg>
        Trading
      </button>
      <button
        type="button"
        onClick={() => onChange("copytrade")}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
          mode === "copytrade"
            ? "bg-accent/15 text-accent"
            : "text-muted hover:text-foreground"
        }`}
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
        </svg>
        Copy Trading
        <span className="rounded bg-accent/20 px-1 py-px text-[9px] font-semibold uppercase leading-none text-accent">Soon</span>
      </button>
    </div>
  );
}
