import "server-only";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server.js";
import { jsonError } from "../api.ts";
import { isIpRateLimited } from "../auth-rate-limit.ts";
import { getOAuthConfig, isOAuthEnabled } from "./config.ts";
import { createFlowValue, newFlow, setFlowCookie, type OAuthFlowIntent } from "./flow.ts";
import { buildAuthorizeUrl } from "./google.ts";

export const OAUTH_START_RATE_LIMIT = 60;
export const OAUTH_START_WINDOW_SECONDS = 900;

/**
 * Shared Google OAuth start (signin and link). Order matters: flag
 * first (disabled endpoints 404 without burning rate-limit budget),
 * then the IP rate limit, then credentials (fail closed with 503,
 * never a redirect to Google with a missing client ID).
 */
export async function handleOAuthStart(
  request: NextRequest,
  intent: OAuthFlowIntent,
  next: string,
  linkUserId: string | null,
): Promise<Response> {
  if (!isOAuthEnabled()) {
    return jsonError(request, 404, "NOT_FOUND", "Not found.");
  }
  if (await isIpRateLimited(request, "oauth-start", OAUTH_START_RATE_LIMIT, OAUTH_START_WINDOW_SECONDS)) {
    return jsonError(request, 429, "RATE_LIMITED", "Too many attempts. Wait before trying again.", {
      "retry-after": String(OAUTH_START_WINDOW_SECONDS),
    });
  }
  const config = getOAuthConfig();
  if (!config) {
    return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Sign-in with Google is not configured.");
  }
  const flow = newFlow(intent, next, linkUserId);
  const response = new NextResponse(null, {
    status: 302,
    headers: { location: buildAuthorizeUrl(config, flow) },
  });
  setFlowCookie(response, createFlowValue(flow, config.signingKey));
  return response;
}
