import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP authenticator second factor (RFC 6238, SHA-1, 30-second
// steps, 6 digits), plus AES-256-GCM encryption for the stored
// secret. Standard library only: no QR library is added, so
// enrollment shows the manual setup key and the otpauth:// URL,
// which Google and Microsoft Authenticator both accept.
// A secret is 20 random bytes (160 bits), the RFC 6238 size for
// SHA-1. Verification accepts one step of clock skew either way;
// deletion-time codes are additionally bounded by the deletion
// routes' own rate limits, and enrollment verification by the
// totp-verify-user scope, so the window cannot be brute-forced.

export class TotpConfigurationError extends Error {
  constructor() {
    super("Two-factor authentication is not configured.");
    this.name = "TotpConfigurationError";
  }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  while (output.length % 8 !== 0) output += "=";
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.trim().replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0 || /[^A-Z2-7]/.test(cleaned)) {
    throw new Error("Invalid base32 secret.");
  }
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: bigint): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

export function totpCode(secretBase32: string, timeMs: number): string {
  const counter = BigInt(Math.floor(timeMs / 1000 / 30));
  return hotp(base32Decode(secretBase32), counter);
}

export function verifyTotpCode(secretBase32: string, code: string, timeMs: number): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = BigInt(Math.floor(timeMs / 1000 / 30));
  const secret = base32Decode(secretBase32);
  for (const delta of [-1n, 0n, 1n]) {
    const step = counter + delta;
    // The first 30 seconds of the epoch have no previous step.
    if (step < 0n) continue;
    const expected = hotp(secret, step);
    if (timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(code, "utf8"))) {
      return true;
    }
  }
  return false;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpSetupUrl(secretBase32: string, accountEmail: string): string {
  return (
    `otpauth://totp/Nexora:${encodeURIComponent(accountEmail)}` +
    `?secret=${secretBase32}&issuer=Nexora&algorithm=SHA1&digits=6&period=30`
  );
}

export function getTotpEncryptionKey(): Buffer {
  const raw = process.env.NEXORA_TOTP_ENCRYPTION_KEY?.trim() ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new TotpConfigurationError();
  return Buffer.from(raw, "hex");
}

export function encryptTotpSecret(secretBase32: string): {
  ciphertext: string;
  nonce: string;
  tag: string;
} {
  const key = getTotpEncryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(secretBase32, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptTotpSecret(
  ciphertext: string,
  nonce: string,
  tag: string,
): string {
  const key = getTotpEncryptionKey();
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TotpConfigurationError();
  }
}
