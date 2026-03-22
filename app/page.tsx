import Link from "next/link";

const features = [
  {
    title: "AI Trading Chat",
    description:
      "Open and close positions, set stop-losses, and manage your portfolio — all through natural language on 01 Exchange.",
  },
  {
    title: "Perpetual Futures",
    description:
      "Trade 24+ perpetual markets on Solana with up to 50x leverage. BTC, ETH, SOL, and more.",
  },
  {
    title: "Portfolio Management",
    description:
      "Track your positions, PnL, margin health, and open orders in real time. Deposit and withdraw USDC directly.",
  },
  {
    title: "Risk Controls",
    description:
      "Set stop-loss and take-profit triggers through chat. AI validates leverage limits per market tier before every trade.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col items-center px-6">
      {/* Hero */}
      <section className="flex max-w-3xl flex-col items-center gap-6 pb-20 pt-24 text-center">
        <div className="rounded-full border border-border bg-card px-4 py-1.5 text-sm text-muted">
          Solana &middot; 01 Exchange &middot; Perpetual Futures
        </div>
        <h1 className="text-5xl font-bold leading-tight tracking-tight md:text-6xl">
          AI Trading
          <br />
          <span className="text-accent">Agent</span>
        </h1>
        <p className="max-w-lg text-lg text-muted">
          Trade perpetual futures on 01 Exchange with an AI assistant.
          Open positions, manage risk, and track your portfolio — all through chat.
        </p>
        <div className="flex gap-4 pt-4">
          <Link
            href="/chat"
            className="rounded-xl bg-accent px-6 py-3 font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Start Trading
          </Link>
          <Link
            href="/markets"
            className="rounded-xl border border-border px-6 py-3 font-medium text-foreground transition-colors hover:bg-card"
          >
            View Markets
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
