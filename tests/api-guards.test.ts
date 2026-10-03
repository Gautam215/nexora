import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import test from "node:test";
import { emailSchema } from "../src/security/auth-schemas.ts";
import { hasSameOrigin, jsonOk, jsonServerFailure, parseJson } from "../src/server/api.ts";

const origin = "https://nexora.example.test";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;

test("mutation origin check rejects cross-site and untrusted origins", () => {
  process.env.APP_ORIGIN = origin;
  runtimeEnvironment.NODE_ENV = "production";

  const sameOrigin = new NextRequest(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin, "sec-fetch-site": "same-origin" },
  });
  const crossSite = new NextRequest(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  });
  const unmarked = new NextRequest(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin: "null" },
  });

  assert.equal(hasSameOrigin(sameOrigin), true);
  assert.equal(hasSameOrigin(crossSite), false);
  assert.equal(hasSameOrigin(unmarked), false);
});

test("request parser bounds JSON, validates its media type, and reports safe errors", async () => {
  runtimeEnvironment.NODE_ENV = "test";
  const valid = new NextRequest(`${origin}/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.test" }),
  });
  const parsed = await parseJson(valid, emailSchema);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.email, "a@example.test");

  const wrongType = new NextRequest(`${origin}/api`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "email=a@example.test",
  });
  const rejectedType = await parseJson(wrongType, emailSchema);
  assert.equal(rejectedType.ok, false);
  if (!rejectedType.ok) assert.equal(rejectedType.status, 415);

  const oversized = new NextRequest(`${origin}/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.test", extra: "x".repeat(17_000) }),
  });
  const rejectedSize = await parseJson(oversized, emailSchema);
  assert.equal(rejectedSize.ok, false);
  if (!rejectedSize.ok) assert.equal(rejectedSize.status, 413);
});

test("response body and header share a stable request identifier", async () => {
  runtimeEnvironment.NODE_ENV = "test";
  const request = new NextRequest(`${origin}/api`, {
    headers: { "x-request-id": "test-request-01" },
  });
  const response = jsonOk(request, { ok: true });
  const body = (await response.json()) as { requestId: string };

  assert.equal(response.headers.get("x-request-id"), "test-request-01");
  assert.equal(body.requestId, "test-request-01");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("serialization conflicts return a safe conflict response", async () => {
  runtimeEnvironment.NODE_ENV = "test";
  const request = new NextRequest(`${origin}/api`);
  const response = jsonServerFailure(request, "test.update", {
    code: "40001",
    message: "database detail must not be returned",
  });
  const body = (await response.json()) as { error: { code: string; message: string } };

  assert.equal(response.status, 409);
  assert.equal(body.error.code, "CONCURRENT_UPDATE");
  assert.doesNotMatch(body.error.message, /database detail/);
});
