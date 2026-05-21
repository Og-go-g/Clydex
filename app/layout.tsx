import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { connection } from "next/server";
import { Providers } from "@/components/Providers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { WireframeBackground } from "@/components/layout/WireframeBackground";
import { LiquidationWarning } from "@/components/alerts/LiquidationWarning";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Clydex N1 — AI Trading Agent for Perpetual Futures",
  description:
    "AI-powered trading assistant for perpetual futures on 01 Exchange (Solana). Chat to trade, monitor positions, and manage risk.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Opt the entire app into dynamic rendering. Without this, pages
  // like `/`, `/privacy`, `/terms` (and the client-component shells
  // for `/chat`, `/portfolio`, `/markets`) would be statically
  // prerendered at build time, with no incoming request from which
  // middleware could inject a CSP nonce — every script would end up
  // un-nonced and 'strict-dynamic' would refuse to execute them.
  // Per-request rendering is cheap for these layouts; the production
  // cost is acceptable in exchange for a strict CSP.
  await connection();
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} antialiased`}>
        <Providers>
          <WireframeBackground />
          <Header />
          <LiquidationWarning />
          <main className="min-h-[calc(100vh-4rem)]">
            <ErrorBoundary>{children}</ErrorBoundary>
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
