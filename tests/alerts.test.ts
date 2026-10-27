import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateDatabaseDownAlert,
  evaluateServerErrorAlert,
  parseAlertThreshold,
} from "../src/server/alerts.ts";

test("server-error alert fires only on a new threshold crossing", () => {
  assert.equal(evaluateServerErrorAlert(9, 10, 0).triggered, false);
  assert.equal(evaluateServerErrorAlert(10, 10, 0).triggered, true);
  // Same crossing again must not re-alert.
  assert.equal(evaluateServerErrorAlert(15, 10, 10).triggered, false);
  assert.equal(evaluateServerErrorAlert(20, 10, 10).triggered, true);
});

test("database-down alert is rate-limited to once an hour", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  assert.equal(
    evaluateDatabaseDownAlert(false, null, now).triggered,
    true,
  );
  assert.equal(
    evaluateDatabaseDownAlert(false, new Date("2026-10-27T11:30:00Z"), now).triggered,
    false,
  );
  assert.equal(
    evaluateDatabaseDownAlert(false, new Date("2026-10-27T10:59:00Z"), now).triggered,
    true,
  );
  assert.equal(evaluateDatabaseDownAlert(true, null, now).triggered, false);
});

test("invalid alert threshold falls back to 10", () => {
  assert.equal(parseAlertThreshold(undefined), 10);
  assert.equal(parseAlertThreshold("25"), 25);
  assert.equal(parseAlertThreshold("0"), 10);
  assert.equal(parseAlertThreshold("nope"), 10);
});
