import type { NextRequest } from "next/server";
import { getAuthPrincipal } from "../../../../server/auth.ts";
import { isRateLimited } from "../../../../server/auth-rate-limit.ts";
import {
  jsonError,
  jsonOk,
  jsonServerFailure,
} from "../../../../server/api.ts";
import { withUserContext } from "../../../../server/db.ts";

export const runtime = "nodejs";

// GET /api/account/export — the caller's own data across all
// workspaces, as one JSON document. File entries are metadata only
// (no storage key, no download link) and AI execution entries are
// metadata only (prompts and responses are never stored). The
// SECURITY DEFINER export function guards itself to the caller, so
// no other user's data can leak through this route.
export async function GET(request: NextRequest) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    if (await isRateLimited(request, "account-export-user", principal.userId, 40, 3600, 80)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }

    const result = await withUserContext(principal.userId, async (transaction) => {
      const exported = await transaction.query<{ export_data: unknown }>(
        "SELECT nexora.export_user_data($1) AS export_data",
        [principal.userId],
      );
      return exported.rows[0]?.export_data ?? null;
    });
    if (result === null) {
      return jsonError(request, 404, "ACCOUNT_NOT_FOUND", "Account not found.");
    }
    return jsonOk(request, { export: result, exportedAt: new Date().toISOString() });
  } catch (error) {
    return jsonServerFailure(request, "account.export", error);
  }
}
