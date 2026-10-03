import assert from "node:assert/strict";
import test from "node:test";
import { safeReturnPath } from "../src/security/return-path.ts";

test("safe return paths preserve same-origin destinations", () => {
  assert.equal(
    safeReturnPath("/accept-invitation?source=email#continue"),
    "/accept-invitation?source=email#continue",
  );
});

test("safe return paths reject external, malformed, and oversized values", () => {
  for (const value of [
    "https://attacker.example",
    "//attacker.example/path",
    "/\\attacker.example/path",
    "\\\\attacker.example/path",
    "/bad\u0000path",
    "x".repeat(2049),
    ["/accept-invitation"],
  ]) {
    assert.equal(safeReturnPath(value), null);
  }
});
