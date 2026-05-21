import { describe, it, expect } from "vitest";
import {
  encryptSessionKey,
  decryptSessionKey,
  encryptSessionKeyWithKey,
  decryptSessionKeyWithKey,
  parseEncryptionKey,
} from "./session-crypto";

const KEY_A = "00".repeat(31) + "01"; // 64 hex chars
const KEY_B = "00".repeat(31) + "02";

// A representative Ed25519 64-byte secret (tweetnacl-style).
const SECRET = new Uint8Array(64);
for (let i = 0; i < 64; i++) SECRET[i] = i;

describe("parseEncryptionKey", () => {
  it("accepts a 64-char hex string", () => {
    const buf = parseEncryptionKey(KEY_A);
    expect(buf.length).toBe(32);
  });

  it("rejects empty / short / non-hex", () => {
    expect(() => parseEncryptionKey("")).toThrow();
    expect(() => parseEncryptionKey("abcd")).toThrow();
    expect(() => parseEncryptionKey("z".repeat(64))).toThrow();
    expect(() => parseEncryptionKey("0".repeat(63))).toThrow();
  });
});

describe("encrypt/decrypt round-trip via env (default API)", () => {
  it("decrypts to the same bytes it was given", () => {
    process.env.COPY_ENCRYPTION_KEY = KEY_A;
    const blob = encryptSessionKey(SECRET);
    const out = decryptSessionKey(blob);
    expect(Array.from(out)).toEqual(Array.from(SECRET));
  });

  it("emits a fresh IV per call (non-deterministic ciphertext)", () => {
    process.env.COPY_ENCRYPTION_KEY = KEY_A;
    const a = encryptSessionKey(SECRET);
    const b = encryptSessionKey(SECRET);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("encrypt/decrypt with explicit key (rotation API)", () => {
  it("round-trips with the same key", () => {
    const k = parseEncryptionKey(KEY_A);
    const blob = encryptSessionKeyWithKey(SECRET, k);
    const out = decryptSessionKeyWithKey(blob, k);
    expect(Array.from(out)).toEqual(Array.from(SECRET));
  });

  it("rejects decryption with the wrong key (GCM auth fail)", () => {
    const kA = parseEncryptionKey(KEY_A);
    const kB = parseEncryptionKey(KEY_B);
    const blob = encryptSessionKeyWithKey(SECRET, kA);
    expect(() => decryptSessionKeyWithKey(blob, kB)).toThrow();
  });

  it("re-encryption produces a different ciphertext but the same plaintext", () => {
    const kA = parseEncryptionKey(KEY_A);
    const kB = parseEncryptionKey(KEY_B);
    const blob1 = encryptSessionKeyWithKey(SECRET, kA);
    const plain = decryptSessionKeyWithKey(blob1, kA);
    const blob2 = encryptSessionKeyWithKey(plain, kB);
    expect(blob2.ciphertext).not.toBe(blob1.ciphertext);
    // And the new blob is decryptable with the new key only.
    expect(Array.from(decryptSessionKeyWithKey(blob2, kB))).toEqual(
      Array.from(SECRET),
    );
    expect(() => decryptSessionKeyWithKey(blob2, kA)).toThrow();
  });
});
