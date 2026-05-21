#!/usr/bin/env tsx
/**
 * scripts/rotate-copy-key.ts — non-incident rotation of
 * COPY_ENCRYPTION_KEY without expiring active follower sessions.
 *
 * What this does:
 *   1. Reads the OLD key from `COPY_ENCRYPTION_KEY` env var (the one
 *      currently in production).
 *   2. Reads the NEW key from `--new-key=<hex>` argv OR
 *      `NEW_COPY_ENCRYPTION_KEY` env var. Both must be 64-char hex
 *      (256 bits).
 *   3. For every non-expired row in `copy_sessions`, decrypts
 *      `encrypted_key` with the OLD key + re-encrypts with the NEW
 *      key + writes back (new ciphertext + iv + auth_tag).
 *   4. All UPDATEs happen inside a single transaction. If any one
 *      row fails (e.g. auth-tag mismatch → was never encrypted with
 *      the OLD key), the whole transaction rolls back and no rows
 *      are touched.
 *   5. Self-verifies a random sample of rotated rows by decrypting
 *      with the NEW key and comparing to the original plaintext.
 *
 * Pre-conditions (operator's responsibility):
 *   - Copy engine paused via /api/admin/copy/pause (see
 *     docs/runbooks/key-compromise.md). Otherwise an in-flight
 *     engine cycle could read a row, sign with the old key, then
 *     fight a write race.
 *   - Both keys provided. Run `openssl rand -hex 32` to generate
 *     a fresh 256-bit key for the NEW value.
 *   - DB backup recently taken. This script is transactional so a
 *     mid-rotation crash leaves data intact, but a corrupted PG WAL
 *     can still bite — be ready to restore from yesterday's dump.
 *
 * Post-conditions:
 *   - Every row in `copy_sessions` (non-expired) is now decryptable
 *     ONLY with the NEW key.
 *   - The operator must immediately swap the `COPY_ENCRYPTION_KEY`
 *     env var to NEW_KEY and restart the app. Until that happens
 *     the engine cannot decrypt ANY session.
 *
 * Dry run:
 *   --dry-run  Read + simulate the rotation in memory, do NOT write.
 *              Reports row count + any rows that fail to decrypt
 *              with the OLD key (would indicate prior partial
 *              rotation or schema drift).
 *
 * Usage:
 *   export COPY_ENCRYPTION_KEY=<current-key-from-prod-env>
 *   export NEW_COPY_ENCRYPTION_KEY=$(openssl rand -hex 32)
 *   tsx scripts/rotate-copy-key.ts --dry-run    # sanity check
 *   tsx scripts/rotate-copy-key.ts              # actually rotate
 *   # then in prod: update env var to NEW value, restart, resume engine
 */

import {
  parseEncryptionKey,
  decryptSessionKeyWithKey,
  encryptSessionKeyWithKey,
} from "../lib/copy/session-crypto";
import { historyPool } from "../lib/db-history";

interface SessionRow {
  id: string;
  walletAddr: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
  expiresAt: Date;
}

interface RotationResult {
  totalScanned: number;
  rotated: number;
  failed: Array<{ walletAddr: string; reason: string }>;
}

async function rotate(opts: {
  oldKey: Buffer;
  newKey: Buffer;
  dryRun: boolean;
}): Promise<RotationResult> {
  const { oldKey, newKey, dryRun } = opts;

  // Lock the table for the duration of the rotation. ACCESS EXCLUSIVE
  // is the strongest mode — no concurrent reads OR writes. Acceptable
  // here because the operator should have already paused the engine.
  // SHARE UPDATE EXCLUSIVE would let reads through but we want the
  // hard guarantee that nothing observes the half-rotated state.
  //
  // If you can't take an ACCESS EXCLUSIVE (engine still warm), the
  // alternative is row-level FOR UPDATE inside the loop — slower but
  // tolerant. Wire that variant up only if the pause-first invariant
  // becomes unreliable.
  const client = await historyPool.connect();

  const result: RotationResult = {
    totalScanned: 0,
    rotated: 0,
    failed: [],
  };

  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE copy_sessions IN ACCESS EXCLUSIVE MODE");

    const rows: SessionRow[] = (
      await client.query<SessionRow>(
        `SELECT id, wallet_addr AS "walletAddr", encrypted_key AS "encryptedKey",
                iv, auth_tag AS "authTag", expires_at AS "expiresAt"
         FROM copy_sessions
         WHERE expires_at > NOW()`,
      )
    ).rows;

    result.totalScanned = rows.length;
    console.log(
      `[rotate] scanning ${rows.length} non-expired session(s)…`,
    );

    for (const row of rows) {
      let plaintext: Uint8Array;
      try {
        plaintext = decryptSessionKeyWithKey(
          { ciphertext: row.encryptedKey, iv: row.iv, authTag: row.authTag },
          oldKey,
        );
      } catch (err) {
        // GCM auth-tag mismatch means the OLD key wasn't actually
        // the encrypting key. Could be: partially-rotated DB, corrupt
        // row, or operator passed the wrong OLD key. Abort.
        result.failed.push({
          walletAddr: row.walletAddr,
          reason: `decrypt-with-old-key failed: ${(err as Error).message}`,
        });
        throw new Error(
          `Row ${row.walletAddr} cannot be decrypted with the supplied OLD key. ` +
            `Aborting rotation — no rows have been modified.`,
        );
      }

      const reencrypted = encryptSessionKeyWithKey(plaintext, newKey);

      // Belt-and-braces: confirm a new-key round-trip BEFORE writing.
      // GCM is symmetric so if encryptWithKey succeeded, decryptWithKey
      // will too, but we want to know early if the new key is malformed.
      const verify = decryptSessionKeyWithKey(reencrypted, newKey);
      if (!Buffer.from(verify).equals(Buffer.from(plaintext))) {
        result.failed.push({
          walletAddr: row.walletAddr,
          reason: "post-encrypt verify mismatch — should be impossible",
        });
        throw new Error(
          `Internal error: post-encrypt verify failed for ${row.walletAddr}. ` +
            `Aborting.`,
        );
      }

      if (!dryRun) {
        await client.query(
          `UPDATE copy_sessions
             SET encrypted_key = $1, iv = $2, auth_tag = $3
           WHERE id = $4`,
          [reencrypted.ciphertext, reencrypted.iv, reencrypted.authTag, row.id],
        );
      }

      result.rotated += 1;

      // Zeroize the plaintext we just held in memory — paranoia, but
      // why hold it any longer than needed.
      plaintext.fill(0);
    }

    if (dryRun) {
      await client.query("ROLLBACK");
      console.log(`[rotate] DRY RUN — rolling back, no writes performed.`);
    } else {
      await client.query("COMMIT");
      console.log(`[rotate] committed ${result.rotated} row update(s).`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return result;
}

function readNewKey(): string {
  const fromArg = process.argv.find((a) => a.startsWith("--new-key="));
  if (fromArg) return fromArg.slice("--new-key=".length);
  const fromEnv = process.env.NEW_COPY_ENCRYPTION_KEY;
  if (fromEnv) return fromEnv;
  throw new Error(
    "NEW key not supplied. Pass --new-key=<64-char-hex> OR set NEW_COPY_ENCRYPTION_KEY env var.",
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const oldHex = process.env.COPY_ENCRYPTION_KEY;
  if (!oldHex) {
    throw new Error("COPY_ENCRYPTION_KEY env var (the OLD key) is required.");
  }
  const newHex = readNewKey();
  if (oldHex === newHex) {
    throw new Error("OLD and NEW keys are identical — nothing to rotate.");
  }

  const oldKey = parseEncryptionKey(oldHex);
  const newKey = parseEncryptionKey(newHex);

  console.log(`[rotate] ${dryRun ? "DRY RUN" : "LIVE RUN"} — beginning…`);
  console.log(`[rotate] old key fingerprint: ${oldHex.slice(0, 8)}…`);
  console.log(`[rotate] new key fingerprint: ${newHex.slice(0, 8)}…`);

  const result = await rotate({ oldKey, newKey, dryRun });

  console.log(`[rotate] scanned: ${result.totalScanned}`);
  console.log(`[rotate] rotated: ${result.rotated}`);
  if (result.failed.length > 0) {
    console.log(`[rotate] FAILED: ${result.failed.length}`);
    for (const f of result.failed) {
      console.log(`  - ${f.walletAddr}: ${f.reason}`);
    }
  }

  if (!dryRun) {
    console.log("");
    console.log(`[rotate] Next steps (do them now):`);
    console.log(`  1. Update COPY_ENCRYPTION_KEY in prod .env to: ${newHex.slice(0, 8)}…`);
    console.log(`     (full value: ${newHex})`);
    console.log(`  2. Restart the app: docker compose restart app worker`);
    console.log(`  3. Resume copy engine: curl -X POST .../api/admin/copy/resume`);
    console.log(`  4. Spot-check: tail worker logs for one engine cycle, confirm`);
    console.log(`     no 'decrypt failed' breadcrumbs.`);
  }

  // Avoid leaving secrets in stack frames longer than needed. The
  // process is about to exit anyway but explicit beats lucky.
  oldKey.fill(0);
  newKey.fill(0);
}

// Top-level await — we're a CLI script, not a library.
main().catch((err) => {
  console.error(`[rotate] ${(err as Error).message}`);
  console.error("[rotate] No rows were modified (transaction rolled back).");
  process.exit(1);
});
