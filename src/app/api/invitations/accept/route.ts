import type { NextRequest } from "next/server";
import { tokenSchema } from "../../../../security/auth-schemas.ts";
import { hashOpaqueToken } from "../../../../security/tokens.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../server/auth.ts";
import { isTokenRateLimited } from "../../../../server/auth-rate-limit.ts";
import { withUserContext } from "../../../../server/db.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, tokenSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in with the invited email address to continue.");
    }
    const tokenHash = hashOpaqueToken(parsed.value.token);
    if (!tokenHash) {
      return jsonError(request, 400, "INVALID_INVITATION", "This invitation is invalid, expired, or already used.");
    }
    if (await isTokenRateLimited(request, "organization-invitation-token", tokenHash, 10, 900, 60)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "900" },
      );
    }

    const accepted = await withUserContext(principal.userId, async (transaction) => {
      const result = await transaction.query<{ accepted: boolean }>(
        "SELECT nexora.accept_organization_invitation($1) AS accepted",
        [tokenHash],
      );
      return result.rows[0]?.accepted === true;
    });
    if (!accepted) {
      return jsonError(request, 400, "INVALID_INVITATION", "This invitation is invalid, expired, or already used.");
    }
    return jsonOk(request, { accepted: true });
  } catch (error) {
    return jsonServerFailure(request, "invitations.accept", error);
  }
}
