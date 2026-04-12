import nacl from "tweetnacl";
import bs58 from "bs58";
import { encryptSessionKey } from "./session-crypto";
import { upsertSession, deleteSession, getSession } from "./queries";

const SESSION_TTL_DAYS = 30;

/**
 * Activate copy trading: encrypt and store the user's session keypair.
 *
 * Flow:
 * 1. Browser creates NordUser (wallet signs session) → gets sessionSecretKey
 * 2. Browser sends sessionSecretKey (base58) to this function
 * 3. We verify the keypair is valid, encrypt it, and store in DB
 */
export async function activateSession(
  walletAddr: string,
  sessionSecretKeyBase58: string,
  sessionId?: string,
): Promise<{ sessionPubkey: string; expiresAt: Date }> {
  // Decode the secret key
  const secretKey = bs58.decode(sessionSecretKeyBase58);

  // Validate: tweetnacl Ed25519 secret key is 64 bytes
  if (secretKey.length !== 64) {
    throw new Error("Invalid session key: expected 64 bytes");
  }

  // Entropy check: reject all-zero or low-entropy keys
  const uniqueBytes = new Set(secretKey);
  if (uniqueBytes.size < 16) {
    throw new Error("Session key has insufficient entropy");
  }

  // Reconstruct keypair to verify and extract public key
  const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
  const sessionPubkey = bs58.encode(keypair.publicKey);

  // Test the keypair: sign and verify with random challenge
  const { randomBytes } = await import("crypto");
  const challenge = randomBytes(32);
  const sig = nacl.sign.detached(challenge, keypair.secretKey);
  if (!nacl.sign.detached.verify(challenge, sig, keypair.publicKey)) {
    throw new Error("Session key verification failed");
  }

  // Encrypt and store
  const encrypted = encryptSessionKey(secretKey);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await upsertSession(walletAddr, encrypted, sessionPubkey, expiresAt, sessionId);

  return { sessionPubkey, expiresAt };
}

/**
 * Deactivate copy trading: remove stored session.
 */
export async function deactivateSession(walletAddr: string): Promise<void> {
  await deleteSession(walletAddr);
}

/**
 * Check if copy trading session is active.
 */
export async function isSessionActive(walletAddr: string): Promise<{
  active: boolean;
  sessionPubkey: string | null;
  expiresAt: Date | null;
}> {
  const session = await getSession(walletAddr);
  if (!session) {
    return { active: false, sessionPubkey: null, expiresAt: null };
  }
  return {
    active: true,
    sessionPubkey: session.sessionPubkey,
    expiresAt: session.expiresAt,
  };
}
