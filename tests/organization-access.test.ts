import assert from "node:assert/strict";
import test from "node:test";
import { canAccessOrganization } from "../src/security/organization-access.ts";

const activeOwner = {
  userId: "user-a",
  organizationId: "org-a",
  role: "owner",
  status: "active",
};

test("allows an active member only in the matched organization", () => {
  assert.equal(canAccessOrganization(activeOwner, "user-a", "org-a"), true);
  assert.equal(canAccessOrganization(activeOwner, "user-a", "org-b"), false);
  assert.equal(canAccessOrganization(activeOwner, "user-b", "org-a"), false);
});

test("denies missing, invited, and disabled memberships", () => {
  assert.equal(canAccessOrganization(null, "user-a", "org-a"), false);
  assert.equal(
    canAccessOrganization({ ...activeOwner, status: "invited" }, "user-a", "org-a"),
    false,
  );
  assert.equal(
    canAccessOrganization({ ...activeOwner, status: "disabled" }, "user-a", "org-a"),
    false,
  );
});

test("applies the server-side minimum role hierarchy", () => {
  const member = { ...activeOwner, role: "member" };
  assert.equal(canAccessOrganization(member, "user-a", "org-a", "member"), true);
  assert.equal(canAccessOrganization(member, "user-a", "org-a", "admin"), false);
  assert.equal(canAccessOrganization(member, "user-a", "org-a", "owner"), false);
});

test("fails closed for an unknown role", () => {
  const invalid = { ...activeOwner, role: "superadmin" };
  assert.equal(canAccessOrganization(invalid, "user-a", "org-a"), false);
});
