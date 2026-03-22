"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useBackgroundVerification } from "@/hooks/useBackgroundVerification";

type StartVerification = (
  action: "deposit" | "withdraw",
  txAmount: number,
  balanceBefore: number | null,
  onSuccess?: () => void
) => void;

const VerificationContext = createContext<StartVerification>(() => {});

export function useVerification() {
  return useContext(VerificationContext);
}

export function VerificationProvider({ children }: { children: ReactNode }) {
  const { startVerification } = useBackgroundVerification();

  return (
    <VerificationContext.Provider value={startVerification}>
      {children}
    </VerificationContext.Provider>
  );
}
