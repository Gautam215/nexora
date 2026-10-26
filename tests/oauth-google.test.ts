import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import { emailSchema } from "../src/security/auth-schemas.ts";
import { getOAuthConfig, isOAuthEnabled } from "../src/server/oauth/config.ts";
import {
  createFlowValue,
  newFlow,
  pkceChallenge,
  verifyFlowValue,
  type OAuthFlowPayload,
} from "../src/server/oauth/flow.ts";
import { resolveOAuthDisplayName } from "../src/server/oauth/accounts.ts";
import {
  verifyIdToken,
  type JwksDocument,
  type JwksKey,
  type VerifiedIdToken,
} from "../src/server/oauth/google.ts";

const CLIENT_ID = "test-client-id";
const SIGNING_KEY = "test-oauth-flow-signing-key-32-bytes!!";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("PKCE S256 challenge equals base64url(SHA256(verifier)) and verifiers are 43 chars", () => {
  const flow = newFlow("signin", "/workspaces", null);
  assert.equal(flow.verifier.length, 43);
  assert.equal(flow.state.length, 43);
  assert.equal(flow.nonce.length, 43);
  assert.equal(
    pkceChallenge(flow.verifier),
    createHash("sha256").update(flow.verifier).digest("base64url"),
  );
});

test("flow cookie verifies, and tampered, malformed, and missing-field values are rejected", () => {
  const flow = newFlow("signin", "/workspaces", null);
  const value = createFlowValue(flow, SIGNING_KEY);
  const verified = verifyFlowValue(value, SIGNING_KEY);
  assert.equal(verified.status, "ok");
  if (verified.status === "ok") assert.equal(verified.payload.state, flow.state);

  // Tampered payload: same signature shape, different content.
  const tampered = `${base64urlJson({ ...flow, next: "/evil" })}.${value.split(".")[1]}`;
  assert.equal(verifyFlowValue(tampered, SIGNING_KEY).status, "invalid");
  // Tampered signature.
  const badSignature = `${value.split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  assert.equal(verifyFlowValue(badSignature, SIGNING_KEY).status, "invalid");
  // Malformed and missing values.
  assert.equal(verifyFlowValue("not-a-flow-value", SIGNING_KEY).status, "invalid");
  assert.equal(verifyFlowValue(undefined, SIGNING_KEY).status, "invalid");
  // Missing field.
  const { nonce: _nonce, ...withoutNonce } = flow;
  assert.equal(
    verifyFlowValue(createFlowValue(withoutNonce as OAuthFlowPayload, SIGNING_KEY), SIGNING_KEY).status,
    "invalid",
  );
  // Unknown intent, signin carrying a link user, link without a UUID.
  assert.equal(
    verifyFlowValue(
      createFlowValue({ ...flow, intent: "bogus" } as unknown as OAuthFlowPayload, SIGNING_KEY),
      SIGNING_KEY,
    ).status,
    "invalid",
  );
  assert.equal(
    verifyFlowValue(
      createFlowValue({ ...flow, linkUserId: "someone" }, SIGNING_KEY),
      SIGNING_KEY,
    ).status,
    "invalid",
  );
  assert.equal(
    verifyFlowValue(
      createFlowValue({ ...flow, intent: "link", linkUserId: null }, SIGNING_KEY),
      SIGNING_KEY,
    ).status,
    "invalid",
  );
});

test("flow cookie over 10 minutes old is expired, not valid", () => {
  const flow = newFlow("signin", "/workspaces", null);
  flow.createdAt = Date.now() - 11 * 60 * 1000;
  const verified = verifyFlowValue(createFlowValue(flow, SIGNING_KEY), SIGNING_KEY);
  assert.equal(verified.status, "expired");
  if (verified.status === "expired") assert.equal(verified.payload.state, flow.state);
});

test("OAuth flag and configuration fail closed", () => {
  withEnv({ OAUTH_GOOGLE_ENABLED: "false" }, () => {
    assert.equal(isOAuthEnabled(), false);
  });
  withEnv({ OAUTH_GOOGLE_ENABLED: "true" }, () => {
    assert.equal(isOAuthEnabled(), true);
  });
  withEnv(
    {
      OAUTH_GOOGLE_ENABLED: "true",
      OAUTH_GOOGLE_CLIENT_ID: CLIENT_ID,
      OAUTH_GOOGLE_CLIENT_SECRET: undefined,
      OAUTH_FLOW_SIGNING_KEY: SIGNING_KEY,
      APP_ORIGIN: "http://localhost:3000",
      NODE_ENV: "test",
    },
    () => {
      assert.equal(getOAuthConfig(), null);
    },
  );
  withEnv(
    {
      OAUTH_GOOGLE_ENABLED: "true",
      OAUTH_GOOGLE_CLIENT_ID: CLIENT_ID,
      OAUTH_GOOGLE_CLIENT_SECRET: "test-secret",
      OAUTH_FLOW_SIGNING_KEY: "short",
      APP_ORIGIN: "http://localhost:3000",
      NODE_ENV: "test",
    },
    () => {
      assert.equal(getOAuthConfig(), null);
    },
  );
  withEnv(
    {
      OAUTH_GOOGLE_CLIENT_ID: CLIENT_ID,
      OAUTH_GOOGLE_CLIENT_SECRET: "test-secret",
      OAUTH_FLOW_SIGNING_KEY: SIGNING_KEY,
      APP_ORIGIN: "http://localhost:3000",
      NODE_ENV: "test",
    },
    () => {
      const config = getOAuthConfig();
      assert.ok(config);
      assert.equal(config.redirectUri, "http://localhost:3000/api/auth/oauth/google/callback");
    },
  );
  withEnv(
    {
      OAUTH_GOOGLE_CLIENT_ID: CLIENT_ID,
      OAUTH_GOOGLE_CLIENT_SECRET: "test-secret",
      OAUTH_FLOW_SIGNING_KEY: SIGNING_KEY,
      APP_ORIGIN: "http://localhost:3000/",
      NODE_ENV: "test",
    },
    () => {
      // A trailing slash on the origin must not double the slash in
      // the redirect URI, which has to match the registered URI exactly.
      assert.equal(
        getOAuthConfig()?.redirectUri,
        "http://localhost:3000/api/auth/oauth/google/callback",
      );
    },
  );
  withEnv(
    {
      OAUTH_GOOGLE_CLIENT_ID: CLIENT_ID,
      OAUTH_GOOGLE_CLIENT_SECRET: "test-secret",
      OAUTH_FLOW_SIGNING_KEY: SIGNING_KEY,
      APP_ORIGIN: "http://remote.example.test",
      NODE_ENV: "production",
    },
    () => {
      assert.equal(getOAuthConfig(), null);
    },
  );
  withEnv(
    {
      OAUTH_GOOGLE_CLIENT_ID: CLIENT_ID,
      OAUTH_GOOGLE_CLIENT_SECRET: "test-secret",
      OAUTH_FLOW_SIGNING_KEY: SIGNING_KEY,
      APP_ORIGIN: "https://app.example.test",
      NODE_ENV: "production",
    },
    () => {
      assert.ok(getOAuthConfig());
    },
  );
});

// ---- id_token verification matrix ----

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as unknown as JwksKey & { n: string; e: string };
const KID = "test-kid-1";
const JWKS: JwksDocument = { keys: [{ kid: KID, kty: "RSA", n: jwk.n, e: jwk.e }] };
const NOW = Math.floor(Date.now() / 1000);

function signToken(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: KeyObject = privateKey,
): string {
  const input = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  if (header.alg === "none") return `${input}.`;
  const signature = sign("sha256", Buffer.from(input), key);
  return `${input}.${signature.toString("base64url")}`;
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: NOW + 3600,
    iat: NOW,
    nonce: "test-nonce",
    email_verified: true,
    sub: "google-sub-1",
    email: "oauth-user@example.test",
    name: "OAuth User",
    ...overrides,
  };
}

async function verify(
  token: string,
  overrides: { nonce?: string; fetchJwks?: (url: string, force?: boolean) => Promise<JwksDocument | null> } = {},
): Promise<VerifiedIdToken | null> {
  return verifyIdToken(token, {
    clientId: CLIENT_ID,
    jwksUrl: "https://jwks.example.test/certs",
    expectedNonce: overrides.nonce ?? "test-nonce",
    fetchJwks: overrides.fetchJwks ?? (async () => JWKS),
  });
}

test("id_token: valid token verifies and returns claims", async () => {
  const token = signToken({ alg: "RS256", kid: KID }, baseClaims());
  const verified = await verify(token);
  assert.ok(verified);
  assert.equal(verified.sub, "google-sub-1");
  assert.equal(verified.email, "oauth-user@example.test");
  assert.equal(verified.name, "OAuth User");
});

test("id_token: rejects wrong aud (including array aud), wrong iss, expiry, nonce, iat", async () => {
  const cases: Array<[string, Record<string, unknown>, { nonce?: string }?]> = [
    ["wrong aud string", baseClaims({ aud: "other-client" })],
    ["array aud", baseClaims({ aud: [CLIENT_ID] })],
    ["wrong iss", baseClaims({ iss: "https://evil.example.test" })],
    ["expired", baseClaims({ exp: NOW - 3600 })],
    ["iat too far in future", baseClaims({ iat: NOW + 3600 })],
  ];
  for (const [label, claims] of cases) {
    assert.equal(await verify(signToken({ alg: "RS256", kid: KID }, claims)), null, label);
  }
  assert.equal(
    await verify(signToken({ alg: "RS256", kid: KID }, baseClaims()), { nonce: "other-nonce" }),
    null,
    "nonce mismatch",
  );
});

test("id_token: rejects email_verified false, missing, and non-boolean", async () => {
  for (const value of [false, "true", 1]) {
    assert.equal(
      await verify(signToken({ alg: "RS256", kid: KID }, baseClaims({ email_verified: value }))),
      null,
      `email_verified=${String(value)}`,
    );
  }
  const { email_verified: _removed, ...withoutClaim } = baseClaims();
  assert.equal(await verify(signToken({ alg: "RS256", kid: KID }, withoutClaim)), null);
});

test("id_token: rejects alg none and HS256 even with a verifiable signature", async () => {
  const noneToken = signToken({ alg: "none", kid: KID }, baseClaims());
  assert.equal(await verify(noneToken), null, "alg none");
  const hsToken = (() => {
    const input = `${base64urlJson({ alg: "HS256", kid: KID })}.${base64urlJson(baseClaims())}`;
    const signature = createHmac("sha256", "anything").update(input).digest("base64url");
    return `${input}.${signature}`;
  })();
  assert.equal(await verify(hsToken), null, "alg HS256");
});

test("id_token: unknown kid refetches once, then fails closed when still unknown", async () => {
  let calls = 0;
  const rotating = async (_url: string, forceRefresh?: boolean): Promise<JwksDocument | null> => {
    calls += 1;
    // First fetch has only the old key; a forced refetch reveals the
    // rotated key, proving the exactly-once refetch.
    if (forceRefresh) return JWKS;
    return { keys: [{ kid: "old-kid", kty: "RSA", n: jwk.n, e: jwk.e }] };
  };
  const rotated = await verify(signToken({ alg: "RS256", kid: KID }, baseClaims()), {
    fetchJwks: rotating,
  });
  assert.ok(rotated, "rotated key accepted after one refetch");
  assert.equal(calls, 2);

  calls = 0;
  const neverFound = async (): Promise<JwksDocument | null> => {
    calls += 1;
    return { keys: [{ kid: "other-kid", kty: "RSA", n: jwk.n, e: jwk.e }] };
  };
  assert.equal(
    await verify(signToken({ alg: "RS256", kid: KID }, baseClaims()), { fetchJwks: neverFound }),
    null,
  );
  assert.equal(calls, 2, "exactly one refetch, then fail closed");
});

test("id_token: JWKS fetch failure fails closed; bad signature and bad sub rejected", async () => {
  assert.equal(
    await verify(signToken({ alg: "RS256", kid: KID }, baseClaims()), {
      fetchJwks: async () => null,
    }),
    null,
    "JWKS failure",
  );
  const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.equal(
    await verify(signToken({ alg: "RS256", kid: KID }, baseClaims(), otherKey)),
    null,
    "wrong-key signature",
  );
  assert.equal(
    await verify(signToken({ alg: "RS256", kid: KID }, baseClaims({ sub: "" }))),
    null,
    "empty sub",
  );
  assert.equal(
    await verify(signToken({ alg: "RS256", kid: KID }, baseClaims({ sub: "x".repeat(257) }))),
    null,
    "over-long sub",
  );
});

test("provider email and display-name rules", () => {
  assert.equal(emailSchema.safeParse({ email: "oauth-user@example.test" }).success, true);
  assert.equal(emailSchema.safeParse({ email: "not-an-email" }).success, false);
  assert.equal(emailSchema.safeParse({ email: `a@${"x".repeat(320)}.test` }).success, false);
  assert.equal(resolveOAuthDisplayName("  OAuth User  ", "oauth-user@example.test"), "OAuth User");
  assert.equal(resolveOAuthDisplayName("   ", "oauth-user@example.test"), "oauth-user");
  assert.equal(resolveOAuthDisplayName("x".repeat(121), "oauth-user@example.test"), "oauth-user");
  assert.equal(resolveOAuthDisplayName(null, "oauth-user@example.test"), "oauth-user");
});
