import { PrismaClient } from "@/lib/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

/**
 * Create a PrismaClient with Neon serverless adapter.
 * PrismaNeon v7 takes a Pool config object, not a neon() SQL function.
 */
function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  // Strip channel_binding — not supported by Neon serverless driver
  const cleanUrl = url.replace(/[&?]channel_binding=[^&]*/g, "");
  const adapter = new PrismaNeon({ connectionString: cleanUrl });
  return new PrismaClient({ adapter });
}

const KEY = Symbol.for("clydex.prisma.v4");
const store = globalThis as unknown as Record<symbol, PrismaClient | undefined>;

if (!store[KEY]) {
  store[KEY] = createClient();
}

export const prisma: PrismaClient = store[KEY];
