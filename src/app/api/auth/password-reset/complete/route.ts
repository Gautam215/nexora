import type { NextRequest } from "next/server";
import { resetPasswordSchema } from "../../../../../security/auth-schemas.ts";
import { hashPassword } from "../../../../../security/password.ts";
import { hashOpaqueToken } from "../../../../../security/tokens.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../server/api.ts";
import {
  clearSessionCookie,
} from "../../../../../server/auth.ts";
import { isTokenRateLimited } from "../../../../../server/auth-rate-limit.ts";
import { consumePasswordReset } from "../../../../../server/db.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, resetPasswordSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const tokenHash = hashOpaqueToken(parsed.value.token);
    if (!tokenHash) {
      return jsonError(request, 400, "INVALID_LINK", "This reset link is invalid or expired.");
    }
    if (await isTokenRateLimited(request, "password-reset-token", tokenHash, 10, 900, 60)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "900" },
      );
    }

    const passwordHash = await hashPassword(parsed.value.password);
    if (!(await consumePasswordReset(tokenHash, passwordHash))) {
      return jsonError(request, 400, "INVALID_LINK", "This reset link is invalid or expired.");
    }
    const response = jsonOk(request, { passwordUpdated: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    return jsonServerFailure(request, "auth.password-reset.complete", error);
  }
}
