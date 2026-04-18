/**
 * sync-users-enqueuer — nightly fan-out.
 * Reads registered users from main DB, enqueues one sync-user-history per user
 * staggered over 4 hours.
 */

import { getBoss } from "../client";
import { JOB, type Payloads } from "../job-names";
import { prisma } from "@/lib/db";
import { getCachedAccountId } from "@/lib/n1/account-cache";

const STAGGER_WINDOW_SECONDS = 4 * 3600;

export async function handleSyncUsersEnqueuer(
  _job: { id: string; name: string; data: Payloads[typeof JOB.syncUsersEnqueuer] },
): Promise<void> {
  const users = await prisma.user.findMany({ select: { address: true } });
  console.log(`[sync-users-enqueuer] found ${users.length} users`);

  const boss = await getBoss();
  let enqueued = 0;

  for (const user of users) {
    const wallet = user.address;
    try {
      const accountId = await getCachedAccountId(wallet);
      if (accountId === null) continue;

      const delay = Math.floor(Math.random() * STAGGER_WINDOW_SECONDS);
      await boss.send(
        JOB.syncUserHistory,
        { walletAddr: wallet, accountId },
        {
          priority: 3,
          startAfter: delay,
          retryLimit: 3,
          retryDelay: 120,
          retryBackoff: true,
          expireInSeconds: 30 * 60,
          singletonKey: `user-sync-${wallet}`,
          singletonSeconds: 12 * 3600,
        },
      );
      enqueued++;
    } catch (err) {
      console.warn(`[sync-users-enqueuer] ${wallet} failed:`, err);
    }
  }

  console.log(`[sync-users-enqueuer] enqueued ${enqueued} user sync jobs`);
}
