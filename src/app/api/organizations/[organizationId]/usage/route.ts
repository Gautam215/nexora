import type { NextRequest } from "next/server";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../server/auth.ts";
import { withOrganizationContext } from "../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

// Organization usage (PRD 40: cost tracking beyond the quota/usage
// fields on the organization). Read-only. Storage bytes, file count,
// and quota come from task_files and the organization row; AI token
// usage comes from succeeded ai_executions rows, per workflow, for
// all time and for the last 30 days. Because ai_executions rows are
// RLS-restricted to the caller's own rows, the org-wide aggregate
// comes from nexora.organization_usage_summary(), a SECURITY
// DEFINER function that itself refuses non-owners/admins; the route
// checks the role first for proper error semantics.
//
// Owner/admin only: usage and cost data is operational, not member
// data. Non-members are rejected by the organization context (403);
// members without owner/admin role get 403
// ORGANIZATION_MANAGEMENT_REQUIRED, mirroring workspace settings.
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const memberResult = await transaction.query<{ user_id: string; role: string }>(
          `SELECT user_id, role::text AS role FROM nexora.list_current_organization_members($1)`,
          [organizationId],
        );
        const viewerRole = memberResult.rows.find(
          (member) => member.user_id === principal.userId,
        )?.role;
        if (viewerRole !== "owner" && viewerRole !== "admin") {
          return { kind: "forbidden" as const };
        }
        const summaryResult = await transaction.query<{ organization_usage_summary: unknown }>(
          `SELECT nexora.organization_usage_summary($1, $2) AS organization_usage_summary`,
          [organizationId, principal.userId],
        );
        return {
          kind: "ok" as const,
          summary: summaryResult.rows[0]?.organization_usage_summary as
            | { forbidden?: boolean; storage?: unknown; ai?: unknown }
            | undefined,
        };
      },
    );
    if (result.kind === "forbidden") {
      return jsonError(
        request,
        403,
        "ORGANIZATION_MANAGEMENT_REQUIRED",
        "Only workspace owners and admins can view workspace usage.",
      );
    }
    if (!result.summary || result.summary.forbidden === true) {
      return jsonError(
        request,
        403,
        "ORGANIZATION_MANAGEMENT_REQUIRED",
        "Only workspace owners and admins can view workspace usage.",
      );
    }
    return jsonOk(request, { usage: result.summary });
  } catch (error) {
    return jsonServerFailure(request, "organizations.usage", error);
  }
}
