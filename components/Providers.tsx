"use client";

import { type ReactNode } from "react";
import { WalletProvider } from "@/lib/wallet/context";
import { AuthProvider } from "@/lib/auth/context";
import { ChatProvider } from "@/lib/chat/context";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastProvider } from "@/components/alerts/ToastProvider";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <WalletProvider>
        <AuthProvider>
          <ToastProvider>
            <ChatProvider>{children}</ChatProvider>
          </ToastProvider>
        </AuthProvider>
      </WalletProvider>
    </ErrorBoundary>
  );
}
