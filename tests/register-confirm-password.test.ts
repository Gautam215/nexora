import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Regression test for the "new ID is not being created" report
// (2026-10-27): the register form previously had no confirm-password
// field, so a mistyped password silently created an account the user
// could never sign into, and the success message never said sign-in
// is blocked until the email is confirmed. These are static checks
// in the same style as tests/accessibility.test.ts — there is no
// component test harness in this repo — and they guard the two
// properties that matter: a mismatch is rejected before any fetch,
// and the register form renders a confirm field.

test("register rejects a mismatched password before submitting", async () => {
  const source = await readFile(
    path.join(process.cwd(), "src", "app", "components", "auth-page.tsx"),
    "utf8",
  );
  const registerEndpoint = source.indexOf('endpoint = "/api/auth/register"');
  assert.ok(registerEndpoint > 0, "register endpoint assignment not found");
  const mismatchCheck = source.indexOf('if (password !== confirmPassword)');
  assert.ok(mismatchCheck > 0, "password-mismatch check not found");
  assert.ok(
    mismatchCheck < registerEndpoint,
    "mismatch check must run before the register request is built",
  );
  assert.ok(
    source.includes('setError("The passwords do not match.")'),
    "mismatch must surface an error to the user",
  );
});

test("register renders a confirm-password field", async () => {
  const source = await readFile(
    path.join(process.cwd(), "src", "app", "components", "auth-page.tsx"),
    "utf8",
  );
  assert.ok(
    source.includes('(mode === "register" || mode === "reset-password")'),
    "confirm field must render for register as well as reset-password",
  );
});

test("register success message says sign-in waits on email confirmation", async () => {
  const source = await readFile(
    path.join(process.cwd(), "src", "app", "components", "auth-page.tsx"),
    "utf8",
  );
  assert.ok(
    source.includes("You must confirm your email before you can sign in."),
    "register success message must state that sign-in is blocked until confirmation",
  );
});
