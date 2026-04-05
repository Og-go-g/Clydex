import { PrismaClient } from "@/lib/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Create a PrismaClient connected to local PostgreSQL.
 * Uses @prisma/adapter-pg for self-hosted DB (replaces Neon adapter).
 */
function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

const KEY = Symbol.for("clydex.prisma.v4");
const store = globalThis as unknown as Record<symbol, PrismaClient | undefined>;

if (!store[KEY]) {
  store[KEY] = createClient();
}

export const prisma: PrismaClient = store[KEY];
