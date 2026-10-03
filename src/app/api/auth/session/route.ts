import type { NextRequest } from "next/server";
import {
  jsonError,
  jsonOk,
  jsonServerFailure,
} from "../../../../server/api.ts";
import {
  getAuthPrincipal,
  getAuthenticatedUser,
} from "../../../../server/auth.ts";

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
    return jsonOk(request, {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        emailVerifiedAt: user.email_verified_at,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    return jsonServerFailure(request, "auth.session", error);
  }
}
