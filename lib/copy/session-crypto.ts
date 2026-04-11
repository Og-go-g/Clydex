import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * AES-256-GCM encryption for NordUser session secret keys.
 * The encryption key is derived from COPY_ENCRYPTION_KEY env var (64-char hex = 32 bytes).
 */

function getEncryptionKey(): Buffer {
  const hex = process.env.COPY_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("COPY_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export interface EncryptedSession {
  ciphertext: string; // hex
  iv: string;         // hex
  authTag: string;    // hex
}

/**
 * Encrypt a session secret key (64-byte Ed25519 secretKey from tweetnacl).
 */
export function encryptSessionKey(secretKey: Uint8Array): EncryptedSession {
  const key = getEncryptionKey();
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

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
 * Decrypt a session secret key back to Uint8Array.
 */
export function decryptSessionKey(encrypted: EncryptedSession): Uint8Array {
  const key = getEncryptionKey();
  const iv = Buffer.from(encrypted.iv, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");
  const ciphertext = Buffer.from(encrypted.ciphertext, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}
