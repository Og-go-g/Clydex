"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth/context";
import { CopyTradeSection } from "@/components/copytrade/CopyTradeSection";

/**
 * /copy — top-level entry point for copy trading.
 *
 * Pre-this-page, copy trading was only reachable via the chat-mode toggle
 * (Trade ↔ Copy) which made the feature invisible to new users: the
 * "Analyze" label didn't suggest copy trading at all, and there was no
 * cue from the top nav. Now Copy is a peer of Chat / Markets / Portfolio.
 *
 * Page composition:
 *   - Hero header: title + one-line tagline + AI shortcut CTA
 *   - Embedded CopyTradeSection (already the canonical "Copy Trading
 *     / Top Traders / History" surface from the chat sidebar) so the
 *     two entry points share state, dialog wiring, and behaviour.
 *
 * The "Open AI Copy assistant" button deep-links to the chat in Copy
 * mode — both surfaces converge on the same backend, just different
 * affordances (browse the leaderboard vs. ask the AI for picks).
 */
export default function CopyPage() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Copy Trading</h1>
          <p className="mt-1 text-sm text-gray-400">
            Browse top performers on 01 Exchange and mirror their trades
            into your account.
          </p>
        </div>
        <Link
          href="/chat"
          className="inline-flex items-center justify-center gap-2 self-start rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/25 sm:self-auto"
          title="Open the AI assistant in Copy mode — ask it for trader picks"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-9-9" />
            <path d="M21 3v6h-6" />
          </svg>
          Ask AI to find traders
        </Link>
      </div>

      {isAuthenticated ? (
        <div className="rounded-2xl border border-[#262626] bg-[#0f0f0f] overflow-hidden">
          <CopyTradeSection />
        </div>
      ) : (
        <SignedOutHero />
      )}
    </div>
  );
}

function SignedOutHero() {
  return (
    <div className="rounded-2xl border border-[#262626] bg-[#0f0f0f] p-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
        <svg
          viewBox="0 0 24 24"
          className="h-6 w-6 text-emerald-400"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 12l2 2 4-4" />
          <circle cx="12" cy="12" r="10" />
        </svg>
      </div>
      <h2 className="mb-2 text-lg font-semibold text-white">Sign in to start copying</h2>
      <p className="mx-auto max-w-md text-sm text-gray-400">
        Connect your wallet and sign in to browse top traders, mirror
        their positions, and manage your copy subscriptions.
      </p>
      <p className="mx-auto mt-4 max-w-md text-xs text-gray-500">
        First-time deposit and copy activation require accepting our{" "}
        <Link href="/terms" className="text-emerald-400 underline hover:text-emerald-300">
          Terms of Service
        </Link>
        .
      </p>
    </div>
  );
}
