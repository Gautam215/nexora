import type { NextRequest } from "next/server";
import { tokenSchema } from "../../../../../security/auth-schemas.ts";
import { hashOpaqueToken } from "../../../../../security/tokens.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../server/api.ts";
import { isTokenRateLimited } from "../../../../../server/auth-rate-limit.ts";
import { consumeEmailVerification } from "../../../../../server/db.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, tokenSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const tokenHash = hashOpaqueToken(parsed.value.token);
    if (!tokenHash) {
      return jsonError(request, 400, "INVALID_LINK", "This confirmation link is invalid or expired.");
    }
    if (await isTokenRateLimited(request, "verify-token", tokenHash, 10, 900, 60)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "900" },
      );
    }
    if (!(await consumeEmailVerification(tokenHash))) {
      return jsonError(request, 400, "INVALID_LINK", "This confirmation link is invalid or expired.");
    }
    return jsonOk(request, { verified: true });
  } catch (error) {
    return jsonServerFailure(request, "auth.verification.consume", error);
  }
}
