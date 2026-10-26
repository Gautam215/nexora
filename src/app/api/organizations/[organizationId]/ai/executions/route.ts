import type { NextRequest } from "next/server";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../server/auth.ts";
import { withOrganizationContext } from "../../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

// The caller's own AI execution records in this organization, newest
// first. Metadata only — prompts and responses are never stored (see
// migration 0034), so there is no content to leak here. RLS restricts
// the query to the caller's own rows in the current organization.
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    const executions = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const result = await transaction.query<{
          id: string;
          project_id: string | null;
          workflow: string;
          provider: string;
          model: string;
          status: string;
          prompt_tokens: number | null;
          completion_tokens: number | null;
          latency_ms: number | null;
          error_code: string | null;
          created_at: string;
          completed_at: string | null;
        }>(
          `SELECT id, project_id, workflow, provider, model, status,
                  prompt_tokens, completion_tokens, latency_ms, error_code,
                  created_at, completed_at
           FROM nexora.ai_executions
           WHERE organization_id = $1 AND user_id = $2
           ORDER BY created_at DESC, id DESC LIMIT 50`,
          [organizationId, principal.userId],
        );
        return result.rows;
      },
    );
    return jsonOk(request, { executions });
  } catch (error) {
    return jsonServerFailure(request, "ai.executions.list", error);
  }
}
