"use client";

import { WalletProvider } from "@/lib/wallet/context";
import { AuthProvider } from "@/lib/auth/context";
import { ChatProvider } from "@/lib/chat/context";
import { WalletModal } from "@/components/wallet/WalletModal";
import { Component, type ReactNode, type ErrorInfo } from "react";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
          <div className="text-4xl">:(</div>
          <h2 className="text-xl font-bold">Something went wrong</h2>
          <p className="text-sm text-muted">An unexpected error occurred.</p>
          <button
            onClick={() => {
              this.setState({ hasError: false });
              window.location.reload();
            }}
            className="rounded-xl bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Reload Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <WalletProvider>
        <AuthProvider>
          <WalletModal />
          <ChatProvider>{children}</ChatProvider>
        </AuthProvider>
      </WalletProvider>
    </ErrorBoundary>
  );
}
