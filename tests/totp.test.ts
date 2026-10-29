import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { totpCode as totpCodeSchema } from "../src/security/auth-schemas.ts";
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  TotpConfigurationError,
  totpCode,
  totpSetupUrl,
  verifyTotpCode,
} from "../src/security/totp.ts";

// RFC 6238 test secret: the ASCII string "12345678901234567890".
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("totp: base32 round-trips and matches the RFC 6238 secret", () => {
  assert.equal(base32Encode(Buffer.from("12345678901234567890", "ascii")), RFC_SECRET);
  assert.deepEqual(
    [...base32Decode(RFC_SECRET)],
    [...Buffer.from("12345678901234567890", "ascii")],
  );
  const secret = generateTotpSecret();
  assert.equal(base32Decode(secret).length, 20);
  assert.throws(() => base32Decode("not!base32"));
});

test("totp: RFC 6238 vectors verify, with one step of clock skew", () => {
  // RFC 6238 8-digit vectors are 94287082 and 07081804; the
  // 6-digit codes are their last six digits.
  assert.equal(totpCode(RFC_SECRET, 59_000), "287082");
  assert.equal(totpCode(RFC_SECRET, 1_111_111_109_000), "081804");
  // Same step, previous step, and next step all verify.
  assert.equal(verifyTotpCode(RFC_SECRET, "287082", 59_000), true);
  assert.equal(verifyTotpCode(RFC_SECRET, "287082", 29_000), true);
  assert.equal(verifyTotpCode(RFC_SECRET, "287082", 89_000), true);
  // Two steps away does not.
  assert.equal(verifyTotpCode(RFC_SECRET, "287082", 119_000), false);
  assert.equal(verifyTotpCode(RFC_SECRET, "287082", 59_000), true);
  // Malformed codes never verify.
  assert.equal(verifyTotpCode(RFC_SECRET, "28708", 59_000), false);
  assert.equal(verifyTotpCode(RFC_SECRET, "2870821", 59_000), false);
  assert.equal(verifyTotpCode(RFC_SECRET, "abcdef", 59_000), false);
});

test("totp: encrypted secrets round-trip and bad keys fail closed", () => {
  const key = randomBytes(32).toString("hex");
  process.env.NEXORA_TOTP_ENCRYPTION_KEY = key;
  const encrypted = encryptTotpSecret(RFC_SECRET);
  assert.equal(decryptTotpSecret(encrypted.ciphertext, encrypted.nonce, encrypted.tag), RFC_SECRET);
  process.env.NEXORA_TOTP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  assert.throws(
    () => decryptTotpSecret(encrypted.ciphertext, encrypted.nonce, encrypted.tag),
    TotpConfigurationError,
  );
  delete process.env.NEXORA_TOTP_ENCRYPTION_KEY;
  assert.throws(() => encryptTotpSecret(RFC_SECRET), TotpConfigurationError);
  assert.throws(() => decryptTotpSecret(encrypted.ciphertext, encrypted.nonce, encrypted.tag), TotpConfigurationError);
});

test("totp: setup URL carries the secret and issuer, code schema is six digits", () => {
  const url = totpSetupUrl(RFC_SECRET, "owner@example.test");
  assert.ok(url.startsWith("otpauth://totp/Nexora:owner%40example.test"));
  assert.ok(url.includes(`secret=${RFC_SECRET}`));
  assert.ok(url.includes("issuer=Nexora"));
  assert.equal(totpCodeSchema.safeParse("123456").success, true);
  assert.equal(totpCodeSchema.safeParse("12345").success, false);
  assert.equal(totpCodeSchema.safeParse("1234567").success, false);
  assert.equal(totpCodeSchema.safeParse("abcdef").success, false);
});
