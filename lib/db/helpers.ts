import { prisma } from "@/lib/db";

const ETH_ADDRESS_RE = /^0x[a-f0-9]{40}$/;

/**
 * Get or create a user by wallet address (lowercase).
 */
export async function getOrCreateUser(address: string) {
  const lower = address.toLowerCase();
  if (!ETH_ADDRESS_RE.test(lower)) {
    throw new Error("Invalid Ethereum address");
  }
  // Prefer findUnique to avoid unnecessary writes on every request
  const existing = await prisma.user.findUnique({ where: { address: lower } });
  if (existing) return existing;
  return prisma.user.upsert({
    where: { address: lower },
    create: { address: lower },
    update: {},
  });
}
