import type { NextRequest } from "next/server";
import { loginSchema } from "../../../../security/auth-schemas.ts";
import { verifyPassword } from "../../../../security/password.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../server/api.ts";
import { createSession, setSessionCookie } from "../../../../server/auth.ts";
import { isRateLimited } from "../../../../server/auth-rate-limit.ts";
import { lookupLoginAccount } from "../../../../server/db.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, loginSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const { email, password } = parsed.value;
    if (await isRateLimited(request, "login-email", email, 10, 900, 60)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "900" },
      );
    }

    const account = await lookupLoginAccount(email);
    const passwordMatches = await verifyPassword(password, account?.password_hash);
    if (
      !account ||
      account.status !== "active" ||
      !account.email_verified_at ||
      !passwordMatches
    ) {
      return jsonError(
        request,
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect. Confirm your email if you have not already.",
      );
    }

    const session = await createSession(account.user_id);
    const response = jsonOk(request, {
      user: {
        id: account.user_id,
        email: account.email,
        displayName: account.display_name,
      },
    });
    setSessionCookie(response, session);
    return response;
  } catch (error) {
    return jsonServerFailure(request, "auth.login", error);
  }
}
