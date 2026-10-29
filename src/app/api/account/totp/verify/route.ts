import type { NextRequest } from "next/server";
import { getAuthPrincipal, getAuthenticatedUser } from "../../../../../server/auth.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../server/api.ts";
import { isRateLimited } from "../../../../../server/auth-rate-limit.ts";
import { withUserContext } from "../../../../../server/db.ts";
import { verifyTotpSetup } from "../../../../../server/totp.ts";
import { totpVerifySchema } from "../../../../../security/auth-schemas.ts";
import { TotpConfigurationError } from "../../../../../security/totp.ts";

export const runtime = "nodejs";

// POST /api/account/totp/verify — prove possession of the pending
// secret. Only a correct code flips the row to verified; a wrong
// code leaves the pending row untouched, and an already-verified
// row cannot be re-verified into a different secret.
export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, totpVerifySchema);
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
    if (await isRateLimited(request, "totp-verify-user", principal.userId, 10, 3600, 30)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }
    const result = await withUserContext(principal.userId, async (transaction) => {
      return verifyTotpSetup(transaction, principal.userId, parsed.value.code, Date.now());
    });
    if (result === "not-pending") {
      return jsonError(request, 409, "TOTP_NOT_PENDING", "No authenticator setup is in progress.");
    }
    if (result === "invalid") {
      return jsonError(request, 401, "INVALID_CREDENTIALS", "The authenticator code is incorrect.");
    }
    return jsonOk(request, { enabled: true });
  } catch (error) {
    if (error instanceof TotpConfigurationError) {
      return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Two-factor authentication is not configured.");
    }
    return jsonServerFailure(request, "account.totp.verify", error);
  }
}
