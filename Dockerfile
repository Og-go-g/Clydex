# ============================================================
# Clydex N1 — Production Dockerfile
# Multi-stage build for Next.js standalone output
# ============================================================

# ─── Stage 1: Dependencies ────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --ignore-scripts

# ─── Stage 2: Build ───────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma clients (main + history)
RUN npx prisma generate --schema prisma/schema.prisma && \
    npx prisma generate --schema prisma/history.prisma

# Build Next.js (standalone output)
# Dummy env vars needed at build time (code validates on import)
ENV SESSION_SECRET=build-placeholder-secret-minimum-32-characters-long \
    SIWE_SECRET=build-placeholder-secret-minimum-32-characters-long \
    DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy \
    HISTORY_DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy \
    UPSTASH_REDIS_REST_URL=https://dummy.upstash.io \
    UPSTASH_REDIS_REST_TOKEN=dummy-token \
    NEXT_PUBLIC_SENTRY_DSN=https://dummy@sentry.io/0 \
    SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
    CRON_SECRET=dummy-cron-secret \
    OPENAI_API_KEY=sk-dummy
RUN npm run build

# ─── Stage 3: Production ──────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Prisma schemas (needed at runtime for migrations)
COPY --from=builder /app/prisma ./prisma

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
