import nacl from "tweetnacl";
import bs58 from "bs58";

/* ------------------------------------------------------------------ */
/*  Sign-In with Solana — message creation & verification             */
/* ------------------------------------------------------------------ */

export interface SiwsFields {
  domain: string;
  address: string;     // base58 Solana public key
  statement: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}

/** Build the human-readable sign-in message for Solana wallet signing. */
export function createSiwsMessage(fields: SiwsFields): string {
  const lines = [
    `${fields.domain} wants you to sign in with your Solana account:`,
    fields.address,
    "",
    fields.statement,
    "",
    `URI: ${fields.uri}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  ];
  if (fields.expirationTime) {
    lines.push(`Expiration Time: ${fields.expirationTime}`);
  }
  return lines.join("\n");
}

/** Parse a SIWS message string back into structured fields. */
export function parseSiwsMessage(message: string): SiwsFields | null {
  try {
    // Line 1: "{domain} wants you to sign in with your Solana account:"
    const domainMatch = message.match(
      /^(.+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})/
    );
    if (!domainMatch) return null;

    const uriMatch = message.match(/\nURI: (.+)/);
    const nonceMatch = message.match(/\nNonce: ([a-zA-Z0-9]+)/);
    const issuedMatch = message.match(/\nIssued At: (.+)/);
    const expirationMatch = message.match(/\nExpiration Time: (.+)/);

    if (!uriMatch || !nonceMatch || !issuedMatch) return null;

    // Extract statement: text between the address line and the URI line
    const lines = message.split("\n");
    const addressIdx = lines.findIndex((l) =>
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l.trim())
    );
    const uriIdx = lines.findIndex((l) => l.startsWith("URI: "));
    const statement =
      addressIdx >= 0 && uriIdx > addressIdx
        ? lines
            .slice(addressIdx + 1, uriIdx)
            .join("\n")
            .trim()
        : "";

    return {
      domain: domainMatch[1],
      address: domainMatch[2],
      statement,
      uri: uriMatch[1],
      nonce: nonceMatch[1],
      issuedAt: issuedMatch[1],
      expirationTime: expirationMatch?.[1],
    };
  } catch {
    return null;
  }
}

/**
 * Verify a SIWS message signature using ed25519 (tweetnacl).
 *
 * SECURITY: This is the critical auth verification path.
 * - Decodes the base58 public key from the message
 * - Decodes the base58 signature from the wallet
 * - Verifies the ed25519 signature over the UTF-8 encoded message bytes
 * - Returns true only if ALL checks pass
 */
export function verifySiwsSignature(
  message: string,
  signatureBase58: string
): boolean {
  const fields = parseSiwsMessage(message);
  if (!fields) return false;

  try {
    // Decode the public key from the message (base58 → 32 bytes)
    const publicKeyBytes = bs58.decode(fields.address);
    if (publicKeyBytes.length !== 32) return false;

    // Decode the signature (base58 → 64 bytes)
    const signatureBytes = bs58.decode(signatureBase58);
    if (signatureBytes.length !== 64) return false;

    // Encode the original message to UTF-8 bytes
    const messageBytes = new TextEncoder().encode(message);

    // Verify ed25519 signature
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

/**
 * Validate a base58 Solana public key.
 * Must be 32-44 chars, valid base58 alphabet, decodes to exactly 32 bytes.
 */
export function isValidSolanaAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32;
  } catch {
    return false;
  }
}
