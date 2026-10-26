import assert from "node:assert/strict";
import test from "node:test";
import { PresenceRegistry } from "../src/server/realtime/presence.ts";

test("presence roster tracks connections per user, not per stream", () => {
  const registry = new PresenceRegistry();
  const org = "org-1";
  const project = "project-1";

  assert.deepEqual(registry.snapshot(org, project), []);
  assert.equal(registry.version(org, project), 0);

  // First join creates the row and bumps the version.
  const joined = registry.join(org, project, "user-a", "Alice");
  assert.equal(joined.version, 1);
  assert.deepEqual(joined.members, [{ userId: "user-a", displayName: "Alice" }]);

  // A second connection from the same user adds no row and no bump.
  const rejoined = registry.join(org, project, "user-a", "Alice");
  assert.equal(rejoined.version, 1);
  assert.equal(rejoined.members.length, 1);

  // A second user joins; the roster sorts by display name.
  registry.join(org, project, "user-b", "Aaron");
  assert.deepEqual(
    registry.snapshot(org, project).map((member) => member.displayName),
    ["Aaron", "Alice"],
  );

  // Leaving one of two connections changes nothing visible.
  const partial = registry.leave(org, project, "user-a");
  assert.ok(partial);
  assert.equal(partial.version, 2);
  assert.equal(partial.members.length, 2);

  // The last connection leaving removes the row and bumps again.
  const left = registry.leave(org, project, "user-a");
  assert.ok(left);
  assert.equal(left.version, 3);
  assert.deepEqual(
    left.members.map((member) => member.displayName),
    ["Aaron"],
  );

  // Leaving a user who was never present changes nothing.
  assert.equal(registry.leave(org, project, "user-missing"), null);
  assert.equal(registry.version(org, project), 3);

  // Projects are independent registries.
  assert.deepEqual(registry.snapshot(org, "other-project"), []);
});

test("presence display names update on rejoin", () => {
  const registry = new PresenceRegistry();
  registry.join("org-1", "project-1", "user-a", "Alice");
  registry.join("org-1", "project-1", "user-a", "Alice Smith");
  assert.deepEqual(registry.snapshot("org-1", "project-1"), [
    { userId: "user-a", displayName: "Alice Smith" },
  ]);
});
