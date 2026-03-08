"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { useWallet } from "@/lib/wallet/context";
import { useAuth } from "@/lib/auth/context";

export function Header() {
  const pathname = usePathname();
  const { address, chainId, isConnecting, error, connect, disconnect, switchToBase } =
    useWallet();
  const { isAuthenticated, signOut, isSigningIn } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const isWrongChain = address && chainId !== 8453;
  const shortAddress = address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : null;

  return (
    <>
    <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-[#262626] bg-[#0a0a0a]/80 px-6 backdrop-blur-md">
      <div className="flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2">
          <img
            src="/logo.png"
            alt="Clydex"
            width={48}
            height={48}
            className="h-12 w-12 rounded-xl object-cover"
          />
          <span className="text-lg font-semibold text-white">Clydex</span>
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          <Link
            href="/chat"
            className={`text-sm transition-colors hover:text-white ${
              pathname === "/chat" ? "text-white" : "text-gray-500"
            }`}
          >
            Chat
          </Link>
          <Link
            href="/portfolio"
            className={`text-sm transition-colors hover:text-white ${
              pathname === "/portfolio" ? "text-white" : "text-gray-500"
            }`}
          >
            Portfolio
          </Link>
          <Link
            href="/yields"
            className={`text-sm transition-colors hover:text-white ${
              pathname === "/yields" ? "text-white" : "text-gray-500"
            }`}
          >
            Yields
          </Link>
        </nav>
      </div>

      <div className="relative" ref={menuRef}>
        {!address ? (
          <button
            onClick={connect}
            disabled={isConnecting}
            className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
          >
            {isConnecting ? "Connecting..." : "Connect Wallet"}
          </button>
        ) : isWrongChain ? (
          <button
            onClick={switchToBase}
            className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-600"
          >
            Switch to Base
          </button>
        ) : isSigningIn ? (
          /* SIWE signature in progress — show signing state */
          <button
            disabled
            className="flex items-center gap-2 rounded-xl border border-[#262626] bg-[#141414] px-4 py-2 text-sm font-medium text-white opacity-70"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-400" />
            Signing...
          </button>
        ) : (
          /* Connected (and either authenticated or waiting for auto-sign) */
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-2 rounded-xl border border-[#262626] bg-[#141414] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1a1a1a]"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                isAuthenticated ? "bg-green-400" : "bg-gray-500"
              }`}
            />
            {shortAddress}
          </button>
        )}

        {/* Dropdown menu */}
        {menuOpen && address && (
          <div className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-[#262626] bg-[#141414] p-2 shadow-xl">
            <div className="mb-2 border-b border-[#262626] px-3 py-2">
              <div className="text-xs text-gray-500">
                {isAuthenticated ? "Signed in on Base" : "Connected to Base"}
              </div>
              <div className="mt-0.5 text-sm font-mono text-white">
                {shortAddress}
              </div>
            </div>
            <button
              onClick={() => {
                if (address) {
                  navigator.clipboard.writeText(address);
                }
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-[#1a1a1a] hover:text-white"
            >
              Copy Address
            </button>
            <a
              href={`https://basescan.org/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-[#1a1a1a] hover:text-white"
              onClick={() => setMenuOpen(false)}
            >
              View on BaseScan
            </a>
            <button
              onClick={async () => {
                await signOut();
                disconnect();
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
            >
              Disconnect
            </button>
          </div>
        )}

        {/* Error toast */}
        {error && (
          <div className="absolute right-0 top-full mt-2 w-64 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
            {error}
          </div>
        )}
      </div>
    </header>
    <div className="flex items-center justify-end gap-1.5 bg-[#0a0a0a] px-6 py-1">
      <span className="text-[10px] text-gray-600">built by</span>
      <a
        href="https://x.com/_Jitery_"
        target="_blank"
        rel="noopener noreferrer"
        className="text-gray-500 transition-colors hover:text-white"
        aria-label="Follow on X"
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </a>
    </div>
    </>
  );
}
