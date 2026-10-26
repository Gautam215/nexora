import assert from "node:assert/strict";
import { test } from "node:test";
import { planReplay } from "../src/server/realtime/events.ts";

// The replay decision is pure so its boundaries are pinned without a
// database: fresh clients go live-only, returning clients replay up
// to the window, and clients further behind get a resync signal.
test("realtime replay plan: fresh, replay, and resync boundaries", () => {
  assert.deepEqual(planReplay(0, null, 200), { mode: "live", fromVersion: 0 });
  assert.deepEqual(planReplay(5, null, 200), { mode: "live", fromVersion: 5 });
  assert.deepEqual(planReplay(5, 5, 200), { mode: "live", fromVersion: 5 });
  assert.deepEqual(planReplay(5, 9, 200), { mode: "live", fromVersion: 5 });
  assert.deepEqual(planReplay(10, 9, 200), { mode: "replay", fromVersion: 9 });
  assert.deepEqual(planReplay(210, 10, 200), { mode: "replay", fromVersion: 10 });
  assert.deepEqual(planReplay(211, 10, 200), { mode: "resync", fromVersion: 211 });
  assert.deepEqual(planReplay(1000, 0, 200), { mode: "resync", fromVersion: 1000 });
});
