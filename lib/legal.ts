import { prisma } from "./db";

/**
 * Single source of truth for the active Terms of Service / Privacy Policy
 * version. Bumping this string forces every existing user to re-accept
 * before their next deposit or copy-trading activation. Keep in sync with
 * the VERSION constant shown at the top of /app/terms/page.tsx and
 * /app/privacy/page.tsx.
 *
 * Versioning policy: bump on any material change. Minor copy edits
 * (typos, clarifications) don't require a bump. New disclosures, scope
 * changes, jurisdiction changes, or anything that materially affects the
 * user's obligations or rights does.
 */
export const CURRENT_TERMS_VERSION = "1.0";

/**
 * Returns true if `walletAddr` has accepted the current ToS version.
 * Tolerant to DB outages: returns false on error so the caller can
 * decide whether to fail closed (blocking the action) or fail open
 * (letting the action through). Money-touching flows fail closed.
 */
export async function hasAcceptedCurrentTerms(walletAddr: string): Promise<boolean> {
  try {
    const row = await prisma.termsAcceptance.findUnique({
      where: { walletAddr },
      select: { version: true },
    });
    return row?.version === CURRENT_TERMS_VERSION;
  } catch (err) {
    console.warn(
      "[legal] hasAcceptedCurrentTerms DB error:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Records that `walletAddr` accepted the current ToS version. Upserts so
 * a user who previously accepted v1.0 and now accepts v2.0 ends up with
 * exactly one row reflecting the latest acceptance.
 */
export async function recordTermsAcceptance(walletAddr: string): Promise<void> {
  await prisma.termsAcceptance.upsert({
    where: { walletAddr },
    create: { walletAddr, version: CURRENT_TERMS_VERSION },
    update: { version: CURRENT_TERMS_VERSION, acceptedAt: new Date() },
  });
}
