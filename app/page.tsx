import Link from "next/link";

// Copy Trading is highlighted first — it's the differentiating feature
// most users won't discover via the AI-chat narrative alone. Order
// reflects the funnel: copy first (zero-knowledge users who just want
// to mirror winners), then chat (hands-on traders), then capability
// cards (markets / portfolio / risk) that apply to both modes.
const features: Array<{ title: string; description: string; highlight?: boolean }> = [
  {
    title: "Copy Trading",
    description:
      "Subscribe to top-performing traders and auto-mirror their positions. Set your allocation, leverage multiplier, and per-market caps — the engine executes within seconds of each leader trade.",
    highlight: true,
  },
  {
    title: "AI Trading Chat",
    description:
      "Open positions, check prices, set triggers — all in plain English. No forms, no menus, no clicking through nested dropdowns.",
    highlight: true,
  },
  {
    title: "Perpetual Futures",
    description:
      "24+ perp markets on Solana with up to 50x leverage. BTC, ETH, SOL, and more — settled in USDC.",
  },
  {
    title: "Portfolio Management",
    description:
      "Live positions, PnL, margin health, open orders. Deposit and withdraw USDC directly to your own wallet.",
  },
  {
    title: "Risk Controls",
    description:
      "Per-position stop-loss, per-market caps, global notional limits. Configured once, enforced on every trade — copy or manual.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col items-center px-6">
      {/* Hero */}
      <section className="flex max-w-3xl flex-col items-center gap-6 pb-20 pt-24 text-center">
        <div className="rounded-full border border-border bg-card/50 backdrop-blur-sm px-4 py-1.5 text-sm text-muted">
          Clydex &middot; 01 Exchange &middot; Perpetual Futures
        </div>
        <h1 className="text-5xl font-bold leading-tight tracking-tight md:text-6xl">
          AI Trading
          <br />
          <span className="text-accent">Agent</span>
        </h1>
        <p className="max-w-xl text-lg text-muted">
          Two ways to trade perpetual futures on 01 Exchange: chat with an AI
          that places orders for you, or auto-mirror top performers.
          Non-custodial — your wallet stays in control.
        </p>
        <div className="flex gap-4 pt-4">
          <Link
            href="/chat"
            className="rounded-xl border border-accent/30 bg-accent/15 px-6 py-3 font-medium text-accent transition-colors hover:bg-accent/25"
          >
            Start Trading
          </Link>
          <Link
            href="/chat"
            className="rounded-xl border border-border px-6 py-3 font-medium text-foreground transition-colors hover:bg-card"
          >
            Browse Top Traders
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="grid w-full max-w-4xl grid-cols-1 gap-4 pb-24 md:grid-cols-2">
        {features.map((f) => (
          <div
            key={f.title}
            className={`rounded-2xl border backdrop-blur-sm p-6 transition-colors ${
              f.highlight
                ? "border-accent/30 bg-accent/5 hover:bg-accent/10"
                : "border-border bg-card/50 hover:bg-card/70"
            }`}
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
