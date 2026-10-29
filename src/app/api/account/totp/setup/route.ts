import type { NextRequest } from "next/server";
import { getAuthPrincipal, getAuthenticatedUser } from "../../../../../server/auth.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
} from "../../../../../server/api.ts";
import { isRateLimited } from "../../../../../server/auth-rate-limit.ts";
import { withUserContext } from "../../../../../server/db.ts";
import { createTotpSetup } from "../../../../../server/totp.ts";
import {
  encryptTotpSecret,
  generateTotpSecret,
  TotpConfigurationError,
  totpSetupUrl,
} from "../../../../../security/totp.ts";

export const runtime = "nodejs";

// POST /api/account/totp/setup — start authenticator enrollment.
// Generates a fresh secret, stores only its encrypted form as a
// pending row (verified_at NULL), and returns the manual setup key
// plus the otpauth:// URL once. Nothing is enrolled until the
// caller proves possession via /verify, so a generated-but-never
// proven secret can never gate deletion.
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
    if (await isRateLimited(request, "totp-verify-user", principal.userId, 10, 3600, 30)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    await withUserContext(principal.userId, async (transaction) => {
      await createTotpSetup(transaction, principal.userId, encrypted);
    });
    return jsonOk(request, {
      setup: { secret, otpauthUrl: totpSetupUrl(secret, user.email) },
    });
  } catch (error) {
    if (error instanceof TotpConfigurationError) {
      return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Two-factor authentication is not configured.");
    }
    return jsonServerFailure(request, "account.totp.setup", error);
  }
}
