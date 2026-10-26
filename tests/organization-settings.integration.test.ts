import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as register } from "../src/app/api/auth/register/route.ts";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as consumeVerification } from "../src/app/api/auth/verification/consume/route.ts";
import { POST as createOrganization } from "../src/app/api/organizations/route.ts";
import {
  GET as getOrganization,
  PATCH as updateOrganization,
} from "../src/app/api/organizations/[organizationId]/route.ts";
import { POST as createOrganizationInvitation } from "../src/app/api/organizations/[organizationId]/members/route.ts";
import { POST as acceptInvitation } from "../src/app/api/invitations/accept/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import { startSmtpCaptureServer, type SmtpCapture } from "./smtp-server.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const migratorConnectionString = process.env.NEXORA_TEST_MIGRATOR_DATABASE_URL;
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

function apiRequest(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
): NextRequest {
  const headers = new Headers();
  if (method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function tokenFromMessage(message: string, pathname: string): string {
  const decoded = message.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  const token = decoded.match(new RegExp(`${pathname}\\?token=([A-Za-z0-9_-]+)`))?.[1];
  assert.ok(token, `expected ${pathname} token in captured email`);
  return token;
}

async function registerVerifyAndLogin(email: string, name: string, password: string) {
  const registered = await register(
    apiRequest("/api/auth/register", "POST", { name, email, password }),
  );
  assert.equal(registered.status, 202);
  const verificationToken = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/verify-email");
  const verified = await consumeVerification(
    apiRequest("/api/auth/verification/consume", "POST", { token: verificationToken }),
  );
  assert.equal(verified.status, 200);
  const loginResponse = await login(
    apiRequest("/api/auth/login", "POST", { email, password }),
  );
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie")?.match(/nexora_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const result = (await loginResponse.json()) as { data: { user: { id: string } } };
  return { userId: result.data.user.id, cookie: `nexora_session=${cookie}`, email };
}

async function createWorkspace(cookie: string, slug: string) {
  const response = await createOrganization(
    apiRequest("/api/organizations", "POST", { name: "Settings Workspace", slug }, cookie),
  );
  assert.equal(response.status, 201);
  const result = (await response.json()) as { data: { organization: { id: string } } };
  return result.data.organization.id;
}

async function inviteAndAccept(
  cookie: string,
  organizationId: string,
  email: string,
  role: string,
  userCookie: string,
) {
  const response = await createOrganizationInvitation(
    apiRequest(
      `/api/organizations/${organizationId}/members`,
      "POST",
      { email, role },
      cookie,
    ),
    { params: Promise.resolve({ organizationId }) },
  );
  assert.equal(response.status, 201);
  const token = tokenFromMessage(smtp?.messages.at(-1) ?? "", "/accept-invitation");
  const accepted = await acceptInvitation(
    apiRequest("/api/invitations/accept", "POST", { token }, userCookie),
  );
  assert.equal(accepted.status, 200);
}

async function updateOrganizationAs(
  cookie: string,
  organizationId: string,
  body: unknown,
) {
  return updateOrganization(
    apiRequest(`/api/organizations/${organizationId}`, "PATCH", body, cookie),
    { params: Promise.resolve({ organizationId }) },
  );
}

async function migratorQueryAs<T>(
  userId: string,
  organizationId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  assert.ok(migratorConnectionString, "migrator connection required for this check");
  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_catalog.set_config('nexora.user_id', $1, true), pg_catalog.set_config('nexora.organization_id', $2, true)",
      [userId, organizationId],
    );
    const result = await client.query(sql, params as never[]);
    await client.query("ROLLBACK");
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

test(
  "organization settings update name and slug with audit and role checks",
  { skip: !connectionString },
  async (t) => {
    smtp = await startSmtpCaptureServer();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_FROM = "noreply@nexora.example.test";

    const owner = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Settings Owner",
      "settings owner password",
    );
    const organizationId = await createWorkspace(owner.cookie, `settings-${owner.userId.slice(0, 8)}`);
    const admin = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Settings Admin",
      "settings admin password",
    );
    await inviteAndAccept(owner.cookie, organizationId, admin.email, "admin", admin.cookie);
    const member = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Settings Member",
      "settings member password",
    );
    await inviteAndAccept(owner.cookie, organizationId, member.email, "member", member.cookie);
    const outsider = await registerVerifyAndLogin(
      `${randomUUID()}@example.test`,
      "Settings Outsider",
      "settings outsider password",
    );

    await t.test("owner can rename and admin can change the slug", async () => {
      const renamed = await updateOrganizationAs(owner.cookie, organizationId, {
        name: "Renamed Workspace",
      });
      assert.equal(renamed.status, 200);
      const renamedBody = (await renamed.json()) as {
        data: { organization: { name: string; slug: string } };
      };
      assert.equal(renamedBody.data.organization.name, "Renamed Workspace");
      assert.equal(renamedBody.data.organization.slug, `settings-${owner.userId.slice(0, 8)}`);

      const reslugged = await updateOrganizationAs(admin.cookie, organizationId, {
        slug: `renamed-${owner.userId.slice(0, 8)}`,
      });
      assert.equal(reslugged.status, 200);
      const resluggedBody = (await reslugged.json()) as {
        data: { organization: { name: string; slug: string } };
      };
      assert.equal(resluggedBody.data.organization.slug, `renamed-${owner.userId.slice(0, 8)}`);
      assert.equal(resluggedBody.data.organization.name, "Renamed Workspace");

      const fetched = await getOrganization(
        apiRequest(`/api/organizations/${organizationId}`, "GET", undefined, owner.cookie),
        { params: Promise.resolve({ organizationId }) },
      );
      assert.equal(fetched.status, 200);
      const fetchedBody = (await fetched.json()) as {
        data: { organization: { name: string; slug: string } };
      };
      assert.equal(fetchedBody.data.organization.name, "Renamed Workspace");
      assert.equal(fetchedBody.data.organization.slug, `renamed-${owner.userId.slice(0, 8)}`);
    });

    await t.test(
      "settings changes are audited with previous and new values",
      { skip: !migratorConnectionString },
      async () => {
        const audits = await migratorQueryAs<{ action: string; details: unknown }>(
          owner.userId,
          organizationId,
          `SELECT action, details FROM nexora.audit_events
           WHERE organization_id = $1 AND action = 'organization.updated'
           ORDER BY created_at`,
          [organizationId],
        );
        assert.equal(audits.length, 2);
        const first = audits[0]?.details as { changedFields: string[]; previousName: string; name: string };
        assert.deepEqual(first.changedFields, ["name"]);
        assert.equal(first.previousName, "Settings Workspace");
        assert.equal(first.name, "Renamed Workspace");
        const second = audits[1]?.details as { changedFields: string[]; previousSlug: string; slug: string };
        assert.deepEqual(second.changedFields, ["slug"]);
        assert.equal(second.slug, `renamed-${owner.userId.slice(0, 8)}`);
      },
    );

    await t.test("members cannot change settings and outsiders see no workspace", async () => {
      const memberResponse = await updateOrganizationAs(member.cookie, organizationId, {
        name: "Member Rename",
      });
      assert.equal(memberResponse.status, 403);
      const memberBody = (await memberResponse.json()) as { error: { code: string } };
      assert.equal(memberBody.error.code, "ORGANIZATION_MANAGEMENT_REQUIRED");

      const outsiderResponse = await updateOrganizationAs(outsider.cookie, organizationId, {
        name: "Outsider Rename",
      });
      assert.equal(outsiderResponse.status, 403);
      const outsiderBody = (await outsiderResponse.json()) as { error: { code: string } };
      assert.equal(outsiderBody.error.code, "ORGANIZATION_ACCESS_DENIED");
    });

    await t.test("settings validation rejects empty, malformed, and unknown fields", async () => {
      for (const body of [{}, { name: "" }, { slug: "bad--slug" }, { name: "X", status: "archived" }]) {
        const response = await updateOrganizationAs(owner.cookie, organizationId, body);
        assert.equal(response.status, 400);
      }
    });

    await t.test("a taken slug conflicts and a no-op save writes no audit row", async () => {
      await createWorkspace(owner.cookie, `other-${owner.userId.slice(0, 8)}`);
      const conflict = await updateOrganizationAs(owner.cookie, organizationId, {
        slug: `other-${owner.userId.slice(0, 8)}`,
      });
      assert.equal(conflict.status, 409);
      const conflictBody = (await conflict.json()) as { error: { code: string } };
      assert.equal(conflictBody.error.code, "SLUG_TAKEN");

      const noop = await updateOrganizationAs(owner.cookie, organizationId, {
        name: "Renamed Workspace",
        slug: `renamed-${owner.userId.slice(0, 8)}`,
      });
      assert.equal(noop.status, 200);
    });

    await t.test(
      "the no-op save leaves the audit count unchanged",
      { skip: !migratorConnectionString },
      async () => {
        const audits = await migratorQueryAs<{ count: string }>(
          owner.userId,
          organizationId,
          `SELECT count(*)::text AS count FROM nexora.audit_events
           WHERE organization_id = $1 AND action = 'organization.updated'`,
          [organizationId],
        );
        assert.equal(audits[0]?.count, "2");
      },
    );

    await t.test("a malformed organization id is denied, not leaked", async () => {
      const response = await updateOrganizationAs(owner.cookie, "not-a-uuid", {
        name: "Nope",
      });
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "ORGANIZATION_ACCESS_DENIED");
    });
  },
);
