import type { NextRequest } from "next/server";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
} from "../../../../server/api.ts";
import {
  clearSessionCookie,
  getAuthPrincipal,
  revokeSession,
} from "../../../../server/auth.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }

  try {
    const principal = await getAuthPrincipal(request);
    if (principal) await revokeSession(principal);
    const response = jsonOk(request, { signedOut: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    const response = jsonServerFailure(request, "auth.logout", error);
    clearSessionCookie(response);
    return response;
  }
}
