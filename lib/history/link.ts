import { historyPool, query } from "@/lib/db-history";

/**
 * Link bulk-synced data to a real wallet address.
 *
 * The bulk sync script stores data under "account:ID" as walletAddr.
 * When a user first connects, this function re-labels all their
 * records to use their real Solana wallet address.
 *
 * Uses UPDATE with conflict-safe approach: updates walletAddr on all rows
 * that have the account key. Unique constraint violations (duplicates)
 * are handled by deleting the account:ID row when a real-wallet row exists.
 *
 * Idempotent — safe to call multiple times.
 */
export async function linkAccountToWallet(accountId: number, walletAddr: string): Promise<void> {
  const accountKey = `account:${accountId}`;

  // Check if there's any data under the account key
  const hasAccountData = await query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM trade_history WHERE "walletAddr" = $1 LIMIT 1) AS exists`,
    [accountKey],
  );
  if (!hasAccountData[0]?.exists) return; // nothing to link

  // Transaction: update all tables — move account:ID → real wallet
  const client = await historyPool.connect();
  try {
    await client.query("BEGIN");

    const tables = [
      "trade_history",
      "order_history",
      "pnl_history",
      "funding_history",
      "deposit_history",
      "withdrawal_history",
      "liquidation_history",
      "volume_calendar",
      "pnl_totals",
    ];

    for (const table of tables) {
      // First: try to update. Unique constraint violations mean the row
      // already exists under the real wallet — just delete the account:ID duplicate.
      await client.query(
        `UPDATE ${table} SET "walletAddr" = $1 WHERE "walletAddr" = $2`,
        [walletAddr, accountKey],
      ).catch(async () => {
        // Unique conflict — delete bulk-synced duplicates that already exist under real wallet
        await client.query(
          `DELETE FROM ${table} WHERE "walletAddr" = $1`,
          [accountKey],
        );
      });
    }

    // Sync cursors: delete account key entries, keep real wallet ones
    // (per-user sync already created fresh cursors under real wallet)
    await client.query(
      `DELETE FROM sync_cursors WHERE "walletAddr" = $1`,
      [accountKey],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
