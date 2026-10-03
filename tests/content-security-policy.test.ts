import assert from "node:assert/strict";
import test from "node:test";
import { buildContentSecurityPolicy } from "../src/security/content-security-policy.ts";

test("production CSP uses the request nonce and denies unsafe inline code", () => {
  const policy = buildContentSecurityPolicy("test-nonce");

  assert.match(policy, /script-src 'self' 'nonce-test-nonce' 'strict-dynamic'/);
  assert.match(policy, /style-src 'self' 'nonce-test-nonce'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'self'/);
  assert.match(policy, /form-action 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
  assert.doesNotMatch(policy, /'unsafe-inline'/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
});

test("development CSP permits Next.js eval without allowing inline scripts", () => {
  const policy = buildContentSecurityPolicy("dev-nonce", true);

  assert.match(policy, /'nonce-dev-nonce'/);
  assert.match(policy, /'unsafe-eval'/);
  assert.match(policy, /connect-src 'self' ws: wss:/);
  assert.doesNotMatch(policy, /'unsafe-inline'/);
  assert.doesNotMatch(policy, /upgrade-insecure-requests/);
});
