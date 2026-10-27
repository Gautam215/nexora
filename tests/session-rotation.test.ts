import assert from "node:assert/strict";
import test from "node:test";
import {
  organizationRoleRank,
  shouldRevokeSessionsOnOrganizationChange,
  shouldRevokeSessionsOnProjectChange,
} from "../src/server/auth.ts";

// Approved default (2026-10-26): no periodic rotation. Revocation
// happens on privilege downgrade / disable, because those are the
// security-sensitive changes; a session token alone never grants a
// role, so a project role-only change is enforced on every request
// without revoking every session.

test("organization role ranks order owner above admin above member above guest", () => {
  assert.ok(organizationRoleRank("owner") > organizationRoleRank("admin"));
  assert.ok(organizationRoleRank("admin") > organizationRoleRank("member"));
  assert.ok(organizationRoleRank("member") > organizationRoleRank("guest"));
  assert.equal(organizationRoleRank("unknown"), 0);
});

test("organization downgrade and disable revoke, promotion and re-enable do not", () => {
  assert.equal(
    shouldRevokeSessionsOnOrganizationChange(
      { role: "admin", status: "active" },
      { role: "member", status: "active" },
    ),
    true,
  );
  assert.equal(
    shouldRevokeSessionsOnOrganizationChange(
      { role: "member", status: "active" },
      { role: "guest", status: "active" },
    ),
    true,
  );
  assert.equal(
    shouldRevokeSessionsOnOrganizationChange(
      { role: "member", status: "active" },
      { role: "member", status: "disabled" },
    ),
    true,
  );
  assert.equal(
    shouldRevokeSessionsOnOrganizationChange(
      { role: "member", status: "active" },
      { role: "admin", status: "active" },
    ),
    false,
  );
  assert.equal(
    shouldRevokeSessionsOnOrganizationChange(
      { role: "member", status: "disabled" },
      { role: "member", status: "active" },
    ),
    false,
  );
  assert.equal(
    shouldRevokeSessionsOnOrganizationChange(
      { role: "member", status: "active" },
      { role: "member", status: "active" },
    ),
    false,
  );
});

test("project revocation happens only on disable, not on role-only change", () => {
  assert.equal(shouldRevokeSessionsOnProjectChange({ status: "disabled" }), true);
  assert.equal(shouldRevokeSessionsOnProjectChange({ status: "active" }), false);
});
