import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Client, type QueryResultRow } from "pg";
import { POST as startSignIn } from "../src/app/api/auth/oauth/google/start/route.ts";
import { POST as startLink } from "../src/app/api/auth/oauth/google/link/start/route.ts";
import { GET as callback } from "../src/app/api/auth/oauth/google/callback/route.ts";
import { createSession } from "../src/server/auth.ts";
import { closeDatabasePool } from "../src/server/db.ts";
import { createFlowValue, newFlow, verifyFlowValue } from "../src/server/oauth/flow.ts";
import { hashPassword } from "../src/security/password.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const migratorConnectionString = process.env.NEXORA_TEST_MIGRATOR_DATABASE_URL;
const origin = "http://localhost:3000";
const runtimeEnvironment = process.env as unknown as Record<string, string | undefined>;
if (connectionString) process.env.DATABASE_URL = connectionString;
runtimeEnvironment.NODE_ENV = "test";
process.env.APP_ORIGIN = origin;
process.env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
process.env.NEXORA_TRUSTED_CLIENT_IP_HEADER = "x-test-client-ip";

const CLIENT_ID = "test-client-id";
const SIGNING_KEY = "test-oauth-flow-signing-key-32-bytes!!";
const SESSION_COOKIE = "nexora_session";
const FLOW_COOKIE = "nexora_oauth_flow";

// ---- Mock IdP (token + JWKS endpoints; the authorize URL is only
// built, never fetched, so it needs no handler) ----
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = "mock-kid-1";

interface MockState {
  idToken: string | null;
  tokenError: boolean;
  usedCodes: Set<string>;
}
const mockState: MockState = { idToken: null, tokenError: false, usedCodes: new Set() };

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mockIdToken(claims: Record<string, unknown>): string {
  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const input = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function mockClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: now + 3600,
    iat: now,
    nonce: "placeholder-nonce",
    email_verified: true,
    sub: "mock-sub-1",
    email: "oauth-new@example.test",
    name: "OAuth New",
    ...overrides,
  };
}

let mockServer: Server | undefined;
let mockBase = "";

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

before(async () => {
  mockServer = createServer(async (request, response) => {
    if (request.url?.startsWith("/token") && request.method === "POST") {
      const body = new URLSearchParams(await readBody(request));
      const code = body.get("code") ?? "";
      if (mockState.tokenError || mockState.usedCodes.has(code) || !mockState.idToken) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      mockState.usedCodes.add(code);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id_token: mockState.idToken, access_token: "discarded" }));
      return;
    }
    if (request.url?.startsWith("/jwks")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [{ kid: KID, kty: "RSA", n: jwk.n, e: jwk.e }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => mockServer?.listen(0, "127.0.0.1", resolve));
  const address = mockServer?.address();
  const port = typeof address === "object" && address ? address.port : 0;
  mockBase = `http://127.0.0.1:${port}`;
  process.env.OAUTH_GOOGLE_ENABLED = "true";
  process.env.OAUTH_GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.OAUTH_FLOW_SIGNING_KEY = SIGNING_KEY;
  process.env.OAUTH_GOOGLE_AUTHORIZE_URL = `${mockBase}/authorize`;
  process.env.OAUTH_GOOGLE_TOKEN_URL = `${mockBase}/token`;
  process.env.OAUTH_GOOGLE_JWKS_URL = `${mockBase}/jwks`;
});

after(async () => {
  await new Promise<void>((resolve) => mockServer?.close(() => resolve()));
  await closeDatabasePool();
});

// ---- Request helpers ----

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.200.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

function apiRequest(
  path: string,
  method: string,
  opts: { body?: unknown; cookies?: string[]; ip?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (method !== "GET") headers.set("origin", origin);
  headers.set("x-test-client-ip", opts.ip ?? freshIp());
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookies?.length) headers.set("cookie", opts.cookies.join("; "));
  return new NextRequest(`${origin}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

function setCookies(response: Response): string[] {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw.map((cookie) => cookie.split(";")[0] ?? "");
}

function cookieValue(cookies: string[], name: string): string | null {
  for (const cookie of cookies) {
    if (cookie.startsWith(`${name}=`)) return cookie.slice(name.length + 1);
  }
  return null;
}

function locationOf(response: Response): string {
  return response.headers.get("location") ?? "";
}

async function migratorClient(): Promise<Client> {
  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  return client;
}

async function createFixtureUser(
  email: string,
  overrides: { status?: string; verified?: boolean } = {},
): Promise<string> {
  const client = await migratorClient();
  try {
    const id = randomUUID();
    const passwordHash = await hashPassword("correct horse battery staple");
    await client.query(
      `INSERT INTO nexora.users (id, email, display_name, password_hash, status, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        email,
        "Fixture User",
        passwordHash,
        overrides.status ?? "active",
        overrides.verified === false ? null : new Date(),
      ],
    );
    return id;
  } finally {
    await client.end();
  }
}

async function createFixtureIdentity(userId: string, subject: string, email: string): Promise<void> {
  const client = await migratorClient();
  try {
    await client.query(
      `INSERT INTO nexora.oauth_identities (id, user_id, provider, provider_subject, provider_email)
       VALUES ($1, $2, 'google', $3, $4)`,
      [randomUUID(), userId, subject, email],
    );
  } finally {
    await client.end();
  }
}

async function queryOne<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T | null> {
  const client = await migratorClient();
  try {
    const result = await client.query<T>(sql, params as never[]);
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const row = await queryOne<{ count: string }>(sql, params);
  return Number(row?.count ?? 0);
}

interface StartedFlow {
  flowCookie: string;
  state: string;
  nonce: string;
  verifier: string;
}

async function startSignInFlow(next?: string, ip?: string): Promise<{ response: Response; flow: StartedFlow }> {
  const response = await startSignIn(
    apiRequest("/api/auth/oauth/google/start", "POST", { body: next ? { next } : {}, ip }),
  );
  const cookies = setCookies(response);
  const flowCookie = cookieValue(cookies, FLOW_COOKIE);
  assert.ok(flowCookie, "start sets a flow cookie");
  const verified = verifyFlowValue(flowCookie, SIGNING_KEY);
  assert.equal(verified.status, "ok");
  if (verified.status !== "ok") throw new Error("unreachable");
  return {
    response,
    flow: {
      flowCookie: `${FLOW_COOKIE}=${flowCookie}`,
      state: verified.payload.state,
      nonce: verified.payload.nonce,
      verifier: verified.payload.verifier,
    },
  };
}

async function startLinkFlow(sessionCookie: string, ip?: string): Promise<{ response: Response; flow: StartedFlow }> {
  const response = await startLink(
    apiRequest("/api/auth/oauth/google/link/start", "POST", { cookies: [sessionCookie], ip }),
  );
  const cookies = setCookies(response);
  const flowCookie = cookieValue(cookies, FLOW_COOKIE);
  assert.ok(flowCookie, "link start sets a flow cookie");
  const verified = verifyFlowValue(flowCookie, SIGNING_KEY);
  assert.equal(verified.status, "ok");
  if (verified.status !== "ok") throw new Error("unreachable");
  return {
    response,
    flow: {
      flowCookie: `${FLOW_COOKIE}=${flowCookie}`,
      state: verified.payload.state,
      nonce: verified.payload.nonce,
      verifier: verified.payload.verifier,
    },
  };
}

function callbackRequest(
  flow: StartedFlow,
  extra: Record<string, string> = {},
  sessionCookie?: string,
  ip?: string,
): NextRequest {
  const params = new URLSearchParams({ code: `code-${randomUUID()}`, state: flow.state, ...extra });
  const cookies = [flow.flowCookie];
  if (sessionCookie) cookies.push(sessionCookie);
  return apiRequest(`/api/auth/oauth/google/callback?${params}`, "GET", { cookies, ip });
}

function sessionCookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

// ---- Tests ----

test(
  "flag off makes both start and callback return 404",
  { skip: !connectionString },
  async () => {
    const previous = process.env.OAUTH_GOOGLE_ENABLED;
    process.env.OAUTH_GOOGLE_ENABLED = "false";
    try {
      const start = await startSignIn(apiRequest("/api/auth/oauth/google/start", "POST", { body: {} }));
      assert.equal(start.status, 404);
      const cb = await callback(apiRequest("/api/auth/oauth/google/callback?code=x&state=y", "GET"));
      assert.equal(cb.status, 404);
    } finally {
      process.env.OAUTH_GOOGLE_ENABLED = previous;
    }
  },
);

test(
  "enabled with missing credentials fails closed: start 503, callback generic error",
  { skip: !connectionString },
  async () => {
    const previousSecret = process.env.OAUTH_GOOGLE_CLIENT_SECRET;
    delete process.env.OAUTH_GOOGLE_CLIENT_SECRET;
    try {
      const start = await startSignIn(apiRequest("/api/auth/oauth/google/start", "POST", { body: {} }));
      assert.equal(start.status, 503);
      const cb = await callback(apiRequest("/api/auth/oauth/google/callback?code=x&state=y", "GET"));
      assert.equal(cb.status, 302);
      assert.equal(locationOf(cb), "/login?error=oauth_failed");
      assert.ok(!locationOf(cb).includes(mockBase), "never redirects to the provider");
    } finally {
      process.env.OAUTH_GOOGLE_CLIENT_SECRET = previousSecret;
    }
  },
);

test(
  "start redirects to the provider with S256 challenge, state, and nonce, plus a scoped flow cookie",
  { skip: !connectionString },
  async () => {
    const { response, flow } = await startSignInFlow();
    assert.equal(response.status, 302);
    const location = new URL(locationOf(response));
    assert.equal(`${location.origin}${location.pathname}`, `${mockBase}/authorize`);
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(location.searchParams.get("redirect_uri"), `${origin}/api/auth/oauth/google/callback`);
    assert.equal(location.searchParams.get("scope"), "openid email profile");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.equal(location.searchParams.get("state"), flow.state);
    assert.equal(location.searchParams.get("nonce"), flow.nonce);
    const { createHash } = await import("node:crypto");
    assert.equal(
      location.searchParams.get("code_challenge"),
      createHash("sha256").update(flow.verifier).digest("base64url"),
    );
    const rawCookies = response.headers.getSetCookie?.() ?? [];
    const flowCookieHeader = rawCookies.find((cookie) => cookie.startsWith(`${FLOW_COOKIE}=`));
    assert.ok(flowCookieHeader?.includes("Path=/api/auth/oauth"), flowCookieHeader);
    assert.ok(flowCookieHeader?.includes("HttpOnly"), flowCookieHeader);
    assert.ok(/samesite=lax/i.test(flowCookieHeader ?? ""), flowCookieHeader);
  },
);

test(
  "sign-in creates a user, identity, and exactly one session, then signs in again via the identity",
  { skip: !connectionString },
  async (t) => {
    const email = "oauth-signin-new@example.test";
    const { flow } = await startSignInFlow();
    mockState.idToken = mockIdToken(mockClaims({ nonce: flow.nonce, email, sub: "sub-signin-new" }));
    const first = await callback(callbackRequest(flow));
    assert.equal(first.status, 302);
    assert.equal(locationOf(first), "/workspaces");
    const sessionCookie = cookieValue(setCookies(first), SESSION_COOKIE);
    assert.ok(sessionCookie, "sign-in sets a session cookie");
    assert.equal(first.headers.get("Referrer-Policy"), "no-referrer");
    const cleared = (first.headers.getSetCookie?.() ?? []).find((cookie) =>
      cookie.startsWith(`${FLOW_COOKIE}=`),
    );
    assert.ok(cleared?.includes("Max-Age=0"), "flow cookie is deleted on callback");

    const user = await queryOne<{ id: string; password_hash: string | null; email_verified_at: Date | null }>(
      "SELECT id, password_hash, email_verified_at FROM nexora.users WHERE email = $1",
      [email],
    );
    assert.ok(user, "user created");
    assert.equal(user.password_hash, null, "OAuth-only user has no password hash");
    assert.ok(user.email_verified_at, "provider-verified email is verified");
    const identity = await queryOne<{ provider_subject: string; provider_email: string }>(
      "SELECT provider_subject, provider_email FROM nexora.oauth_identities WHERE user_id = $1",
      [user.id],
    );
    assert.ok(identity);
    assert.equal(identity.provider_subject, "sub-signin-new");
    assert.equal(
      await countRows("SELECT COUNT(*) FROM nexora.user_sessions WHERE user_id = $1 AND revoked_at IS NULL", [
        user.id,
      ]),
      1,
      "exactly one session",
    );

    await t.test("second sign-in via the existing identity adds one more session", async () => {
      const second = await startSignInFlow();
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: second.flow.nonce, email, sub: "sub-signin-new" }),
      );
      const response = await callback(callbackRequest(second.flow));
      assert.equal(response.status, 302);
      assert.equal(locationOf(response), "/workspaces");
      assert.ok(cookieValue(setCookies(response), SESSION_COOKIE), "session cookie set again");
      assert.equal(
        await countRows(
          "SELECT COUNT(*) FROM nexora.user_sessions WHERE user_id = $1 AND revoked_at IS NULL",
          [user.id],
        ),
        2,
        "other sessions are kept",
      );
    });
  },
);

test(
  "sign-in with a verified provider email that already belongs to a user does not link or create",
  { skip: !connectionString },
  async () => {
    const email = "oauth-email-taken@example.test";
    await createFixtureUser(email);
    const { flow } = await startSignInFlow();
    mockState.idToken = mockIdToken(mockClaims({ nonce: flow.nonce, email, sub: "sub-taken-new" }));
    const response = await callback(callbackRequest(flow));
    assert.equal(response.status, 302);
    assert.equal(locationOf(response), "/login?error=oauth_email_taken");
    assert.equal(cookieValue(setCookies(response), SESSION_COOKIE), null, "no session");
    assert.equal(
      await countRows("SELECT COUNT(*) FROM nexora.oauth_identities WHERE provider_subject = $1", [
        "sub-taken-new",
      ]),
      0,
      "no identity created",
    );
    assert.equal(
      await countRows("SELECT COUNT(*) FROM nexora.users WHERE email = $1", [email]),
      1,
      "no duplicate user",
    );
  },
);

test(
  "disabled account never receives a session through OAuth",
  { skip: !connectionString },
  async () => {
    const email = "oauth-disabled@example.test";
    // user_status has no 'disabled' value; 'suspended' is the
    // non-active account state the OAuth gate must refuse.
    const userId = await createFixtureUser(email, { status: "suspended" });
    await createFixtureIdentity(userId, "sub-disabled", email);
    const { flow } = await startSignInFlow();
    mockState.idToken = mockIdToken(mockClaims({ nonce: flow.nonce, email, sub: "sub-disabled" }));
    const response = await callback(callbackRequest(flow));
    assert.equal(locationOf(response), "/login?error=oauth_failed");
    assert.equal(cookieValue(setCookies(response), SESSION_COOKIE), null);
  },
);

test(
  "provider errors, state mismatch, tampered and expired flows fail with the allowlisted codes",
  { skip: !connectionString },
  async (t) => {
    await t.test("provider access_denied maps to oauth_denied, other errors to oauth_failed", async () => {
      const denied = await startSignInFlow();
      const deniedResponse = await callback(
        callbackRequest(denied.flow, { error: "access_denied", code: "" }),
      );
      assert.equal(locationOf(deniedResponse), "/login?error=oauth_denied");
      const other = await startSignInFlow();
      const otherResponse = await callback(
        callbackRequest(other.flow, { error: "invalid_request", code: "" }),
      );
      assert.equal(locationOf(otherResponse), "/login?error=oauth_failed");
    });

    await t.test("state mismatch fails before any exchange", async () => {
      const { flow } = await startSignInFlow();
      mockState.idToken = mockIdToken(mockClaims({ nonce: flow.nonce }));
      const response = await callback(callbackRequest(flow, { state: "wrong-state-value-0123456789abcdefg" }));
      assert.equal(locationOf(response), "/login?error=oauth_failed");
    });

    await t.test("tampered cookie fails; expired cookie maps to oauth_expired", async () => {
      const { flow } = await startSignInFlow();
      const tamperedCookie = `${FLOW_COOKIE}=${flow.flowCookie.split("=")[1]}tampered`;
      const tampered = await callback(
        apiRequest(`/api/auth/oauth/google/callback?code=x&state=${flow.state}`, "GET", {
          cookies: [tamperedCookie],
        }),
      );
      assert.equal(locationOf(tampered), "/login?error=oauth_failed");

      const oldFlow = newFlow("signin", "/workspaces", null);
      oldFlow.createdAt = Date.now() - 11 * 60 * 1000;
      const oldCookie = `${FLOW_COOKIE}=${createFlowValue(oldFlow, SIGNING_KEY)}`;
      const expired = await callback(
        apiRequest(`/api/auth/oauth/google/callback?code=x&state=${oldFlow.state}`, "GET", {
          cookies: [oldCookie],
        }),
      );
      assert.equal(locationOf(expired), "/login?error=oauth_expired");
    });

    await t.test("a callback without a flow cookie is expired, not a 500", async () => {
      const response = await callback(apiRequest("/api/auth/oauth/google/callback?code=x&state=y", "GET"));
      assert.equal(locationOf(response), "/login?error=oauth_expired");
    });

    await t.test("malformed provider email never creates an account", async () => {
      const { flow } = await startSignInFlow();
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: flow.nonce, email: "not-an-email", sub: "sub-bad-email" }),
      );
      const response = await callback(callbackRequest(flow));
      assert.equal(locationOf(response), "/login?error=oauth_failed");
      assert.equal(
        await countRows("SELECT COUNT(*) FROM nexora.oauth_identities WHERE provider_subject = $1", [
          "sub-bad-email",
        ]),
        0,
      );
    });

    await t.test("wrong-audience id_token fails at the callback", async () => {
      const { flow } = await startSignInFlow();
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: flow.nonce, aud: "someone-else", sub: "sub-bad-aud" }),
      );
      const response = await callback(callbackRequest(flow));
      assert.equal(locationOf(response), "/login?error=oauth_failed");
    });
  },
);

test(
  "link flow: success creates an identity and no session; session change, missing session, and squatting refuse",
  { skip: !connectionString },
  async (t) => {
    const userA = await createFixtureUser("oauth-link-a@example.test");
    const userB = await createFixtureUser("oauth-link-b@example.test");
    const sessionA = await createSession(userA);
    const sessionB = await createSession(userB);
    const cookieA = sessionCookieFor(sessionA.token);
    const cookieB = sessionCookieFor(sessionB.token);

    await t.test("link success creates the identity and no new session", async () => {
      const sessionsBefore = await countRows(
        "SELECT COUNT(*) FROM nexora.user_sessions WHERE user_id = $1 AND revoked_at IS NULL",
        [userA],
      );
      const { flow } = await startLinkFlow(cookieA);
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: flow.nonce, email: "oauth-link-a@example.test", sub: "sub-link-a" }),
      );
      const response = await callback(callbackRequest(flow, {}, cookieA));
      assert.equal(response.status, 302);
      assert.equal(locationOf(response), "/account");
      assert.equal(cookieValue(setCookies(response), SESSION_COOKIE), null, "link creates no session");
      assert.equal(
        await countRows("SELECT COUNT(*) FROM nexora.oauth_identities WHERE user_id = $1", [userA]),
        1,
      );
      assert.equal(
        await countRows(
          "SELECT COUNT(*) FROM nexora.user_sessions WHERE user_id = $1 AND revoked_at IS NULL",
          [userA],
        ),
        sessionsBefore,
        "session count unchanged",
      );
    });

    await t.test("link with a changed session aborts without creating", async () => {
      const { flow } = await startLinkFlow(cookieA);
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: flow.nonce, email: "oauth-link-a@example.test", sub: "sub-link-changed" }),
      );
      const response = await callback(callbackRequest(flow, {}, cookieB));
      assert.equal(locationOf(response), "/account?error=oauth_failed");
      assert.equal(
        await countRows("SELECT COUNT(*) FROM nexora.oauth_identities WHERE provider_subject = $1", [
          "sub-link-changed",
        ]),
        0,
      );
    });

    await t.test("link with no session goes to login with a generic error", async () => {
      const { flow } = await startLinkFlow(cookieA);
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: flow.nonce, email: "oauth-link-a@example.test", sub: "sub-link-nosession" }),
      );
      const response = await callback(callbackRequest(flow));
      assert.equal(locationOf(response), "/login?error=oauth_failed");
    });

    await t.test("linking an already-linked identity and a second identity both report already_linked", async () => {
      const { flow } = await startLinkFlow(cookieA);
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: flow.nonce, email: "oauth-link-a@example.test", sub: "sub-link-a" }),
      );
      const again = await callback(callbackRequest(flow, {}, cookieA));
      assert.equal(locationOf(again), "/account?error=oauth_already_linked");
      assert.equal(
        await countRows("SELECT COUNT(*) FROM nexora.oauth_identities WHERE user_id = $1", [userA]),
        1,
        "no duplicate identity",
      );

      const second = await startLinkFlow(cookieA);
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: second.flow.nonce, email: "oauth-link-a@example.test", sub: "sub-link-a-second" }),
      );
      const secondResponse = await callback(callbackRequest(second.flow, {}, cookieA));
      assert.equal(locationOf(secondResponse), "/account?error=oauth_already_linked");
    });

    await t.test("linking an identity owned by another user refuses generically", async () => {
      const { flow } = await startLinkFlow(cookieB);
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: flow.nonce, email: "oauth-link-b@example.test", sub: "sub-link-a" }),
      );
      const response = await callback(callbackRequest(flow, {}, cookieB));
      assert.equal(locationOf(response), "/account?error=oauth_failed");
    });

    await t.test("linking with a provider email owned by another account refuses generically", async () => {
      const { flow } = await startLinkFlow(cookieB);
      mockState.idToken = mockIdToken(
        mockClaims({ nonce: flow.nonce, email: "oauth-link-a@example.test", sub: "sub-link-squat" }),
      );
      const response = await callback(callbackRequest(flow, {}, cookieB));
      assert.equal(locationOf(response), "/account?error=oauth_failed");
      assert.equal(
        await countRows("SELECT COUNT(*) FROM nexora.oauth_identities WHERE provider_subject = $1", [
          "sub-link-squat",
        ]),
        0,
      );
    });
  },
);

test(
  "start and callback IP limits are separate scopes: 61st start is 429, 61st callback is a generic error",
  { skip: !connectionString },
  async () => {
    const startIp = freshIp();
    let lastStart: Response | undefined;
    for (let i = 0; i < 61; i += 1) {
      lastStart = await startSignIn(
        apiRequest("/api/auth/oauth/google/start", "POST", { body: {}, ip: startIp }),
      );
    }
    assert.equal(lastStart?.status, 429);
    assert.equal(lastStart?.headers.get("retry-after"), "900");

    const callbackIp = freshIp();
    let lastCallback: Response | undefined;
    for (let i = 0; i < 61; i += 1) {
      lastCallback = await callback(
        apiRequest("/api/auth/oauth/google/callback?code=x&state=y", "GET", { ip: callbackIp }),
      );
    }
    assert.equal(lastCallback?.status, 302, "callback limit never surfaces as a 429");
    assert.equal(locationOf(lastCallback as Response), "/login?error=oauth_failed");
  },
);
