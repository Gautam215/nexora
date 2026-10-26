import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client } from "pg";
import { POST as login } from "../src/app/api/auth/login/route.ts";
import { POST as changePassword } from "../src/app/api/auth/password-change/route.ts";
import { GET as listSessions } from "../src/app/api/auth/sessions/route.ts";
import { POST as revokeSession } from "../src/app/api/auth/sessions/revoke/route.ts";
import { POST as revokeOtherSessions } from "../src/app/api/auth/sessions/revoke-others/route.ts";
import { hashPassword } from "../src/security/password.ts";
import { createOpaqueToken, hashOpaqueToken } from "../src/security/tokens.ts";
import { closeDatabasePool, withUserContext } from "../src/server/db.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
delete process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER;

const oldPassword = "correct horse battery staple";
const newPassword = "correct horse battery staple 2";

after(async () => {
  await closeDatabasePool();
});

function request(
  route: string,
  method: string,
  token: string | undefined,
  body?: unknown,
): NextRequest {
  const headers: Record<string, string> = { origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.cookie = `nexora_session=${token}`;
  return new NextRequest(`${origin}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sessionToken(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /nexora_session=([^;]+)/.exec(setCookie);
  assert.ok(match, `expected a session cookie, got: ${setCookie}`);
  return match[1];
}

async function createVerifiedUser(email: string, password: string): Promise<string> {
  const userId = randomUUID();
  const passwordHash = await hashPassword(password);
  await withUserContext(userId, async (transaction) => {
    await transaction.query(
      `INSERT INTO nexora.users (id, email, display_name, password_hash)
       VALUES ($1, $2, 'Session Test', $3)`,
      [userId, email, passwordHash],
    );
  });
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const token = createOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    assert.ok(tokenHash);
    await client.query("SELECT nexora.issue_email_verification($1, $2, $3, $4)", [
      email,
      randomUUID(),
      tokenHash,
      new Date(Date.now() + 60 * 60 * 1000),
    ]);
    await client.query("SELECT nexora.consume_email_verification($1)", [tokenHash]);
  } finally {
    await client.end();
  }
  return userId;
}

async function loginAs(email: string, password: string): Promise<string> {
  const response = await login(
    request("/api/auth/login", "POST", undefined, { email, password }),
  );
  assert.equal(response.status, 200, await response.text().then((t) => t));
  return sessionToken(response);
}

async function listAs(token: string) {
  const response = await listSessions(request("/api/auth/sessions", "GET", token));
  const body = (await response.json()) as {
    data?: { sessions: Array<{ id: string; current: boolean }> };
    error?: { code: string };
  };
  return { response, body };
}

test(
  "unauthenticated password change and session management are rejected",
  { skip: !connectionString },
  async () => {
    const changed = await changePassword(
      request("/api/auth/password-change", "POST", undefined, {
        currentPassword: oldPassword,
        newPassword,
      }),
    );
    assert.equal(changed.status, 401);

    const listed = await listSessions(request("/api/auth/sessions", "GET", undefined));
    assert.equal(listed.status, 401);

    const revoked = await revokeSession(
      request("/api/auth/sessions/revoke", "POST", undefined, {
        sessionId: randomUUID(),
      }),
    );
    assert.equal(revoked.status, 401);

    const revokedOthers = await revokeOtherSessions(
      request("/api/auth/sessions/revoke-others", "POST", undefined),
    );
    assert.equal(revokedOthers.status, 401);
  },
);

test(
  "password change rejects a wrong current password and an invalid new password, and keeps the old password working",
  { skip: !connectionString },
  async () => {
    const email = `${randomUUID()}@example.test`;
    await createVerifiedUser(email, oldPassword);
    const token = await loginAs(email, oldPassword);

    const wrong = await changePassword(
      request("/api/auth/password-change", "POST", token, {
        currentPassword: "wrong password here",
        newPassword,
      }),
    );
    const wrongBody = (await wrong.json()) as { error: { code: string } };
    assert.equal(wrong.status, 401);
    assert.equal(wrongBody.error.code, "INVALID_CREDENTIALS");

    const invalid = await changePassword(
      request("/api/auth/password-change", "POST", token, {
        currentPassword: oldPassword,
        newPassword: "short",
      }),
    );
    assert.equal(invalid.status, 400);

    const same = await changePassword(
      request("/api/auth/password-change", "POST", token, {
        currentPassword: oldPassword,
        newPassword: oldPassword,
      }),
    );
    const sameBody = (await same.json()) as { error: { code: string } };
    assert.equal(same.status, 400);
    assert.equal(sameBody.error.code, "PASSWORD_UNCHANGED");

    // The old password still logs in: no failed attempt changed it.
    await loginAs(email, oldPassword);
  },
);

test(
  "password change revokes other sessions, keeps the current one, and swaps the password",
  { skip: !connectionString },
  async () => {
    const email = `${randomUUID()}@example.test`;
    await createVerifiedUser(email, oldPassword);
    const current = await loginAs(email, oldPassword);
    const other = await loginAs(email, oldPassword);

    const { response: listedResponse, body: listedBody } = await listAs(current);
    assert.equal(listedResponse.status, 200);
    assert.equal(listedBody.data?.sessions.length, 2);
    assert.equal(listedBody.data?.sessions.filter((s) => s.current).length, 1);
    assert.ok(!listedBody.data?.sessions.some((s) => "token_hash" in s));

    const changed = await changePassword(
      request("/api/auth/password-change", "POST", current, {
        currentPassword: oldPassword,
        newPassword,
      }),
    );
    const changedBody = (await changed.json()) as {
      data: { passwordUpdated: boolean; otherSessionsRevoked: number };
    };
    assert.equal(changed.status, 200);
    assert.equal(changedBody.data.passwordUpdated, true);
    assert.equal(changedBody.data.otherSessionsRevoked, 1);

    // The other session is dead; the current session still works.
    const dead = await listAs(other);
    assert.equal(dead.response.status, 401);
    const alive = await listAs(current);
    assert.equal(alive.response.status, 200);

    // The old password is dead; the new password works.
    const oldLogin = await login(request("/api/auth/login", "POST", undefined, { email, password: oldPassword }));
    assert.equal(oldLogin.status, 401);
    await loginAs(email, newPassword);
  },
);

test(
  "session management lists, revokes one, revokes others, and never crosses users",
  { skip: !connectionString },
  async () => {
    const email = `${randomUUID()}@example.test`;
    const otherEmail = `${randomUUID()}@example.test`;
    await createVerifiedUser(email, oldPassword);
    await createVerifiedUser(otherEmail, oldPassword);
    const current = await loginAs(email, oldPassword);
    const secondToken = await loginAs(email, oldPassword);
    const thirdToken = await loginAs(email, oldPassword);
    const otherUserToken = await loginAs(otherEmail, oldPassword);

    const { body: before } = await listAs(current);
    const ids = before.data?.sessions.map((s) => s.id) ?? [];
    assert.equal(ids.length, 3);
    // Revocation takes session IDs, not tokens: take the two non-current
    // IDs from the listing, and keep their tokens to prove they die.
    const otherIds = (before.data?.sessions ?? []).filter((s) => !s.current).map((s) => s.id);
    assert.equal(otherIds.length, 2);
    const [second] = otherIds;

    // Revoking another user's session is indistinguishable from not found,
    // and the other user's session keeps working.
    const otherUserSessions = await listAs(otherUserToken);
    const otherSessionId = otherUserSessions.body.data?.sessions[0]?.id;
    assert.ok(otherSessionId);
    const cross = await revokeSession(
      request("/api/auth/sessions/revoke", "POST", current, { sessionId: otherSessionId }),
    );
    assert.equal(cross.status, 404);
    const otherStillAlive = await listAs(otherUserToken);
    assert.equal(otherStillAlive.response.status, 200);

    // Revoke one own session, then revoking it again is a 404.
    const revoked = await revokeSession(
      request("/api/auth/sessions/revoke", "POST", current, { sessionId: second }),
    );
    const revokedBody = (await revoked.json()) as { data: { revoked: boolean; currentRevoked: boolean } };
    assert.equal(revoked.status, 200);
    assert.equal(revokedBody.data.revoked, true);
    assert.equal(revokedBody.data.currentRevoked, false);
    // The listing, not a token, proves the revocation: the API does not
    // expose which token maps to which session ID, so a token check
    // here would be guessing at ordering. After revoke-others below,
    // both other tokens are checked dead.
    const afterOneRevoke = await listAs(current);
    assert.equal(afterOneRevoke.body.data?.sessions.length, 2);
    assert.ok(!afterOneRevoke.body.data?.sessions.some((s) => s.id === second));
    const again = await revokeSession(
      request("/api/auth/sessions/revoke", "POST", current, { sessionId: second }),
    );
    assert.equal(again.status, 404);

    // Revoke all others: only the current session remains.
    const revokedOthers = await revokeOtherSessions(
      request("/api/auth/sessions/revoke-others", "POST", current),
    );
    const revokedOthersBody = (await revokedOthers.json()) as {
      data: { otherSessionsRevoked: number };
    };
    assert.equal(revokedOthers.status, 200);
    assert.equal(revokedOthersBody.data.otherSessionsRevoked, 1);
    const after = await listAs(current);
    assert.equal(after.body.data?.sessions.length, 1);
    assert.equal(after.body.data?.sessions[0]?.current, true);
    const secondDead = await listAs(secondToken);
    assert.equal(secondDead.response.status, 401);
    const thirdDead = await listAs(thirdToken);
    assert.equal(thirdDead.response.status, 401);
  },
);

test(
  "expired sessions are not listed and cannot be revoked, and revoking the current session clears its cookie",
  { skip: !connectionString },
  async () => {
    const email = `${randomUUID()}@example.test`;
    const userId = await createVerifiedUser(email, oldPassword);
    const current = await loginAs(email, oldPassword);

    // An already-expired session: created two hours ago, expired one hour ago.
    // The runtime role cannot insert created_at/last_seen_at (its INSERT
    // grant is id, user_id, token_hash, expires_at only), so this fixture
    // uses the migrator connection when it is available, and is skipped
    // otherwise — it is a fixture limitation, not a product behaviour.
    const migratorConnectionString = process.env.NEXORA_TEST_MIGRATOR_DATABASE_URL;
    if (migratorConnectionString) {
      const expiredId = randomUUID();
      const migrator = new Client({ connectionString: migratorConnectionString });
      await migrator.connect();
      try {
        await migrator.query(
          `INSERT INTO nexora.user_sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
           VALUES ($1, $2, $3, pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour')`,
          [expiredId, userId, randomBytes(32).toString("hex")],
        );
      } finally {
        await migrator.end();
      }
      const { body: listedExpired } = await listAs(current);
      assert.ok(!listedExpired.data?.sessions.some((s) => s.id === expiredId));
      const revokeExpired = await revokeSession(
        request("/api/auth/sessions/revoke", "POST", current, { sessionId: expiredId }),
      );
      assert.equal(revokeExpired.status, 404);
    }

    // Revoking the current session clears its cookie and kills it.
    const { body: listed } = await listAs(current);
    const currentId = listed.data?.sessions.find((s) => s.current)?.id;
    assert.ok(currentId);
    const revokedCurrent = await revokeSession(
      request("/api/auth/sessions/revoke", "POST", current, { sessionId: currentId }),
    );
    const revokedCurrentBody = (await revokedCurrent.json()) as {
      data: { revoked: boolean; currentRevoked: boolean };
    };
    assert.equal(revokedCurrent.status, 200);
    assert.equal(revokedCurrentBody.data.currentRevoked, true);
    assert.match(revokedCurrent.headers.get("set-cookie") ?? "", /nexora_session=;/);
    const dead = await listAs(current);
    assert.equal(dead.response.status, 401);
  },
);
