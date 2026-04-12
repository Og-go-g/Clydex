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
 * This allows the server to place orders autonomously without wallet interaction.
 *
 * The restored user has:
 * - signSessionFn: uses the decrypted session keypair
 * - signMessageFn/signTransactionFn: throws (server cannot sign with user's wallet)
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
  // tweetnacl secretKey is 64 bytes: first 32 = seed, last 32 = public key
  const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);

  // Verify the public key matches what we stored
  const restoredPubkey = bs58.encode(keypair.publicKey);
  if (restoredPubkey !== session.sessionPubkey) {
    throw new Error("Session key mismatch: decrypted public key does not match stored pubkey");
  }

  const nord = await getNord();
  const walletPubkey = new PublicKey(session.walletAddr);

  const user = await NordUser.new({
    nord,
    walletPubkey,
    sessionPubkey: keypair.publicKey,
    // Server cannot sign with user's wallet — these should never be called
    // during copy trading (only session-signed operations are used)
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

  // Refresh session on 01 Exchange (validates the keypair is still accepted)
  await user.refreshSession();
  // Hydrate account info
  await user.updateAccountId();
  await user.fetchInfo();

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
