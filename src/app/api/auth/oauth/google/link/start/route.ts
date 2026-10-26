import type { NextRequest } from "next/server";
import { hasSameOrigin, jsonError } from "../../../../../../../server/api.ts";
import { getAuthPrincipal, getAuthenticatedUser } from "../../../../../../../server/auth.ts";
import { handleOAuthStart } from "../../../../../../../server/oauth/start.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const principal = await getAuthPrincipal(request);
  if (!principal) {
    return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  }
  // The link flow is started only by a signed-in user with a usable
  // account; a disabled account never starts a link.
  const user = await getAuthenticatedUser(principal);
  if (!user) {
    return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  }
  return handleOAuthStart(request, "link", "/account", principal.userId);
}
