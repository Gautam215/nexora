import assert from "node:assert/strict";
import test from "node:test";
import { createOpaqueToken, hashOpaqueToken } from "../src/security/tokens.ts";

test("opaque tokens are high entropy and stored only as hashes", () => {
  const token = createOpaqueToken();
  const hash = hashOpaqueToken(token);

  assert.equal(token.length, 43);
  assert.match(hash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(hashOpaqueToken(token), hash);
  assert.notEqual(hash, token);
});

test("malformed or non-canonical tokens are rejected", () => {
  assert.equal(hashOpaqueToken(null), null);
  assert.equal(hashOpaqueToken("too-short"), null);
  assert.equal(hashOpaqueToken(`${"A".repeat(42)}B`), null);
});
