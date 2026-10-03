import assert from "node:assert/strict";
import test from "node:test";
import { taskCreateSchema, taskUpdateSchema } from "../src/security/task-schemas.ts";
import {
  taskBulkUpdateSchema,
  taskWorkflowUpdateSchema,
} from "../src/security/task-workflow-schemas.ts";

const firstId = "e0b120d8-982d-4e0e-a670-969a7ab8a316";
const secondId = "f5c533ae-7a2a-4e67-9e3b-1800a13bfb71";

test("task creation validates bounded details and normalized labels", () => {
  const parsed = taskCreateSchema.safeParse({
    title: "  Prepare release notes  ",
    description: "  Draft the customer-facing update. ",
    priority: "high",
    labels: [" Release ", "Customer-visible"],
    dueDate: "2026-10-21",
    estimatedEffortHours: 2.5,
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.title, "Prepare release notes");
    assert.equal(parsed.data.description, "Draft the customer-facing update.");
    assert.deepEqual(parsed.data.labels, ["Release", "Customer-visible"]);
  }

  assert.equal(taskCreateSchema.safeParse({ title: "" }).success, false);
  assert.equal(taskCreateSchema.safeParse({ title: "Task", dueDate: "2026-02-30" }).success, false);
  assert.equal(taskCreateSchema.safeParse({ title: "Task", priority: "critical" }).success, false);
  assert.equal(taskCreateSchema.safeParse({ title: "Task", labels: ["Build", " build "] }).success, false);
  assert.equal(taskCreateSchema.safeParse({ title: "Task", dependencies: [firstId, firstId] }).success, false);
  assert.equal(taskCreateSchema.safeParse({ title: "Task", dependencies: [firstId, firstId.toUpperCase()] }).success, false);
  assert.equal(taskCreateSchema.safeParse({ title: "Task", extra: true }).success, false);
});

test("task updates are partial but always compare an expected version", () => {
  assert.equal(taskUpdateSchema.safeParse({ expectedVersion: 1 }).success, false);
  assert.equal(taskUpdateSchema.safeParse({ expectedVersion: 1, statusId: firstId }).success, true);
  assert.equal(taskUpdateSchema.safeParse({ expectedVersion: 1, position: 0 }).success, true);
  assert.equal(taskUpdateSchema.safeParse({ expectedVersion: 1, estimatedEffortHours: -1 }).success, false);
});

test("workflows require one completion column and unique names", () => {
  assert.equal(taskWorkflowUpdateSchema.safeParse({
    expectedVersion: 1,
    statuses: [
      { id: firstId, name: "Backlog", isDone: false },
      { id: secondId, name: "Done", isDone: true },
    ],
  }).success, true);
  assert.equal(taskWorkflowUpdateSchema.safeParse({
    expectedVersion: 1,
    statuses: [
      { id: firstId, name: "Backlog", isDone: false },
      { id: firstId.toUpperCase(), name: "Review", isDone: false },
      { id: secondId, name: "Done", isDone: true },
    ],
  }).success, false);
  assert.equal(taskWorkflowUpdateSchema.safeParse({
    expectedVersion: 1,
    statuses: [
      { name: "Backlog", isDone: false },
      { name: "In progress", isDone: false },
    ],
  }).success, false);
  assert.equal(taskWorkflowUpdateSchema.safeParse({
    expectedVersion: 1,
    statuses: [
      { name: "Review", isDone: false },
      { name: " review ", isDone: true },
    ],
  }).success, false);
});

test("bulk task changes require distinct versioned tasks and one priority", () => {
  assert.equal(taskBulkUpdateSchema.safeParse({
    tasks: [{ id: firstId, expectedVersion: 2 }, { id: secondId, expectedVersion: 1 }],
    priority: "urgent",
  }).success, true);
  assert.equal(taskBulkUpdateSchema.safeParse({
    tasks: [{ id: firstId, expectedVersion: 1 }, { id: firstId.toUpperCase(), expectedVersion: 2 }],
    priority: "low",
  }).success, false);
});
