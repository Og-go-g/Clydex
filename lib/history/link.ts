import { historyPool, query } from "@/lib/db-history";

/**
 * Link bulk-synced data to a real wallet address.
 *
 * The bulk sync script stores data under "account:ID" as walletAddr.
 * When a user first connects, this function re-labels all their
 * records to use their real Solana wallet address.
 *
 * Runs in a transaction across all 8 history tables.
 * Idempotent — safe to call multiple times.
 */
export async function linkAccountToWallet(accountId: number, walletAddr: string): Promise<void> {
  const accountKey = `account:${accountId}`;

  // Check if there's any data under the account key
  const hasAccountData = await query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM sync_cursors WHERE "walletAddr" = $1) AS exists`,
    [accountKey],
  );
  if (!hasAccountData[0]?.exists) return;

  // Check if already linked
  const hasWalletData = await query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM sync_cursors WHERE "walletAddr" = $1) AS exists`,
    [walletAddr],
  );
  if (hasWalletData[0]?.exists) return;

  // Transaction: update all 8 tables
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
      "sync_cursors",
    ];

    for (const table of tables) {
      await client.query(
        `UPDATE ${table} SET "walletAddr" = $1 WHERE "walletAddr" = $2`,
        [walletAddr, accountKey],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
