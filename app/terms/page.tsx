import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Clydex N1",
  description: "Terms governing the use of Clydex N1, a frontend interface for the 01 Exchange perpetual futures platform on Solana.",
};

const LAST_UPDATED = "2026-05-21";
const VERSION = "1.1";

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12 text-gray-300">
      <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">
        <strong className="text-amber-200">Draft notice:</strong> This document
        is a working draft prepared by the product team and has not yet been
        reviewed by counsel. It reflects the operational reality of the
        service but should not be relied upon as a final legal agreement.
      </div>

      <h1 className="mb-2 text-3xl font-bold text-white">Terms of Service</h1>
      <p className="mb-8 text-sm text-gray-500">
        Version {VERSION} · Last updated {LAST_UPDATED}
      </p>

      <Section title="1. What Clydex is">
        <p>
          Clydex N1 (&ldquo;Clydex&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) is an independent
          frontend interface for the <a href="https://01.xyz" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">01 Exchange</a>{" "}
          perpetual-futures platform built on the Solana blockchain. Clydex
          does not operate the underlying exchange, does not custody user
          funds, does not match orders, and does not maintain order books.
          All trading, deposits, withdrawals, and settlement happen on the
          Solana blockchain through smart contracts and off-chain matching
          infrastructure operated by 01 Exchange and its associated parties.
        </p>
        <p>
          By using Clydex you acknowledge that we are a software interface
          only and that all economic activity occurs on systems we do not
          control.
        </p>
      </Section>

      <Section title="2. No advice, no recommendations">
        <p>
          Nothing on Clydex constitutes financial, legal, tax, or investment
          advice. Tools labelled as &ldquo;AI&rdquo;, &ldquo;analysis&rdquo;, &ldquo;suggest&rdquo;, or
          similar produce algorithmic outputs based on public market data
          and statistical heuristics; they are not personalised advice and
          may be incorrect, outdated, or misleading. You are solely
          responsible for every decision you make and every transaction you
          sign with your wallet.
        </p>
      </Section>

      <Section title="3. Trading risks">
        <p>
          Perpetual futures are leveraged derivative contracts. Adverse
          price moves can wipe out your collateral in seconds and trigger
          automatic liquidation. Specifically you acknowledge:
        </p>
        <ul className="mb-4 ml-6 list-disc space-y-1">
          <li>You can lose 100% of any deposit, often very quickly.</li>
          <li>
            Funding rates, slippage, network congestion, and stale oracle
            prices may move against you and are not controlled by Clydex.
          </li>
          <li>
            Smart-contract bugs or oracle failures on the underlying
            exchange could result in total loss with no path to recovery.
          </li>
          <li>
            Past trading performance — yours, another trader&apos;s, or any
            aggregate statistic shown by Clydex — does not predict future
            results.
          </li>
        </ul>
        <p>
          Trade only with capital you can afford to lose entirely.
        </p>
      </Section>

      <Section title="4. Copy-trading risks (in addition to §3)">
        <p>
          The copy-trading feature mirrors selected leaders&apos; opens, closes,
          and triggers into your own account on a polling cadence (currently
          every 15 seconds). You accept that:
        </p>
        <ul className="mb-4 ml-6 list-disc space-y-1">
          <li>
            Your fills will be different from the leader&apos;s. Price will move
            between the leader&apos;s execution and yours; you may enter at a
            worse price and exit at a worse price.
          </li>
          <li>
            Slippage, partial fills, insufficient margin, and rate limits may
            cause some copies to skip silently. The engine is best-effort.
          </li>
          <li>
            If a leader is liquidated, copy followers do not necessarily
            close cleanly. The copy-trading dialog lets you set an optional
            stop-loss percent per leader; when configured we ask the exchange
            to attach a stop-loss trigger to each copied position. If the
            trigger fires normally your position closes before liquidation —
            but the protection is best-effort: a fast gap move can blow
            through the trigger, an exchange-side error can leave the
            trigger unset (we log such failures but the trade still goes
            through), and a leader rug pulling could still drag your account
            into liquidation, sometimes at a worse price than the leader. If
            you don&apos;t configure a stop-loss percent, no protection is
            attached at all.
          </li>
          <li>
            Leaders are not vetted by Clydex. Anyone trading on 01 Exchange
            can become a leader; statistics shown may be misleading.
          </li>
          <li>
            When you unfollow a specific leader you are offered an
            &ldquo;Unfollow &amp; Close Positions&rdquo; option that attempts to
            close the positions that came from that leader, and an
            &ldquo;Unfollow Only&rdquo; option that leaves them open. Disabling
            copy trading entirely (the &ldquo;Disable&rdquo; switch in the copy-
            trading panel) does NOT trigger any closes — your open
            positions remain on the exchange and are then unmanaged.
            Closes are best-effort: a transient exchange error during
            the close pass means a position may still be open after the
            call returns successfully — always verify in your portfolio.
          </li>
        </ul>
      </Section>

      <Section title="5. Eligibility and prohibited jurisdictions">
        <p>
          Because Clydex is a frontend to 01 Exchange, the eligibility
          rules of 01 Exchange apply in full. As of the date of this
          document 01 Exchange&apos;s public FAQ states that its frontend is
          not accessible to, and may not be used by, any individual or
          entity that is a resident, citizen, incorporated in, located
          in, or otherwise operating from any jurisdiction that is
          subject to sanctions or other legal restrictions, including
          but not limited to:
        </p>
        <ul className="mb-2 ml-6 list-disc space-y-1">
          <li>the United States</li>
          <li>Canada</li>
          <li>Cuba</li>
          <li>Iran</li>
          <li>North Korea</li>
          <li>Syria</li>
          <li>Myanmar</li>
          <li>Russia (including regions occupied or controlled by Russia)</li>
        </ul>
        <p>
          In addition, you may not use Clydex if you are under 18 years
          old, or if you are a person or entity listed on a sanctions
          list maintained by OFAC, the EU, the UK, or the UN.
        </p>
        <p>
          <strong className="text-white">Representation and warranty.</strong>{" "}
          By accessing or using Clydex you represent and warrant that you
          are not a person or entity described above, and that your access
          to and use of Clydex and the underlying 01 Exchange complies with
          all applicable laws and regulations of your jurisdiction —
          including those based on citizenship, place of incorporation, or
          jurisdiction of operations, not just current physical location.
        </p>
        <p>
          You are solely responsible for determining the legality of using
          Clydex in your jurisdiction. We may block access from specific
          countries at our discretion, with or without notice, and will
          update this list to track 01 Exchange&apos;s own restrictions.
        </p>
      </Section>

      <Section title="6. Wallet security">
        <p>
          Clydex never sees, stores, or transmits your wallet&apos;s private
          keys. All transactions are signed in your wallet (Phantom,
          Solflare, etc.). You are responsible for the security of your
          wallet, your seed phrase, your device, and the software you run.
          We cannot recover lost keys, reverse transactions, or undo trades
          that you signed.
        </p>
        <p>
          For trading we generate an ephemeral session keypair held only in
          your browser memory; for copy trading the session secret is
          encrypted server-side with AES-256-GCM so the engine can mirror
          trades while you are offline. Copy-trading session keys expire
          after 7 days — you will be prompted to re-sign in your wallet
          to continue copying. Either kind of session may be revoked at
          any time by disconnecting your wallet or disabling copy trading.
        </p>
      </Section>

      <Section title="7. Fees and pricing">
        <p>
          Clydex itself does not currently charge transaction fees. You pay
          Solana network fees, 01 Exchange&apos;s trading fees, and any funding
          payments applicable to your positions, all of which are settled
          on chain. Fees may change without notice on the underlying
          exchange.
        </p>
      </Section>

      <Section title="8. No guarantee of availability">
        <p>
          Clydex is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. We do not
          guarantee uptime, accuracy, or completeness of any data. The
          interface may be temporarily or permanently unavailable due to
          maintenance, network failure, infrastructure failure on our side
          or the underlying exchange&apos;s side, regulatory action, or any
          other reason. We make no representation that the service will be
          uninterrupted, error-free, or secure.
        </p>
      </Section>

      <Section title="9. Limitation of liability">
        <p>
          To the maximum extent permitted by law, Clydex and its operators,
          contributors, and affiliates are not liable for any loss of
          funds, lost profits, lost opportunity, business interruption,
          data loss, or any direct, indirect, incidental, consequential,
          or punitive damages arising out of your use of, or inability to
          use, the service — including but not limited to losses caused by
          trades, copy-trades, AI-generated suggestions, smart-contract
          failures, oracle failures, liquidations, third-party services,
          or any bug in our code.
        </p>
      </Section>

      <Section title="10. Indemnification">
        <p>
          You agree to indemnify and hold harmless Clydex, its operators
          and contributors from any claim, demand, or damages (including
          legal fees) arising out of your use of the service, your
          violation of these terms, your violation of any law, or your
          infringement of any third-party right.
        </p>
      </Section>

      <Section title="11. Changes to these terms">
        <p>
          We may update these terms at any time. The current version and
          last-updated date appear at the top of this page. Continued use
          of the service after a material change constitutes acceptance of
          the updated terms.
        </p>
      </Section>

      <Section title="12. Governing law and disputes">
        <p>
          These terms are governed by the laws of the jurisdiction in
          which the Clydex operating entity is established. Any dispute
          must be resolved through binding arbitration in that
          jurisdiction; you waive the right to class actions. The specific
          governing-law clause will be finalised by counsel before public
          launch.
        </p>
      </Section>

      <Section title="13. Contact">
        <p>
          Questions about these terms can be sent via the project&apos;s public
          channels listed in the site footer. We do not currently provide
          individualised legal or trading support.
        </p>
      </Section>

      <div className="mt-12 border-t border-[#262626] pt-6 text-xs text-gray-600">
        <Link href="/privacy" className="text-emerald-400 hover:underline">
          Privacy Policy
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
