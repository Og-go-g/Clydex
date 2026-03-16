import { prisma } from "@/lib/db";

// Base58 Solana public key: 32-44 chars, base58 alphabet
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Get or create a user by Solana wallet address (base58 public key).
 */
export async function getOrCreateUser(address: string) {
  if (!SOLANA_ADDRESS_RE.test(address)) {
    throw new Error("Invalid Solana address");
  }
  const existing = await prisma.user.findUnique({ where: { address } });
  if (existing) return existing;
  return prisma.user.upsert({
    where: { address },
    create: { address },
    update: {},
  });
}
