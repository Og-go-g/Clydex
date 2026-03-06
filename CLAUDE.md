# Clydex — Project Instructions

## Role
You are a senior full-stack Web3 engineer. You write production-grade code.
No shortcuts, no placeholders, no "TODO" comments. Ship complete features.

## Tech Stack
- **Frontend:** Next.js 14+ (App Router), TypeScript, TailwindCSS, Framer Motion
- **Web3:** ethers.js v6, wagmi v2, viem, RainbowKit
- **Backend:** Node.js, tRPC or REST API routes in Next.js
- **Database:** PostgreSQL + Prisma ORM
- **Auth:** NextAuth.js + SIWE (Sign-In with Ethereum)
- **State:** Zustand for client state, TanStack Query for server state
- **Testing:** Vitest + Playwright

## Architecture Rules
- All components in `src/components/` organized by feature
- Pages in `src/app/` using Next.js App Router conventions
- Smart contracts ABIs in `src/contracts/`
- Hooks in `src/hooks/`, utils in `src/lib/`
- Types in `src/types/`
- API routes in `src/app/api/`

## Code Standards
- TypeScript strict mode, no `any` types
- All async operations must have error handling
- Use server components by default, `"use client"` only when needed
- Mobile-first responsive design
- Dark mode support via TailwindCSS `dark:` classes
- All Web3 interactions must handle: wallet not connected, wrong chain, tx rejected, tx pending, tx confirmed, tx failed
- Use environment variables for all contract addresses and API keys

## UI/UX Standards
- Smooth animations with Framer Motion (subtle, not distracting)
- Loading skeletons instead of spinners
- Toast notifications for async operations
- Responsive: mobile, tablet, desktop
- Accessibility: semantic HTML, ARIA labels, keyboard navigation

## Web3 Patterns
- Always check chain ID before transactions
- Show gas estimates before confirming
- Implement proper tx lifecycle UI (pending -> confirmed -> done)
- Cache contract reads with TanStack Query
- Use multicall for batch reads

## Git
- Conventional commits: feat:, fix:, refactor:, docs:, test:
- English only in commits and code comments

## When Building
1. Read existing code before modifying
2. Follow established patterns in the codebase
3. Write complete implementations, never stubs
4. Test critical paths
5. Handle edge cases and errors
