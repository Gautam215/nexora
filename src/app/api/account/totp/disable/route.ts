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
import {
  lookupLoginAccount,
  withUserContext,
} from "../../../../../server/db.ts";
import {
  deleteTotpCredential,
  verifyTotpForDelete,
} from "../../../../../server/totp.ts";
import { totpDisableSchema } from "../../../../../security/auth-schemas.ts";
import { TotpConfigurationError } from "../../../../../security/totp.ts";
import { verifyPassword } from "../../../../../security/password.ts";

export const runtime = "nodejs";

// POST /api/account/totp/disable — remove the second factor.
// Removing a factor requires both factors (password + current
// code), so a stolen session alone cannot strip the protection
// that guards deletion.
export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, totpDisableSchema);
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
    const loginAccount = await lookupLoginAccount(user.email);
    const passwordMatches = await verifyPassword(
      parsed.value.password,
      loginAccount?.password_hash,
    );
    if (!passwordMatches) {
      return jsonError(request, 401, "INVALID_CREDENTIALS", "The password is incorrect.");
    }
    const result = await withUserContext(principal.userId, async (transaction) => {
      const checked = await verifyTotpForDelete(
        transaction,
        principal.userId,
        parsed.value.code,
        Date.now(),
      );
      if (checked !== "valid") return checked;
      await deleteTotpCredential(transaction, principal.userId);
      return "valid" as const;
    });
    if (result === "not-enrolled") {
      return jsonError(request, 409, "TOTP_NOT_ENABLED", "Two-factor authentication is not enabled.");
    }
    if (result === "invalid") {
      return jsonError(request, 401, "INVALID_CREDENTIALS", "The authenticator code is incorrect.");
    }
    return jsonOk(request, { disabled: true });
  } catch (error) {
    if (error instanceof TotpConfigurationError) {
      return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Two-factor authentication is not configured.");
    }
    return jsonServerFailure(request, "account.totp.disable", error);
  }
}
