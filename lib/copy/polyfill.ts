/**
 * Polyfill for Uint8Array.prototype.toHex() and fromHex()
 * Required by @n1xyz/nord-ts SDK which uses TC39 proposal
 * that's only available in Node 24+. Our Docker uses node:22-alpine.
 */

declare global {
  interface Uint8Array {
    toHex(): string;
  }
  interface Uint8ArrayConstructor {
    fromHex(hex: string): Uint8Array;
  }
}

if (typeof Uint8Array.prototype.toHex !== "function") {
  Uint8Array.prototype.toHex = function (): string {
    return Array.from(this as Uint8Array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
}

if (typeof Uint8Array.fromHex !== "function") {
  Uint8Array.fromHex = function (hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  };
}

export {};
