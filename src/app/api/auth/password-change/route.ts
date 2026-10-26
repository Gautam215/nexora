import type { NextRequest } from "next/server";
import { changePasswordSchema } from "../../../../security/auth-schemas.ts";
import { hashPassword, verifyPassword } from "../../../../security/password.ts";
import {
  clearSessionCookie,
  changePasswordAndRevokeOthers,
  getAuthenticatedUser,
  getAuthPrincipal,
} from "../../../../server/auth.ts";
import { isRateLimited } from "../../../../server/auth-rate-limit.ts";
import { lookupLoginAccount } from "../../../../server/db.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../server/api.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, changePasswordSchema);
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
    if (await isRateLimited(request, "password-change", user.email, 5, 3600, 30)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }

    const { currentPassword, newPassword } = parsed.value;
    const account = await lookupLoginAccount(user.email);
    const currentMatches = await verifyPassword(currentPassword, account?.password_hash);
    if (
      !account ||
      account.status !== "active" ||
      !account.email_verified_at ||
      !currentMatches
    ) {
      return jsonError(request, 401, "INVALID_CREDENTIALS", "Current password is incorrect.");
    }
    if (newPassword === currentPassword) {
      return jsonError(
        request,
        400,
        "PASSWORD_UNCHANGED",
        "New password must be different from current password.",
      );
    }

    const newPasswordHash = await hashPassword(newPassword);
    const otherSessionsRevoked = await changePasswordAndRevokeOthers(
      principal.userId,
      principal.sessionId,
      newPasswordHash,
    );
    if (otherSessionsRevoked === null) {
      // The account changed concurrently (for example, it was disabled).
      // The current session can no longer be trusted to stay signed in.
      const response = jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
      clearSessionCookie(response);
      return response;
    }
    return jsonOk(request, { passwordUpdated: true, otherSessionsRevoked });
  } catch (error) {
    return jsonServerFailure(request, "auth.password-change", error);
  }
}
