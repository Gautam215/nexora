import assert from "node:assert/strict";
import test from "node:test";
import {
  loginSchema,
  organizationCreateSchema,
  registerSchema,
} from "../src/security/auth-schemas.ts";

test("auth schemas normalize addresses without changing passwords", () => {
  const parsed = registerSchema.safeParse({
    name: "  Morgan Lee  ",
    email: "  MORGAN@EXAMPLE.TEST ",
    password: "  twelve chars  ",
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.name, "Morgan Lee");
    assert.equal(parsed.data.email, "morgan@example.test");
    assert.equal(parsed.data.password, "  twelve chars  ");
  }
});

test("registration enforces code-point password bounds and rejects unknown fields", () => {
  const base = { name: "Morgan", email: "morgan@example.test" };
  assert.equal(registerSchema.safeParse({ ...base, password: "short" }).success, false);
  assert.equal(registerSchema.safeParse({ ...base, password: "x".repeat(129) }).success, false);
  assert.equal(registerSchema.safeParse({ ...base, password: "x".repeat(12), admin: true }).success, false);
  assert.equal(registerSchema.safeParse({ ...base, password: "🔒".repeat(12) }).success, true);
});

test("login permits legacy short passwords for verification but caps input size", () => {
  assert.equal(
    loginSchema.safeParse({ email: "morgan@example.test", password: "old" }).success,
    true,
  );
  assert.equal(
    loginSchema.safeParse({ email: "morgan@example.test", password: "x".repeat(129) }).success,
    false,
  );
});

test("workspace slugs normalize to lowercase and enforce URL-safe syntax", () => {
  const parsed = organizationCreateSchema.safeParse({ name: "Studio", slug: "  Night-Shift  " });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.slug, "night-shift");
  assert.equal(organizationCreateSchema.safeParse({ name: "Studio", slug: "bad--slug" }).success, false);
});
