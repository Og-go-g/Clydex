import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Clydex N1",
  description: "How Clydex N1 collects, uses, and protects information when you use the service.",
};

const LAST_UPDATED = "2026-05-17";
const VERSION = "1.0";

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12 text-gray-300">
      <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">
        <strong className="text-amber-200">Draft notice:</strong> This document
        is a working draft prepared by the product team and has not yet been
        reviewed by counsel. It accurately reflects current data-handling
        practices but should not be relied upon as a final legal agreement.
      </div>

      <h1 className="mb-2 text-3xl font-bold text-white">Privacy Policy</h1>
      <p className="mb-8 text-sm text-gray-500">
        Version {VERSION} · Last updated {LAST_UPDATED}
      </p>

      <Section title="1. What we collect">
        <p>
          Clydex N1 is designed to collect as little personal information
          as possible. Specifically:
        </p>
        <ul className="mb-2 ml-6 list-disc space-y-1">
          <li>
            <strong className="text-white">Wallet address.</strong> A Solana
            public key (e.g. <code className="rounded bg-[#1a1a1a] px-1 text-xs">4UFB…UpdG</code>) — already
            publicly visible on chain. Used to identify your session and
            scope your data.
          </li>
          <li>
            <strong className="text-white">Sign-In-With-Solana (SIWS) signature.</strong>{" "}
            Verifies that you control the wallet. Not stored after
            verification.
          </li>
          <li>
            <strong className="text-white">IP address and user agent.</strong>{" "}
            Used in transient logs and for rate-limit buckets. Typically
            retained for less than 7 days unless required longer to
            investigate abuse.
          </li>
          <li>
            <strong className="text-white">Trading activity derived from public on-chain data.</strong>{" "}
            We index the 01 Exchange engine and Solana blockchain to
            display positions, trade history, PnL, and leaderboard
            statistics. This data is already public; we cache it for
            performance.
          </li>
          <li>
            <strong className="text-white">Chat messages.</strong> Conversations
            with the AI agent are stored to preserve context across
            sessions. Messages may include text you send and tool outputs
            we render.
          </li>
          <li>
            <strong className="text-white">Encrypted copy-trading session key.</strong>{" "}
            If you enable copy trading, the ephemeral session keypair (not
            your wallet&apos;s seed) is encrypted with AES-256-GCM and stored
            server-side so the engine can mirror trades while you are
            offline. The encrypted blob is deleted when you disable copy
            trading or when the 30-day session expires.
          </li>
          <li>
            <strong className="text-white">Error telemetry.</strong> When a
            client- or server-side error occurs we send an event to Sentry
            for diagnostics. PII is truncated where possible (e.g. wallet
            address is logged as the first 8 characters only).
          </li>
        </ul>
        <p>
          We do <strong>not</strong> collect: legal name, email address,
          phone number, government ID, banking information, social-graph
          data, or any private keys.
        </p>
      </Section>

      <Section title="2. Why we collect it">
        <ul className="mb-2 ml-6 list-disc space-y-1">
          <li>Authenticate sessions (wallet address + SIWS).</li>
          <li>Render your portfolio, positions, and trade history.</li>
          <li>Provide the AI chat and remember conversation context.</li>
          <li>Run the copy-trading engine while you are offline.</li>
          <li>Defend against abuse (rate limits, anti-DDoS).</li>
          <li>Diagnose and fix bugs (error telemetry).</li>
        </ul>
        <p>
          We do not sell, rent, or share your data with marketers or data
          brokers. We do not run third-party advertising scripts.
        </p>
      </Section>

      <Section title="3. Cookies">
        <p>
          We use a single encrypted session cookie
          (<code className="rounded bg-[#1a1a1a] px-1 text-xs">clydex_session</code>) issued
          after successful SIWS sign-in. The cookie is HTTP-only, secure,
          and same-site=strict; it cannot be read by JavaScript and is not
          shared across origins. It expires automatically after 30 days
          of inactivity or 24 hours after the last reauthentication,
          whichever comes first.
        </p>
        <p>
          We do not use tracking cookies, advertising cookies, or
          third-party analytics cookies. No cross-site behavioural
          tracking.
        </p>
      </Section>

      <Section title="4. Third parties">
        <p>
          The service depends on a small number of third-party
          infrastructure providers. Each one sees only the data necessary
          to perform its function:
        </p>
        <ul className="mb-2 ml-6 list-disc space-y-1">
          <li>
            <strong className="text-white">01 Exchange / Nord engine</strong>{" "}
            (<a href="https://01.xyz" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">01.xyz</a>) —
            sees your trading activity, balances, and positions, because
            that is where your account lives. We do not control 01
            Exchange&apos;s data handling.
          </li>
          <li>
            <strong className="text-white">Solana network</strong> — all
            on-chain transactions, balances, and addresses are public by
            design.
          </li>
          <li>
            <strong className="text-white">Solana RPC providers</strong> — your
            wallet address and IP may be visible to the RPC node that
            services your reads. Requests are proxied through our backend
            where practical to minimise exposure.
          </li>
          <li>
            <strong className="text-white">Anthropic</strong> — chat messages
            are sent to Anthropic&apos;s API to generate AI responses. See
            Anthropic&apos;s privacy policy for their handling.
          </li>
          <li>
            <strong className="text-white">Sentry</strong> — error telemetry
            described in §1.
          </li>
          <li>
            <strong className="text-white">Hetzner</strong> — the application
            and database servers are hosted by Hetzner Online GmbH in the
            EU.
          </li>
        </ul>
      </Section>

      <Section title="5. Data retention">
        <ul className="mb-2 ml-6 list-disc space-y-1">
          <li>
            <strong className="text-white">Session cookie:</strong> up to 30
            days from last use.
          </li>
          <li>
            <strong className="text-white">Chat history:</strong> retained
            until you delete it or close your account.
          </li>
          <li>
            <strong className="text-white">Copy-trading session key:</strong>{" "}
            deleted when you disable copy trading or after 30 days.
          </li>
          <li>
            <strong className="text-white">Trading / portfolio cache:</strong>{" "}
            indefinite, since the underlying data is on-chain and public.
          </li>
          <li>
            <strong className="text-white">IP / user-agent logs:</strong>{" "}
            typically less than 7 days.
          </li>
          <li>
            <strong className="text-white">Error events (Sentry):</strong>{" "}
            retained per Sentry&apos;s default 90-day retention.
          </li>
        </ul>
      </Section>

      <Section title="6. Your rights">
        <p>
          If you are in the EU, EEA, UK, or California (CCPA), you have
          the right to access, correct, port, or delete personal data we
          hold about you, and to object to processing. Because most of
          our data is keyed on a public Solana address, the practical
          mechanism is:
        </p>
        <ul className="mb-2 ml-6 list-disc space-y-1">
          <li>
            To delete your chat history: there is an option in the chat
            interface, or you can request it via the contact channel
            below.
          </li>
          <li>
            To stop the copy-trading engine: click &ldquo;Disable copy
            trading&rdquo; in the copy-trading panel. The encrypted session
            key is deleted on request.
          </li>
          <li>
            To stop using the service entirely: disconnect your wallet
            and close the tab. Your on-chain data remains on chain and is
            outside our control.
          </li>
        </ul>
      </Section>

      <Section title="7. Security">
        <p>
          We use industry-standard practices: TLS for all traffic,
          encrypted-at-rest session keys, parameterised SQL queries,
          per-wallet rate limits, CSRF protection on mutating endpoints,
          and content-security-policy headers. No system is perfectly
          secure; we may be compromised despite reasonable effort. We
          will notify affected users without undue delay if we become
          aware of a personal-data breach.
        </p>
      </Section>

      <Section title="8. Children">
        <p>
          The service is not intended for anyone under 18. We do not
          knowingly collect data from minors. If you believe a minor has
          interacted with the service, contact us and we will delete the
          data.
        </p>
      </Section>

      <Section title="9. Changes to this policy">
        <p>
          We may update this policy at any time. The current version and
          last-updated date appear at the top of this page. Continued use
          after a material change constitutes acceptance.
        </p>
      </Section>

      <Section title="10. Contact">
        <p>
          Privacy questions, deletion requests, or breach reports can be
          sent via the project&apos;s public channels in the footer.
        </p>
      </Section>

      <div className="mt-12 border-t border-[#262626] pt-6 text-xs text-gray-600">
        <Link href="/terms" className="text-emerald-400 hover:underline">
          Terms of Service
        </Link>
        {" · "}
        <Link href="/" className="hover:text-gray-400">
          Home
        </Link>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xl font-semibold text-white">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}
