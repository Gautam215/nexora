import type { NextRequest } from "next/server";
import { totpVerifySchema } from "../../../../../security/auth-schemas.ts";
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
import {
  createTotpSetup,
  getTotpEnrolled,
  verifyTotpForDelete,
} from "../../../../../server/totp.ts";
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
//
// Re-enrollment guard: when the caller already has a verified
// authenticator, starting a new setup would replace that row with
// a pending one (verified_at NULL), silently unenrolling the
// second factor — so a session holder who also knows the password
// could strip the factor and then delete the account on password
// alone. An enrolled caller must therefore prove the CURRENT
// authenticator code first (body { code }); a body without a valid
// code is rejected (400 for a missing code, 415 with no JSON body),
// a wrong code is a 401, and only a valid code opens setup.
// An unenrolled caller enrolls bodyless, exactly as before.
// Enrolled callers who lost the authenticator re-enroll via
// disable (password + current code) followed by a fresh setup.
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
    const enrolled = await withUserContext(principal.userId, async (transaction) => {
      return getTotpEnrolled(transaction, principal.userId);
    });
    if (enrolled) {
      const parsed = await parseJson(request, totpVerifySchema);
      if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);
      const checked = await withUserContext(principal.userId, async (transaction) => {
        return verifyTotpForDelete(transaction, principal.userId, parsed.value.code, Date.now());
      });
      // "valid" proceeds; "not-enrolled" means the factor was
      // disabled between the check and this verification, so the
      // caller is unenrolled by now and proceeding is safe.
      if (checked === "invalid") {
        return jsonError(request, 401, "INVALID_CREDENTIALS", "The authenticator code is incorrect.");
      }
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
