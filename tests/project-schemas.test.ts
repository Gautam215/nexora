import assert from "node:assert/strict";
import test from "node:test";
import {
  projectCreateSchema,
  projectMemberCreateSchema,
  projectUpdateSchema,
} from "../src/security/project-schemas.ts";

test("project create validates bounded fields and date ordering", () => {
  const valid = projectCreateSchema.safeParse({
    name: "  Release planning  ",
    description: "  Prepare the next release. ",
    startDate: "2026-10-01",
    targetDate: "2026-10-31",
  });
  assert.equal(valid.success, true);
  if (valid.success) {
    assert.equal(valid.data.name, "Release planning");
    assert.equal(valid.data.description, "Prepare the next release.");
  }

  assert.equal(projectCreateSchema.safeParse({ name: "", startDate: null, targetDate: null }).success, false);
  assert.equal(projectCreateSchema.safeParse({ name: "Project", startDate: "2026-02-30" }).success, false);
  assert.equal(
    projectCreateSchema.safeParse({ name: "Project", startDate: "2026-10-30", targetDate: "2026-10-01" }).success,
    false,
  );
  assert.equal(projectCreateSchema.safeParse({ name: "Project", unexpected: true }).success, false);
});

test("project updates require an expected version and at least one change", () => {
  assert.equal(projectUpdateSchema.safeParse({ expectedVersion: 1 }).success, false);
  assert.equal(projectUpdateSchema.safeParse({ expectedVersion: 1, status: "unknown" }).success, false);
  assert.equal(projectUpdateSchema.safeParse({ expectedVersion: 1, name: "New name" }).success, true);
});

test("project access roles exclude organization-owner escalation", () => {
  assert.equal(
    projectMemberCreateSchema.safeParse({
      userId: "e0b120d8-982d-4e0e-a670-969a7ab8a316",
      role: "manager",
    }).success,
    true,
  );
  assert.equal(
    projectMemberCreateSchema.safeParse({
      userId: "e0b120d8-982d-4e0e-a670-969a7ab8a316",
      role: "owner",
    }).success,
    false,
  );
});
