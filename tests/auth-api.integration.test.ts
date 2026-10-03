import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as logout } from "../src/app/api/auth/logout/route.ts";
import { GET as getSession } from "../src/app/api/auth/session/route.ts";
import {
  GET as listOrganizations,
  POST as createOrganization,
} from "../src/app/api/organizations/route.ts";
import { hashPassword } from "../src/security/password.ts";
import { createOpaqueToken, hashOpaqueToken } from "../src/security/tokens.ts";
import {
  closeDatabasePool,
  withOrganizationContext,
  withUserContext,
} from "../src/server/db.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;

after(async () => {
  await closeDatabasePool();
});

test(
  "login establishes a revocable session and workspace creation is atomic and tenant-scoped",
  { skip: !connectionString },
  async () => {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    const password = "correct horse battery staple";
    const passwordHash = await hashPassword(password);
    const client = new Client({ connectionString });
    await client.connect();

    try {
      await withUserContext(userId, async (transaction) => {
        await transaction.query(
          `INSERT INTO nexora.users (id, email, display_name, password_hash)
           VALUES ($1, $2, 'Integration Test', $3)`,
          [userId, email, passwordHash],
        );
      });

      const verificationToken = createOpaqueToken();
      const verificationHash = hashOpaqueToken(verificationToken);
      assert.ok(verificationHash);
      await client.query(
        `SELECT nexora.issue_email_verification($1, $2, $3, $4)`,
        [email, randomUUID(), verificationHash, new Date(Date.now() + 60 * 60 * 1000)],
      );
      await client.query("SELECT nexora.consume_email_verification($1)", [verificationHash]);

      const crossOrigin = await login(
        new NextRequest(`${origin}/api/auth/login`, {
          method: "POST",
          headers: {
            origin: "https://attacker.example",
            "content-type": "application/json",
          },
          body: JSON.stringify({ email, password }),
        }),
      );
      assert.equal(crossOrigin.status, 403);

      const invalidLogin = await login(
        new NextRequest(`${origin}/api/auth/login`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email, password: "wrong password" }),
        }),
      );
      assert.equal(invalidLogin.status, 401);

      const loginResponse = await login(
        new NextRequest(`${origin}/api/auth/login`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        }),
      );
      assert.equal(loginResponse.status, 200);
      const setCookie = loginResponse.headers.get("set-cookie");
      assert.ok(setCookie);
      const sessionToken = setCookie.match(/nexora_session=([^;]+)/)?.[1];
      assert.ok(sessionToken);
      assert.doesNotMatch(await loginResponse.text(), /password_hash|correct horse/);

      const cookieHeader = `nexora_session=${sessionToken}`;
      const sessionResponse = await getSession(
        new NextRequest(`${origin}/api/auth/session`, {
          headers: { cookie: cookieHeader },
        }),
      );
      assert.equal(sessionResponse.status, 200);
      const sessionBody = (await sessionResponse.json()) as {
        data: { user: { id: string; email: string } };
      };
      assert.equal(sessionBody.data.user.id, userId);
      assert.equal(sessionBody.data.user.email, email);

      const createResponse = await createOrganization(
        new NextRequest(`${origin}/api/organizations`, {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Studio North", slug: `studio-${userId.slice(0, 8)}` }),
        }),
      );
      assert.equal(createResponse.status, 201);
      const createdBody = (await createResponse.json()) as {
        data: { organization: { id: string; slug: string } };
      };
      const organizationId = createdBody.data.organization.id;
      assert.equal(createdBody.data.organization.slug, `studio-${userId.slice(0, 8)}`);

      const conflictResponse = await createOrganization(
        new NextRequest(`${origin}/api/organizations`, {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Another Studio", slug: `studio-${userId.slice(0, 8)}` }),
        }),
      );
      assert.equal(conflictResponse.status, 409);

      const organizationsResponse = await listOrganizations(
        new NextRequest(`${origin}/api/organizations`, {
          headers: { cookie: cookieHeader },
        }),
      );
      assert.equal(organizationsResponse.status, 200);
      const organizationsBody = (await organizationsResponse.json()) as {
        data: { organizations: Array<{ id: string; role: string }> };
      };
      assert.deepEqual(
        organizationsBody.data.organizations.map(({ id, role }) => ({ id, role })),
        [{ id: organizationId, role: "owner" }],
      );

      const auditAction = await withOrganizationContext(
        userId,
        organizationId,
        async (transaction) => {
          const result = await transaction.query<{ action: string }>(
            `SELECT action FROM nexora.audit_events
             WHERE organization_id = $1 AND target_id = $2`,
            [organizationId, organizationId],
          );
          return result.rows[0]?.action;
        },
      );
      assert.equal(auditAction, "organization.created");

      const logoutResponse = await logout(
        new NextRequest(`${origin}/api/auth/logout`, {
          method: "POST",
          headers: { origin, cookie: cookieHeader },
        }),
      );
      assert.equal(logoutResponse.status, 200);
      const afterLogout = await getSession(
        new NextRequest(`${origin}/api/auth/session`, {
          headers: { cookie: cookieHeader },
        }),
      );
      assert.equal(afterLogout.status, 401);
    } finally {
      await client.end();
    }
  },
);
