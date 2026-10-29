import assert from "node:assert/strict";
import test from "node:test";
import {
  changePasswordSchema,
  loginSchema,
  organizationCreateSchema,
  organizationDeleteSchema,
  organizationUpdateSchema,
  registerSchema,
  sessionRevokeSchema,
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

test("password change requires the full new-password policy but accepts a legacy current password", () => {
  const base = { currentPassword: "old", newPassword: "new password here" };
  assert.equal(changePasswordSchema.safeParse(base).success, true);
  assert.equal(
    changePasswordSchema.safeParse({ ...base, newPassword: "short" }).success,
    false,
  );
  assert.equal(
    changePasswordSchema.safeParse({ ...base, newPassword: "x".repeat(129) }).success,
    false,
  );
  assert.equal(
    changePasswordSchema.safeParse({ ...base, extra: true }).success,
    false,
  );
});

test("session revoke requires a UUID session identifier", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(sessionRevokeSchema.safeParse({ sessionId: id }).success, true);
  assert.equal(sessionRevokeSchema.safeParse({ sessionId: "not-a-uuid" }).success, false);
  assert.equal(sessionRevokeSchema.safeParse({}).success, false);
});

test("workspace slugs normalize to lowercase and enforce URL-safe syntax", () => {
  const parsed = organizationCreateSchema.safeParse({ name: "Studio", slug: "  Night-Shift  " });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.slug, "night-shift");
  assert.equal(organizationCreateSchema.safeParse({ name: "Studio", slug: "bad--slug" }).success, false);
});

test("workspace settings accept a partial update with the creation rules", () => {
  const nameOnly = organizationUpdateSchema.safeParse({ name: "  New Studio  " });
  assert.equal(nameOnly.success, true);
  if (nameOnly.success) assert.equal(nameOnly.data.name, "New Studio");
  const slugOnly = organizationUpdateSchema.safeParse({ slug: "  New-Slug  " });
  assert.equal(slugOnly.success, true);
  if (slugOnly.success) assert.equal(slugOnly.data.slug, "new-slug");
  assert.equal(organizationUpdateSchema.safeParse({}).success, false);
  assert.equal(organizationUpdateSchema.safeParse({ name: "" }).success, false);
  assert.equal(organizationUpdateSchema.safeParse({ slug: "bad--slug" }).success, false);
  assert.equal(organizationUpdateSchema.safeParse({ name: "Studio", status: "archived" }).success, false);
});

test("workspace deletion requires the exact current slug", () => {
  const parsed = organizationDeleteSchema.safeParse({ slug: "  My-Workspace  ", password: "owner-password-one" });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.slug, "my-workspace");
  assert.equal(organizationDeleteSchema.safeParse({}).success, false);
  assert.equal(organizationDeleteSchema.safeParse({ slug: "bad--slug", password: "owner-password-one" }).success, false);
  assert.equal(organizationDeleteSchema.safeParse({ slug: "ok-slug", name: "Extra", password: "owner-password-one" }).success, false);
  // Password re-entry (2026-10-28 security round) is required, not optional.
  assert.equal(organizationDeleteSchema.safeParse({ slug: "ok-slug" }).success, false);
});
