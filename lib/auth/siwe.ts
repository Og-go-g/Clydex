import { verifyMessage, type Hex } from "viem";

/* ------------------------------------------------------------------ */
/*  EIP-4361: Sign-In with Ethereum — message creation & verification */
/* ------------------------------------------------------------------ */

export interface SiweFields {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}

/** Build the human-readable EIP-4361 message that the wallet will sign. */
export function createSiweMessage(fields: SiweFields): string {
  const lines = [
    `${fields.domain} wants you to sign in with your Ethereum account:`,
    fields.address,
    "",
    fields.statement,
    "",
    `URI: ${fields.uri}`,
    `Version: ${fields.version}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  ];
  if (fields.expirationTime) {
    lines.push(`Expiration Time: ${fields.expirationTime}`);
  }
  return lines.join("\n");
}

/** Parse an EIP-4361 message string back into structured fields. */
export function parseSiweMessage(message: string): SiweFields | null {
  try {
    const domainMatch = message.match(
      /^(.+) wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})/
    );
    if (!domainMatch) return null;

    const uriMatch = message.match(/\nURI: (.+)/);
    const versionMatch = message.match(/\nVersion: (\d+)/);
    const chainMatch = message.match(/\nChain ID: (\d+)/);
    const nonceMatch = message.match(/\nNonce: ([a-zA-Z0-9]+)/);
    const issuedMatch = message.match(/\nIssued At: (.+)/);
    const expirationMatch = message.match(/\nExpiration Time: (.+)/);

    if (!uriMatch || !versionMatch || !chainMatch || !nonceMatch || !issuedMatch) {
      return null;
    }

    // Extract statement: text between the address line and the URI line
    const lines = message.split("\n");
    const addressIdx = lines.findIndex((l) =>
      /^0x[0-9a-fA-F]{40}$/.test(l.trim())
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
      version: versionMatch[1],
      chainId: parseInt(chainMatch[1], 10),
      nonce: nonceMatch[1],
      issuedAt: issuedMatch[1],
      expirationTime: expirationMatch?.[1],
    };
  } catch {
    return null;
  }
}

/** Verify the SIWE message signature using viem's EIP-191 verifyMessage. */
export async function verifySiweSignature(
  message: string,
  signature: string
): Promise<boolean> {
  const fields = parseSiweMessage(message);
  if (!fields) return false;

  try {
    return await verifyMessage({
      address: fields.address as Hex,
      message,
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}
