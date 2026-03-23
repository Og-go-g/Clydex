"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

// ─── Types ──────────────────────────────────────────────────────

export type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
  createdAt: number;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (opts: { type: ToastType; title: string; message?: string; duration?: number }) => void;
  removeToast: (id: string) => void;
}

// ─── Context ────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue>({
  toasts: [],
  addToast: () => {},
  removeToast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

// ─── Icons ──────────────────────────────────────────────────────

function ToastIcon({ type }: { type: ToastType }) {
  const cls = "h-4 w-4 flex-shrink-0";
  switch (type) {
    case "success":
      return (
        <svg className={`${cls} text-green-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "error":
      return (
        <svg className={`${cls} text-red-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "warning":
      return (
        <svg className={`${cls} text-yellow-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 9v4m0 4h.01M12 3l9.5 16.5H2.5L12 3z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "info":
      return (
        <svg className={`${cls} text-blue-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4m0-4h.01" strokeLinecap="round" />
        </svg>
      );
  }
}

const TYPE_STYLES: Record<ToastType, string> = {
  success: "border-green-500/30 bg-green-500/10",
  error: "border-red-500/30 bg-red-500/10",
  warning: "border-yellow-500/30 bg-yellow-500/10",
  info: "border-blue-500/30 bg-blue-500/10",
};

// ─── Provider ───────────────────────────────────────────────────

const MAX_TOASTS = 5;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clear all timers on unmount
  useEffect(() => {
    return () => {
      for (const t of timersRef.current.values()) clearTimeout(t);
    };
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const addToast = useCallback(
    ({
      type,
      title,
      message,
      duration = 5000,
    }: {
      type: ToastType;
      title: string;
      message?: string;
      duration?: number;
    }) => {
      const id = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const toast: Toast = { id, type, title, message, duration, createdAt: Date.now() };

      setToasts((prev) => {
        const next = [...prev, toast];
        // Evict oldest if over limit
        if (next.length > MAX_TOASTS) {
          const removed = next.shift();
          if (removed) {
            const timer = timersRef.current.get(removed.id);
            if (timer) clearTimeout(timer);
            timersRef.current.delete(removed.id);
          }
        }
        return next;
      });

      // Auto-dismiss
      if (duration > 0) {
        const timer = setTimeout(() => removeToast(id), duration);
        timersRef.current.set(id, timer);
      }
    },
    [removeToast]
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}

      {/* Toast Container */}
      <div
        className="fixed top-4 right-4 z-[100] flex flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.type === "error" || toast.type === "warning" ? "alert" : "status"}
            aria-live={toast.type === "error" || toast.type === "warning" ? "assertive" : "polite"}
            className={`flex w-80 items-start gap-3 rounded-xl border p-3 shadow-2xl backdrop-blur-md animate-[slideUp_0.2s_ease-out] ${TYPE_STYLES[toast.type]}`}
          >
            <ToastIcon type={toast.type} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">{toast.title}</div>
              {toast.message && (
                <div className="mt-0.5 text-xs text-muted line-clamp-2">{toast.message}</div>
              )}
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="flex-shrink-0 rounded p-0.5 text-muted hover:text-foreground transition-colors"
              aria-label="Dismiss"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
