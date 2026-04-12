// Polyfill MUST be imported before any SDK usage
import "./polyfill";

import { NordUser } from "@n1xyz/nord-ts";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { getNord } from "../n1/client";
import { decryptSessionKey } from "./session-crypto";
import { getSession } from "./queries";
import type { CopySession } from "./queries";

/**
 * Restore a NordUser from an encrypted session stored in the DB.
 * Uses sessionId to skip refreshSession() (which requires wallet signing).
 *
 * The restored user can:
 * - Place orders (signed by session keypair)
 * - Cancel orders, add triggers, close positions
 *
 * The restored user CANNOT:
 * - Create new sessions (requires wallet)
 * - Deposit/withdraw (requires wallet transaction signing)
 */
export async function restoreNordUser(session: CopySession): Promise<NordUser> {
  // Decrypt the stored session secret key
  let secretKey: Uint8Array;
  try {
    secretKey = decryptSessionKey({
      ciphertext: session.encryptedKey,
      iv: session.iv,
      authTag: session.authTag,
    });
  } catch {
    throw new Error("Failed to restore session: corrupted or tampered encryption data");
  }

  // Reconstruct the keypair from secret key
  const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);

  // Verify the public key matches what we stored
  const restoredPubkey = bs58.encode(keypair.publicKey);
  if (restoredPubkey !== session.sessionPubkey) {
    throw new Error("Session key mismatch: decrypted public key does not match stored pubkey");
  }

  const nord = await getNord();
  const walletPubkey = new PublicKey(session.walletAddr);

  // Parse sessionId if available — allows skipping refreshSession()
  let sessionId: bigint | undefined;
  if (session.sessionIdStr && session.sessionIdStr !== "0") {
    try {
      sessionId = BigInt(session.sessionIdStr);
    } catch {
      console.warn("[norduser-restore] invalid sessionId format:", session.sessionIdStr);
    }
  }

  const user = await NordUser.new({
    nord,
    walletPubkey,
    sessionPubkey: keypair.publicKey,
    sessionId, // If provided, NordUser skips refreshSession internally
    signMessageFn: async () => {
      throw new Error("Wallet signing not available in copy trading mode");
    },
    signTransactionFn: async () => {
      throw new Error("Wallet signing not available in copy trading mode");
    },
    signSessionFn: async (message: Uint8Array) => {
      return nacl.sign.detached(message, keypair.secretKey);
    },
  });

  // If no sessionId was stored, try refreshSession (may fail server-side)
  if (!sessionId) {
    try {
      await user.refreshSession();
    } catch (err) {
      console.warn("[norduser-restore] refreshSession failed (no sessionId stored):", err instanceof Error ? err.message : err);
      // Can't proceed without valid session
      throw new Error("Session expired or invalid — user needs to re-enable copy trading");
    }
  }

  // Hydrate account info (these use session-signed requests, should work)
  try {
    await user.updateAccountId();
  } catch (err) {
    console.warn("[norduser-restore] updateAccountId failed:", err instanceof Error ? err.message : err);
  }

  try {
    await user.fetchInfo();
  } catch (err) {
    console.warn("[norduser-restore] fetchInfo failed:", err instanceof Error ? err.message : err);
  }

  return user;
}

/**
 * Restore NordUser for a given wallet address.
 * Returns null if no active session exists.
 */
export async function restoreNordUserByWallet(walletAddr: string): Promise<NordUser | null> {
  const session = await getSession(walletAddr);
  if (!session) return null;
  return restoreNordUser(session);
}
