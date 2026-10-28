import type { NextRequest } from "next/server";
import { accountDeletionSchema } from "../../../security/auth-schemas.ts";
import {
  clearSessionCookie,
  getAuthenticatedUser,
  getAuthPrincipal,
} from "../../../server/auth.ts";
import { isRateLimited } from "../../../server/auth-rate-limit.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../server/api.ts";
import { withUserContext } from "../../../server/db.ts";

export const runtime = "nodejs";

// DELETE /api/account — delete the caller's own account. The request
// body must carry the account's email as typed confirmation, mirroring
// the workspace-deletion slug confirmation. The SECURITY DEFINER
// helper scrubs the user row (it never hard-deletes it, because the
// row anchors history), disables every workspace membership, revokes
// every session, and blocks deletion while the caller is the sole
// owner of an active workspace. After a successful deletion the
// session cookie is cleared: the account is gone and the next request
// is unauthenticated.
export async function DELETE(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, accountDeletionSchema);
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
    if (await isRateLimited(request, "account-deletion-user", principal.userId, 5, 3600, 30)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }
    if (parsed.value.confirmation !== user.email) {
      return jsonError(
        request,
        409,
        "ACCOUNT_EMAIL_MISMATCH",
        "The confirmation email does not match this account.",
      );
    }

    const result = await withUserContext(principal.userId, async (transaction) => {
      const deleted = await transaction.query<{
        deleted: boolean;
        sole_owner_slugs: string[] | null;
      }>("SELECT * FROM nexora.delete_user_account($1)", [principal.userId]);
      return deleted.rows[0] ?? null;
    });
    if (!result || !result.deleted) {
      return jsonError(
        request,
        409,
        "ACCOUNT_SOLE_OWNER",
        "Delete these workspaces first: " +
          (result?.sole_owner_slugs ?? []).join(", "),
      );
    }

    const response = jsonOk(request, { deleted: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    return jsonServerFailure(request, "account.delete", error);
  }
}
