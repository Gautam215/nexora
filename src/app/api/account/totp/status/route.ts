import type { NextRequest } from "next/server";
import { getAuthPrincipal, getAuthenticatedUser } from "../../../../../server/auth.ts";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../../server/api.ts";
import { withUserContext } from "../../../../../server/db.ts";
import { getTotpEnrolled } from "../../../../../server/totp.ts";

export const runtime = "nodejs";

// GET /api/account/totp/status — whether the caller has a verified
// authenticator. Read-only and session-gated; the UI uses it to
// decide whether deletion dialogs ask for a code.
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
    const enrolled = await withUserContext(principal.userId, async (transaction) => {
      return getTotpEnrolled(transaction, principal.userId);
    });
    return jsonOk(request, { enrolled });
  } catch (error) {
    return jsonServerFailure(request, "account.totp.status", error);
  }
}
