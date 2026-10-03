import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, PasswordPolicyError, verifyPassword } from "../src/security/password.ts";

test("password hashes are salted and only verify the matching password", async () => {
  const password = "correct horse battery staple";
  const first = await hashPassword(password);
  const second = await hashPassword(password);

  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("different password", first), false);
});

test("invalid and unsupported hashes fail closed after comparable work", async () => {
  assert.equal(await verifyPassword("some password", null), false);
  assert.equal(await verifyPassword("some password", "scrypt$99$invalid"), false);
});

test("password policy rejects short and overlong values", async () => {
  await assert.rejects(hashPassword("short"), PasswordPolicyError);
  await assert.rejects(hashPassword("x".repeat(129)), PasswordPolicyError);
});
