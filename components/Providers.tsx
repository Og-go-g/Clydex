"use client";

import { type ReactNode } from "react";
import { WalletProvider } from "@/lib/wallet/context";
import { AuthProvider } from "@/lib/auth/context";
import { ChatProvider } from "@/lib/chat/context";
import { WalletModal } from "@/components/wallet/WalletModal";
import { ErrorBoundary } from "@/components/ErrorBoundary";

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
