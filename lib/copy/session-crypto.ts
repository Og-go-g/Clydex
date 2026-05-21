import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * AES-256-GCM encryption for NordUser session secret keys.
 * The default encryption key is derived from COPY_ENCRYPTION_KEY env
 * var (64-char hex = 32 bytes). For key rotation, the
 * `*WithKey` variants accept an explicit Buffer so the rotation
 * script can read with the OLD key and re-encrypt with the NEW one
 * without touching the global process env.
 */

/** Parse a 64-char hex string (32 bytes) into a Buffer or throw. */
export function parseEncryptionKey(hex: string): Buffer {
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "encryption key must be a 64-character hex string (32 bytes)",
    );
  }
  return Buffer.from(hex, "hex");
}

function getEncryptionKey(): Buffer {
  const hex = process.env.COPY_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "COPY_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)",
    );
  }
  return parseEncryptionKey(hex);
}

export interface EncryptedSession {
  ciphertext: string; // hex
  iv: string;         // hex
  authTag: string;    // hex
}

/**
 * Encrypt a session secret key with an explicit master key. Used by
 * the rotation script. App code should use `encryptSessionKey`.
 */
export function encryptSessionKeyWithKey(
  secretKey: Uint8Array,
  masterKey: Buffer,
): EncryptedSession {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(secretKey)),
    cipher.final(),
  ]);

  return {
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

/**
 * Decrypt a session secret key with an explicit master key. Used by
 * the rotation script. App code should use `decryptSessionKey`.
 *
 * Throws on auth-tag mismatch — that's the GCM contract for "wrong
 * key OR tampered ciphertext", and the rotation script relies on
 * this to detect rows that the OLD key can't decrypt (i.e. already
 * rotated or otherwise corrupt).
 */
export function decryptSessionKeyWithKey(
  encrypted: EncryptedSession,
  masterKey: Buffer,
): Uint8Array {
  const iv = Buffer.from(encrypted.iv, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");
  const ciphertext = Buffer.from(encrypted.ciphertext, "hex");

  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}

/**
 * Encrypt a session secret key (64-byte Ed25519 secretKey from tweetnacl).
 */
export function encryptSessionKey(secretKey: Uint8Array): EncryptedSession {
  return encryptSessionKeyWithKey(secretKey, getEncryptionKey());
}

/**
 * Decrypt a session secret key back to Uint8Array.
 */
export function decryptSessionKey(encrypted: EncryptedSession): Uint8Array {
  return decryptSessionKeyWithKey(encrypted, getEncryptionKey());
}
