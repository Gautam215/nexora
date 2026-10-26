import type { NextRequest } from "next/server";
import {
  getAuthenticatedUser,
  getAuthPrincipal,
  revokeOtherSessions,
} from "../../../../../server/auth.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
} from "../../../../../server/api.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const user = await getAuthenticatedUser(principal);
    if (!user) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const otherSessionsRevoked = await revokeOtherSessions(principal.userId, principal.sessionId);
    return jsonOk(request, { otherSessionsRevoked });
  } catch (error) {
    return jsonServerFailure(request, "auth.sessions.revoke-others", error);
  }
}
