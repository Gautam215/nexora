import assert from "node:assert/strict";
import test from "node:test";
import { calculateCompletionPercent, calculateProjectHealth } from "../src/security/project-analytics.ts";

test("completion percentages use counts and preserve the no-data state", () => {
  assert.equal(calculateCompletionPercent(0, 0), null);
  assert.equal(calculateCompletionPercent(1, 3), 33);
  assert.equal(calculateCompletionPercent(2, 3), 67);
  assert.equal(calculateCompletionPercent(5, 3), 100);
  assert.equal(calculateCompletionPercent(-1, 3), null);
});

test("project health is a deterministic snapshot of status and dated risks", () => {
  const base = {
    projectStatus: "active" as const,
    targetDate: "2026-10-10",
    asOfDate: "2026-10-03",
    overdueTasks: 0,
    overdueMilestones: 0,
  };

  assert.deepEqual(calculateProjectHealth(base), {
    status: "on_track",
    reason: "No overdue work; the project target date has not passed.",
  });
  assert.equal(calculateProjectHealth({ ...base, overdueTasks: 2 }).status, "at_risk");
  assert.equal(calculateProjectHealth({ ...base, overdueMilestones: 1 }).status, "at_risk");
  assert.equal(calculateProjectHealth({ ...base, targetDate: "2026-10-02" }).status, "at_risk");
  assert.equal(calculateProjectHealth({ ...base, targetDate: null }).status, "no_target_date");
  assert.equal(calculateProjectHealth({ ...base, projectStatus: "planned" }).status, "planned");
  assert.equal(calculateProjectHealth({ ...base, projectStatus: "planned", targetDate: null }).status, "no_target_date");
  assert.equal(calculateProjectHealth({ ...base, projectStatus: "on_hold" }).status, "on_hold");
  assert.equal(calculateProjectHealth({ ...base, projectStatus: "on_hold", targetDate: null }).status, "on_hold");
  assert.equal(calculateProjectHealth({ ...base, projectStatus: "completed", overdueTasks: 1 }).status, "completed");
  assert.equal(calculateProjectHealth({ ...base, projectStatus: "archived" }).status, "archived");
});
