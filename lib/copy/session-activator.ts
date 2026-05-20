import nacl from "tweetnacl";
import bs58 from "bs58";
import { encryptSessionKey } from "./session-crypto";
import { upsertSession, deleteSession, getSession } from "./queries";
import { consumeNonce } from "@/lib/auth/nonce-store";
import { buildActivationMessage } from "@/app/api/copy/activate-challenge/route";

/**
 * Copy-trading session TTL.
 *
 * Reduced 2026-05-20 from 30d to 7d per the Week-1 hardening pass
 * (see docs/runbooks/key-compromise.md). A shorter TTL bounds the
 * theft window when a key is compromised — at 30d an attacker can
 * sign for a month; at 7d they can sign for one week before the
 * session expires and the on-chain delegate becomes inactive.
 *
 * 7d is the published industry sweet spot for "hot signing key with
 * limited authority" (CubeSigner, Lombard) — 24h is tighter still but
 * forces every active user to re-sign daily, which we'll only adopt
 * once we have in-product session-expiry notifications wired up.
 *
 * The existing /chat session-expiry warning surface (added in
 * Phase 8) plus the Renew button already cover the UX: users will
 * see the "expires in N hours" badge a few hours before TTL.
 */
const SESSION_TTL_DAYS = 7;

/**
 * Activate copy trading: encrypt and store the user's session keypair.
 *
 * Proof-of-ownership flow (added 2026-05-17):
 *  1. Browser calls GET /api/copy/activate-challenge → receives `nonce`.
 *  2. Browser creates NordUser (wallet signs session) → gets sessionSecretKey.
 *  3. Browser signs the canonical activation message with the WALLET (not
 *     the session key) — wallet's signMessage must approve "bind this
 *     specific session pubkey to my wallet, with this nonce".
 *  4. Browser POSTs { sessionSecretKey, sessionId, nonce, walletSignature }.
 *  5. Server verifies the wallet signature against walletAddr, atomically
 *     consumes the nonce (single-use), and stores the encrypted key.
 *
 * Without the signature step an XSS or malicious dependency could POST an
 * attacker-controlled keypair to /api/copy/activate, hijacking the
 * victim's copy-trading session.
 */
export async function activateSession(
  walletAddr: string,
  sessionSecretKeyBase58: string,
  sessionId: string | undefined,
  proof: { nonce: string; walletSignatureBase58: string },
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

  // Verify the wallet's proof-of-ownership signature over the canonical
  // activation message. The signature must cover (walletAddr, sessionPubkey,
  // nonce) so that a replay can't substitute a different session key.
  const message = buildActivationMessage({
    walletAddr,
    sessionPubkey,
    nonce: proof.nonce,
  });
  const messageBytes = new TextEncoder().encode(message);
  let signatureBytes: Uint8Array;
  let walletPubkeyBytes: Uint8Array;
  try {
    signatureBytes = bs58.decode(proof.walletSignatureBase58);
    walletPubkeyBytes = bs58.decode(walletAddr);
  } catch {
    throw new Error("Invalid signature or wallet encoding");
  }
  if (signatureBytes.length !== 64 || walletPubkeyBytes.length !== 32) {
    throw new Error("Invalid signature or wallet length");
  }
  const sigValid = nacl.sign.detached.verify(
    messageBytes,
    signatureBytes,
    walletPubkeyBytes,
  );
  if (!sigValid) {
    throw new Error("Wallet signature does not match activation message");
  }

  // Atomically consume the nonce (single-use). Must happen AFTER the
  // signature check passes — if we burn the nonce on a failed verify, a
  // legitimate retry would have to request a new challenge unnecessarily.
  const nonceOk = await consumeNonce(proof.nonce);
  if (!nonceOk) {
    throw new Error("Activation nonce expired or already used");
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
