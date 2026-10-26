import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import test from "node:test";
import { POST as changePassword } from "../src/app/api/auth/password-change/route.ts";
import { GET as listSessions } from "../src/app/api/auth/sessions/route.ts";
import { createOpaqueToken } from "../src/security/tokens.ts";

const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
// A closed local port: no database is listening here, so every pool
// query fails. This file runs in its own process, so setting
// DATABASE_URL here cannot leak into the other test files.
runtimeEnvironment.DATABASE_URL = "postgresql://nexora_app:invalid@localhost:59999/nexora_test";
runtimeEnvironment.NODE_ENV = "test";
runtimeEnvironment.APP_ORIGIN = "http://localhost:3000";

function request(route: string, method: string, body?: unknown): NextRequest {
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: `nexora_session=${createOpaqueToken()}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("database failure during authentication returns a safe 500, not database detail", async () => {
  const listed = await listSessions(request("/api/auth/sessions", "GET"));
  const listedBody = (await listed.json()) as { error: { code: string; message: string } };
  assert.equal(listed.status, 500);
  assert.equal(listedBody.error.code, "INTERNAL_ERROR");
  assert.ok(!listedBody.error.message.includes("5432"));
  assert.ok(!listedBody.error.message.includes("nexora"));

  const changed = await changePassword(
    request("/api/auth/password-change", "POST", {
      currentPassword: "correct horse battery staple",
      newPassword: "correct horse battery staple 2",
    }),
  );
  const changedBody = (await changed.json()) as { error: { code: string; message: string } };
  assert.equal(changed.status, 500);
  assert.equal(changedBody.error.code, "INTERNAL_ERROR");
});
