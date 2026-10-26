import type { NextRequest } from "next/server";
import { sessionRevokeSchema } from "../../../../../security/auth-schemas.ts";
import {
  clearSessionCookie,
  getAuthenticatedUser,
  getAuthPrincipal,
  revokeSessionById,
} from "../../../../../server/auth.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../server/api.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, sessionRevokeSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const user = await getAuthenticatedUser(principal);
    if (!user) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const revoked = await revokeSessionById(principal.userId, parsed.value.sessionId);
    if (!revoked) {
      // Not found, already revoked, expired, or another user's session:
      // deliberately the same response for all four, so a session ID
      // cannot be probed for ownership.
      return jsonError(request, 404, "SESSION_NOT_FOUND", "Session not found.");
    }
    const currentRevoked = parsed.value.sessionId === principal.sessionId;
    const response = jsonOk(request, { revoked: true, currentRevoked });
    if (currentRevoked) clearSessionCookie(response);
    return response;
  } catch (error) {
    return jsonServerFailure(request, "auth.sessions.revoke", error);
  }
}
