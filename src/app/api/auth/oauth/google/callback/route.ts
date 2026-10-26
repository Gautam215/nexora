import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server.js";
import { jsonError, jsonServerFailure } from "../../../../../../server/api.ts";
import {
  createSession,
  getAuthPrincipal,
  getAuthenticatedUser,
  setSessionCookie,
} from "../../../../../../server/auth.ts";
import { isIpRateLimited } from "../../../../../../server/auth-rate-limit.ts";
import { emailSchema, normalizeAuthEmail } from "../../../../../../security/auth-schemas.ts";
import {
  createUserWithIdentity,
  isUniqueViolation,
  linkIdentity,
  lookupAccountByEmail,
  lookupOAuthIdentity,
  passesAccountGate,
  resolveOAuthDisplayName,
  updateIdentityUsage,
  userHasGoogleIdentity,
} from "../../../../../../server/oauth/accounts.ts";
import { getOAuthConfig, isOAuthEnabled } from "../../../../../../server/oauth/config.ts";
import {
  clearFlowCookie,
  flowCookieName,
  verifyFlowValue,
  type OAuthFlowPayload,
} from "../../../../../../server/oauth/flow.ts";
import {
  cachedFetchJwks,
  exchangeCode,
  verifyIdToken,
} from "../../../../../../server/oauth/google.ts";

export const runtime = "nodejs";

const OAUTH_CALLBACK_RATE_LIMIT = 60;
const OAUTH_CALLBACK_WINDOW_SECONDS = 900;

type OAuthErrorCode =
  | "oauth_failed"
  | "oauth_denied"
  | "oauth_expired"
  | "oauth_already_linked"
  | "oauth_email_taken";

function redirectWithCode(target: string, code: OAuthErrorCode): NextResponse {
  const response = new NextResponse(null, {
    status: 302,
    headers: { location: `${target}?error=${code}`, "Referrer-Policy": "no-referrer" },
  });
  clearFlowCookie(response);
  return response;
}

function redirectSuccess(target: string): NextResponse {
  const response = new NextResponse(null, {
    status: 302,
    headers: { location: target, "Referrer-Policy": "no-referrer" },
  });
  clearFlowCookie(response);
  return response;
}

/** Link-flow failures go to /account when a session exists, else /login. */
async function linkFailureTarget(request: NextRequest): Promise<string> {
  const principal = await getAuthPrincipal(request);
  return principal ? "/account" : "/login";
}

async function failureRedirect(
  request: NextRequest,
  flow: OAuthFlowPayload | null,
  code: OAuthErrorCode,
): Promise<NextResponse> {
  if (flow?.intent === "link") {
    return redirectWithCode(await linkFailureTarget(request), code);
  }
  return redirectWithCode("/login", code);
}

export async function GET(request: NextRequest) {
  try {
    // No same-origin check here: the provider is cross-origin by
    // design. State and PKCE are the callback's CSRF defence.
    const params = new URL(request.url).searchParams;
    const flowCookie = request.cookies.get(flowCookieName())?.value;

    if (!isOAuthEnabled()) {
      const response = jsonError(request, 404, "NOT_FOUND", "Not found.");
      if (flowCookie) clearFlowCookie(response);
      return response;
    }

    // The callback IP limit fails as a generic sign-in error, never a
    // distinct 429, so the limit itself does not become an oracle.
    if (
      await isIpRateLimited(request, "oauth-callback", OAUTH_CALLBACK_RATE_LIMIT, OAUTH_CALLBACK_WINDOW_SECONDS)
    ) {
      return redirectWithCode("/login", "oauth_failed");
    }

    const config = getOAuthConfig();
    if (!config) {
      // Missing credentials mid-flow: generic error, never a redirect
      // to Google and never a 503 page.
      return redirectWithCode("/login", "oauth_failed");
    }

    if (!flowCookie) {
      // A missing flow cookie means the flow never started, expired
      // browser-side, or was already used (deleted on first callback).
      return redirectWithCode("/login", "oauth_expired");
    }
    const flowVerification = verifyFlowValue(flowCookie, config.signingKey);
    if (flowVerification.status === "invalid") {
      return redirectWithCode("/login", "oauth_failed");
    }
    if (flowVerification.status === "expired") {
      return failureRedirect(request, flowVerification.payload, "oauth_expired");
    }
    const flow = flowVerification.payload;

    const providerError = params.get("error");
    if (providerError) {
      const code = providerError === "access_denied" ? "oauth_denied" : "oauth_failed";
      return failureRedirect(request, flow, code);
    }
    if (params.get("state") !== flow.state) {
      return failureRedirect(request, flow, "oauth_failed");
    }
    const code = params.get("code");
    if (!code) {
      return failureRedirect(request, flow, "oauth_failed");
    }

    const exchanged = await exchangeCode(config, code, flow.verifier);
    if (!exchanged) {
      return failureRedirect(request, flow, "oauth_failed");
    }
    const verified = await verifyIdToken(exchanged.idToken, {
      clientId: config.clientId,
      jwksUrl: config.jwksUrl,
      expectedNonce: flow.nonce,
      fetchJwks: cachedFetchJwks,
    });
    if (!verified) {
      return failureRedirect(request, flow, "oauth_failed");
    }

    const normalizedEmail = normalizeAuthEmail(verified.email);
    const parsedEmail = emailSchema.safeParse({ email: normalizedEmail });
    if (!parsedEmail.success) {
      return failureRedirect(request, flow, "oauth_failed");
    }
    const email = parsedEmail.data.email;

    if (flow.intent === "signin") {
      return signInCallback(flow, verified.sub, email, verified.name);
    }
    return linkCallback(request, flow, verified.sub, email);
  } catch (error) {
    return jsonServerFailure(request, "auth.oauth.callback", error);
  }
}

async function signInCallback(
  flow: OAuthFlowPayload,
  subject: string,
  email: string,
  profileName: string | null,
): Promise<NextResponse> {
  const identity = await lookupOAuthIdentity("google", subject);
  if (identity) {
    if (!passesAccountGate(identity.status, identity.emailVerifiedAt)) {
      return redirectWithCode("/login", "oauth_failed");
    }
    await updateIdentityUsage(identity.userId, email);
    const session = await createSession(identity.userId);
    const response = redirectSuccess(flow.next);
    setSessionCookie(response, session);
    return response;
  }

  const existingAccount = await lookupAccountByEmail(email);
  if (existingAccount) {
    // Never link and never create from an email match.
    return redirectWithCode("/login", "oauth_email_taken");
  }

  const userId = randomUUID();
  try {
    await createUserWithIdentity(userId, email, resolveOAuthDisplayName(profileName, email), subject, email);
  } catch (error) {
    if (isUniqueViolation(error, "users_email_unique")) {
      // Duplicate-email race: re-look the email up instead of a 500.
      const raced = await lookupAccountByEmail(email);
      if (raced) return redirectWithCode("/login", "oauth_email_taken");
      return redirectWithCode("/login", "oauth_failed");
    }
    if (
      isUniqueViolation(error, "oauth_identities_subject_unique") ||
      isUniqueViolation(error, "oauth_identities_user_provider_unique")
    ) {
      // Duplicate-identity race: proceed as if it had been found.
      const raced = await lookupOAuthIdentity("google", subject);
      if (raced && passesAccountGate(raced.status, raced.emailVerifiedAt)) {
        await updateIdentityUsage(raced.userId, email);
        const session = await createSession(raced.userId);
        const response = redirectSuccess(flow.next);
        setSessionCookie(response, session);
        return response;
      }
      return redirectWithCode("/login", "oauth_failed");
    }
    throw error;
  }

  const session = await createSession(userId);
  const response = redirectSuccess(flow.next);
  setSessionCookie(response, session);
  return response;
}

async function linkCallback(
  request: NextRequest,
  flow: OAuthFlowPayload,
  subject: string,
  email: string,
): Promise<NextResponse> {
  const principal = await getAuthPrincipal(request);
  if (!principal) {
    return redirectWithCode("/login", "oauth_failed");
  }
  if (principal.userId !== flow.linkUserId) {
    // The session changed between start and callback: abort without
    // creating anything, so the provider is never linked to the wrong
    // account.
    return redirectWithCode("/account", "oauth_failed");
  }
  const user = await getAuthenticatedUser(principal);
  if (!user || user.email_verified_at === null) {
    return redirectWithCode("/account", "oauth_failed");
  }

  const identity = await lookupOAuthIdentity("google", subject);
  if (identity) {
    if (identity.userId === principal.userId) {
      return redirectWithCode("/account", "oauth_already_linked");
    }
    return redirectWithCode("/account", "oauth_failed");
  }
  if (await userHasGoogleIdentity(principal.userId)) {
    return redirectWithCode("/account", "oauth_already_linked");
  }
  const squatter = await lookupAccountByEmail(email);
  if (squatter && squatter.userId !== principal.userId) {
    return redirectWithCode("/account", "oauth_failed");
  }

  try {
    await linkIdentity(principal.userId, subject, email);
  } catch (error) {
    if (
      isUniqueViolation(error, "oauth_identities_subject_unique") ||
      isUniqueViolation(error, "oauth_identities_user_provider_unique")
    ) {
      const raced = await lookupOAuthIdentity("google", subject);
      if (raced && raced.userId === principal.userId) {
        return redirectWithCode("/account", "oauth_already_linked");
      }
      return redirectWithCode("/account", "oauth_failed");
    }
    throw error;
  }
  // No new session is created by a link flow.
  return redirectSuccess("/account");
}
