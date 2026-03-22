# Clydex N1 — Project Instructions

## Role
You are a senior full-stack Web3 engineer. You write production-grade code.
No shortcuts, no placeholders, no "TODO" comments. Ship complete features.

## Tech Stack
- **Frontend:** Next.js 16 (App Router, Turbopack), TypeScript, TailwindCSS
- **Web3:** @solana/web3.js, @solana/wallet-adapter-react, @n1xyz/nord-ts (01 Exchange SDK)
- **Backend:** REST API routes in Next.js
- **Database:** PostgreSQL + Prisma ORM (Neon)
- **Auth:** SIWS (Sign-In with Solana) via iron-session encrypted cookies
- **Monitoring:** Sentry, Upstash Redis for rate limiting

## Architecture Rules
- Components in `components/` organized by feature
- Pages in `app/` using Next.js App Router conventions
- Hooks in `hooks/`, utils in `lib/`
- N1/01 Exchange SDK wrappers in `lib/n1/`
- API routes in `app/api/`
- Market IDs come from the 01 Exchange API — never hardcode them

## Code Standards
- TypeScript strict mode, no `any` types
- All async operations must have error handling
- Use server components by default, `"use client"` only when needed
- Mobile-first responsive design
- Dark mode by default
- All wallet interactions must handle: not connected, tx rejected, tx pending, tx confirmed, tx failed
- Use environment variables for all API keys (server-side only, never NEXT_PUBLIC_ for secrets)

## Security
- RPC keys stay on server, proxied to browser via `/api/solana-rpc`
- Wallet private keys never leave the user's wallet
- Session keypairs are ephemeral (in-memory only)
- All API routes check authentication via `getAuthAddress()`
- Rate limiting on proxy endpoints

## Web3 Patterns
- Solana wallet adapter for wallet connections (Phantom, Solflare, etc.)
- NordUser sessions for trading operations (ephemeral keypair, wallet signs session creation)
- Market cache: `setMarketCache()` / `getCachedMarkets()` / `ensureMarketCache()`
- `resolveMarket()` for flexible market lookup (symbol, base asset, ID)
- `tierFromImf()` derives tier and max leverage from API's initial margin fraction

## Git
- Conventional commits: feat:, fix:, refactor:, docs:, test:
- English only in commits and code comments

## When Building
1. Read existing code before modifying
2. Follow established patterns in the codebase
3. Write complete implementations, never stubs
4. Test critical paths
5. Handle edge cases and errors
