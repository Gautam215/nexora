import type { NextRequest } from "next/server";
import {
  getAuthenticatedUser,
  getAuthPrincipal,
  listActiveSessions,
} from "../../../../server/auth.ts";
import {
  jsonError,
  jsonOk,
  jsonServerFailure,
} from "../../../../server/api.ts";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const user = await getAuthenticatedUser(principal);
    if (!user) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const sessions = await listActiveSessions(principal.userId);
    return jsonOk(request, {
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        current: session.id === principal.sessionId,
      })),
    });
  } catch (error) {
    return jsonServerFailure(request, "auth.sessions.list", error);
  }
}
