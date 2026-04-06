import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/Providers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
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
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
