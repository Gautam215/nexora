import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import { POST as createProject } from "../src/app/api/organizations/[organizationId]/projects/route.ts";
import {
  GET as listMilestones,
  POST as createMilestone,
} from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/route.ts";
import { PATCH as updateMilestone } from "../src/app/api/organizations/[organizationId]/projects/[projectId]/milestones/[milestoneId]/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

// Regression for the 2026-10-28 production failure: every milestone
// status PATCH returned 500 with Postgres 42712 because production's
// guard_milestone_task_consistency() joined milestones to itself
// under one alias. Migration 0062 restores the 0008 definition.
// This test also pins the date shape the edit form needs: DATE
// columns must arrive as YYYY-MM-DD strings, not timestamps, or
// <input type="date"> renders them blank.

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;
let smtp: SmtpCapture | undefined;

after(async () => {
  await smtp?.close();
  await closeDatabasePool();
});

function apiRequest(path: string, method = "GET", body?: unknown, cookie?: string, extraHeaders?: Record<string, string>): NextRequest {
  const headers = new Headers(extraHeaders);
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function tokenFromMessage(message: string, pathname: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(new RegExp(`${pathname}\\?token=([A-Za-z0-9_-]+)`))?.[1];
  assert.ok(token, `expected ${pathname} token`);
  return token;
}

test("milestone status PATCH succeeds and dates arrive as YYYY-MM-DD", async () => {
  smtp = await startSmtpCaptureServer();
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURE = "false";
  process.env.SMTP_REQUIRE_TLS = "false";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASSWORD = "";
  process.env.SMTP_FROM = "noreply@nexora.example.test";
  const email = `ms-regression-${randomBytes(4).toString("hex")}@example.test`;
  const registered = await register(apiRequest("/api/auth/register", "POST", { name: "Probe", email, password: "ProbePass123!" }));
  assert.equal(registered.status, 202);
  const verified = await consumeVerification(apiRequest("/api/auth/verification/consume", "POST", { token: tokenFromMessage(smtp.messages.at(-1) ?? "", "/verify-email") }));
  assert.equal(verified.status, 200);
  const loginResponse = await login(apiRequest("/api/auth/login", "POST", { email, password: "ProbePass123!" }));
  assert.equal(loginResponse.status, 200);
  const cookie = `nexora_session=${loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1]}`;
  const orgResponse = await createOrganization(apiRequest("/api/organizations", "POST", { name: "Probe Org", slug: `probe-org-${randomBytes(4).toString("hex")}` }, cookie));
  assert.equal(orgResponse.status, 201);
  const orgId = ((await orgResponse.json()) as { data: { organization: { id: string } } }).data.organization.id;
  const projResponse = await createProject(apiRequest(`/api/organizations/${orgId}/projects`, "POST", { name: "Probe Project" }, cookie), { params: Promise.resolve({ organizationId: orgId }) });
  assert.equal(projResponse.status, 201);
  const projectId = ((await projResponse.json()) as { data: { project: { id: string } } }).data.project.id;
  const msResponse = await createMilestone(apiRequest(`/api/organizations/${orgId}/projects/${projectId}/milestones`, "POST", { name: "Probe Milestone Alpha", endDate: "2026-11-15", dependencies: [] }, cookie, { "idempotency-key": `probe-${randomBytes(4).toString("hex")}` }), { params: Promise.resolve({ organizationId: orgId, projectId }) });
  assert.equal(msResponse.status, 201);
  const milestone = ((await msResponse.json()) as { data: { milestone: { id: string; version: number } } }).data.milestone;
  const listResponse = await listMilestones(apiRequest(`/api/organizations/${orgId}/projects/${projectId}/milestones`, "GET", undefined, cookie), { params: Promise.resolve({ organizationId: orgId, projectId }) });
  const listed = ((await listResponse.json()) as { data: { milestones: Array<{ id: string; version: number; end_date: string | null; status: string }> } }).data.milestones[0];
  assert.match(listed.end_date ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(listed.end_date, "2026-11-15");
  const params = { params: Promise.resolve({ organizationId: orgId, projectId, milestoneId: milestone.id }) };
  const editPatch = await updateMilestone(apiRequest(`/api/organizations/${orgId}/projects/${projectId}/milestones/${milestone.id}`, "PATCH", { expectedVersion: listed.version, name: "Probe Milestone Alpha Updated", description: null, startDate: null, endDate: "2026-11-20", status: "active", dependencies: [] }, cookie), params);
  assert.equal(editPatch.status, 200);
  const updated = ((await editPatch.json()) as { data: { milestone: { version: number; status: string; end_date: string } } }).data.milestone;
  assert.equal(updated.status, "active");
  assert.equal(updated.version, listed.version + 1);
  assert.equal(updated.end_date, "2026-11-20");
});
