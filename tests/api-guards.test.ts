import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import test from "node:test";
import { AiProviderError } from "../src/server/ai/provider.ts";
import { emailSchema } from "../src/security/auth-schemas.ts";
import { hasSameOrigin, jsonOk, jsonServerFailure, logRouteFailure, parseJson } from "../src/server/api.ts";

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

test("mutation origin check allows loopback HTTP in production but not remote HTTP", () => {
  runtimeEnvironment.NODE_ENV = "production";

  const loopbackOrigin = "http://localhost:3100";
  process.env.APP_ORIGIN = loopbackOrigin;
  const loopbackSame = new NextRequest(`${loopbackOrigin}/api/auth/login`, {
    method: "POST",
    headers: { origin: loopbackOrigin, "sec-fetch-site": "same-origin" },
  });
  const loopbackMismatch = new NextRequest(`${loopbackOrigin}/api/auth/login`, {
    method: "POST",
    headers: { origin: "http://localhost:9999", "sec-fetch-site": "same-origin" },
  });
  assert.equal(hasSameOrigin(loopbackSame), true);
  assert.equal(hasSameOrigin(loopbackMismatch), false);

  const remoteOrigin = "http://nexora.example.test";
  process.env.APP_ORIGIN = remoteOrigin;
  const remoteHttp = new NextRequest(`${remoteOrigin}/api/auth/login`, {
    method: "POST",
    headers: { origin: remoteOrigin, "sec-fetch-site": "same-origin" },
  });
  assert.equal(hasSameOrigin(remoteHttp), false);
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

test("failure logs carry timestamp, severity, and service fields", async () => {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const request = new NextRequest(`${origin}/api`, {
      headers: { "x-request-id": "test-request-log-01" },
    });
    const response = jsonServerFailure(request, "test.log-shape", new Error("boom"));
    assert.equal(response.status, 500);
    const dbRequest = new NextRequest(`${origin}/api`, {
      headers: { "x-request-id": "test-request-log-02" },
    });
    const dbResponse = jsonServerFailure(dbRequest, "test.log-shape", {
      code: "23505",
      message: "duplicate key",
    });
    assert.equal(dbResponse.status, 500);
  } finally {
    console.error = originalError;
  }

  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(first.event, "api.request_failed");
  assert.equal(first.operation, "test.log-shape");
  assert.equal(first.requestId, "test-request-log-01");
  assert.equal(first.errorName, "Error");
  assert.equal(first.severity, "error");
  assert.equal(first.service, "nexora-api");
  assert.match(
    String(first.timestamp),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  assert.equal(Number.isNaN(Date.parse(String(first.timestamp))), false);
  assert.equal("errorCode" in first, false);
  const second = JSON.parse(lines[1] as string) as Record<string, unknown>;
  assert.equal(second.errorCode, "23505");
  assert.equal(second.requestId, "test-request-log-02");
});

test("failure logs carry AI provider error codes", async () => {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const request = new NextRequest(`${origin}/api`, {
      headers: { "x-request-id": "test-request-log-ai" },
    });
    const response = jsonServerFailure(
      request,
      "test.log-ai-code",
      new AiProviderError("INVALID_OUTPUT"),
    );
    assert.equal(response.status, 500);
  } finally {
    console.error = originalError;
  }

  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(logged.event, "api.request_failed");
  assert.equal(logged.operation, "test.log-ai-code");
  assert.equal(logged.requestId, "test-request-log-ai");
  assert.equal(logged.errorName, "AiProviderError");
  // Previously the 12-character code bound dropped every AI provider
  // code (longest 20 chars), so ai.risk failures logged no sub-code.
  assert.equal(logged.errorCode, "INVALID_OUTPUT");
});

test("failure logs carry structured details without overriding core fields", async () => {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const request = new NextRequest(`${origin}/api`, {
      headers: { "x-request-id": "test-request-log-details" },
    });
    logRouteFailure(request, "test.log-details", new AiProviderError("INVALID_OUTPUT"), {
      schemaIssues: ["risks.0.severity"],
      errorCode: ["spoofed"],
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(logged.operation, "test.log-details");
  assert.equal(logged.requestId, "test-request-log-details");
  assert.equal(logged.errorName, "AiProviderError");
  // Core fields win over colliding detail keys.
  assert.equal(logged.errorCode, "INVALID_OUTPUT");
  assert.deepEqual(logged.schemaIssues, ["risks.0.severity"]);
});
