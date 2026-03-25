import { prisma } from "@/lib/db";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/**
 * Execute a Prisma operation with Row Level Security (RLS) context.
 *
 * Runs `SET LOCAL app.user_id = '<userId>'` inside an interactive transaction,
 * so PostgreSQL RLS policies can enforce per-user data isolation.
 * `SET LOCAL` is scoped to the transaction — it never leaks to other requests.
 *
 * Usage:
 *   const sessions = await withRLS(userId, (tx) =>
 *     tx.chatSession.findMany()
 *   );
 *
 * IMPORTANT: Keep `where: { userId }` in queries as defense-in-depth.
 * RLS is the enforcement layer; app-level filtering is the primary filter.
 */

// Only allow cuid-format IDs (alphanumeric, 20-30 chars) to prevent SQL injection
const CUID_RE = /^c[a-z0-9]{19,29}$/;

export async function withRLS<T>(
  userId: string,
  fn: (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>,
): Promise<T> {
  if (!userId || !CUID_RE.test(userId)) {
    throw new Error("withRLS: invalid userId format");
  }

  return prisma.$transaction(async (tx) => {
    // SET LOCAL only affects this transaction, safe from leaking
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  });
}
