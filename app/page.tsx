import Link from "next/link";

const features = [
  {
    icon: "💬",
    title: "AI Chat",
    description:
      "Ask anything about DeFi on Base. Swap tokens, find yields, check portfolio — all through natural language.",
  },
  {
    icon: "📊",
    title: "Yield Finder",
    description:
      "Find the best APY across Morpho, Aave, Aerodrome and other Base protocols in real-time.",
  },
  {
    icon: "🔄",
    title: "Swap Assistant",
    description:
      "Get quotes and execute token swaps on Base with AI-guided recommendations.",
  },
  {
    icon: "👛",
    title: "Multi-Chain Portfolio",
    description:
      "View all your token balances across Ethereum, Base, Arbitrum, Optimism, Polygon, BSC and Avalanche.",
  },
  {
    icon: "🔐",
    title: "Approval Scanner",
    description:
      "Scan and revoke risky token approvals on Base right from the chat. Protect your wallet from unlimited allowance exploits.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col items-center px-6">
      {/* Hero */}
      <section className="flex max-w-3xl flex-col items-center gap-6 pb-20 pt-24 text-center">
        <div className="rounded-full border border-border bg-card px-4 py-1.5 text-sm text-muted">
          Built on Base — Powered by AI
        </div>
        <h1 className="text-5xl font-bold leading-tight tracking-tight md:text-6xl">
          Your AI DeFi
          <br />
          <span className="text-accent">Companion</span>
        </h1>
        <p className="max-w-lg text-lg text-muted">
          Chat with AI to swap tokens, find the best yields, and manage your
          multi-chain portfolio.
        </p>
        <div className="flex gap-4 pt-4">
          <Link
            href="/chat"
            className="rounded-xl bg-accent px-6 py-3 font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Start Chatting
          </Link>
          <Link
            href="/yields"
            className="rounded-xl border border-border px-6 py-3 font-medium text-foreground transition-colors hover:bg-card"
          >
            View Yields
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="grid w-full max-w-4xl grid-cols-1 gap-4 pb-24 md:grid-cols-2">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-2xl border border-border bg-card p-6 transition-colors hover:bg-card-hover"
          >
            <div className="mb-3 text-2xl">{f.icon}</div>
            <h3 className="mb-2 text-lg font-semibold">{f.title}</h3>
            <p className="text-sm leading-relaxed text-muted">
              {f.description}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
