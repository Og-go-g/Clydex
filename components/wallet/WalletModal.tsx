"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@/lib/wallet/context";

export function WalletModal() {
  const { wallets, showSelector, closeSelector, connectWallet, isConnecting, error } =
    useWallet();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!showSelector) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeSelector();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showSelector, closeSelector]);

  if (!showSelector) return null;

  return (
    <div
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) closeSelector();
      }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-sm rounded-2xl border border-[#262626] bg-[#0f0f0f] p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Connect Wallet</h2>
          <button
            onClick={closeSelector}
            className="rounded-lg p-1 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-white"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M15 5L5 15M5 5l10 10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {wallets.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-gray-400">No EVM wallet detected</p>
            <a
              href="https://metamask.io/download/"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600"
            >
              Install MetaMask
            </a>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {wallets.map((w) => (
              <button
                key={w.info.uuid}
                onClick={() => connectWallet(w)}
                disabled={isConnecting}
                className="flex items-center gap-3 rounded-xl border border-[#262626] bg-[#141414] px-4 py-3 text-left transition-colors hover:border-blue-500/50 hover:bg-[#1a1a1a] disabled:opacity-50"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={w.info.icon}
                  alt={w.info.name}
                  width={32}
                  height={32}
                  className="rounded-lg"
                />
                <span className="text-sm font-medium text-white">{w.info.name}</span>
              </button>
            ))}
          </div>
        )}

        {error && (
          <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
