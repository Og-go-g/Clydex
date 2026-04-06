import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/Providers";
import { Header } from "@/components/layout/Header";
import { LiquidationWarning } from "@/components/alerts/LiquidationWarning";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Clydex N1 — AI Trading Agent for Perpetual Futures",
  description:
    "AI-powered trading assistant for perpetual futures on 01 Exchange (Solana). Chat to trade, monitor positions, and manage risk.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} antialiased`}>
        <Providers>
          <Header />
          <LiquidationWarning />
          <main className="min-h-[calc(100vh-4rem)]">
            <ErrorBoundary>{children}</ErrorBoundary>
          </main>
          <footer id="site-footer" className="flex justify-end px-6 py-4">
            <a
              href="https://x.com/ClydexAi"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-600 transition-colors hover:text-gray-300"
              aria-label="Follow on X"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
