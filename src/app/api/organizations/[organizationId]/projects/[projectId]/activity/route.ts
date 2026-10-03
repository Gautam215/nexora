import type { NextRequest } from "next/server";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../server/auth.ts";
import { withOrganizationContext } from "../../../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

interface ActivityEvent {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: Date;
  actor_name: string | null;
  target_name: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId } = await params;
    if (!UUID_PATTERN.test(projectId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project identifier is invalid.");
    }
    const limitValue = request.nextUrl.searchParams.get("limit") ?? "50";
    const offsetValue = request.nextUrl.searchParams.get("offset") ?? "0";
    if (!/^\d{1,3}$/.test(limitValue) || !/^\d{1,6}$/.test(offsetValue)) {
      return jsonError(request, 400, "INVALID_PAGINATION", "Use a page size from 1 to 100 and an offset up to 100000.");
    }
    const limit = Number(limitValue);
    const offset = Number(offsetValue);
    if (limit < 1 || limit > 100 || offset > 100_000) {
      return jsonError(request, 400, "INVALID_PAGINATION", "Use a page size from 1 to 100 and an offset up to 100000.");
    }

    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const access = await transaction.query<{ can_access: boolean }>(
          `SELECT nexora.can_access_current_project(project.organization_id, project.id) AS can_access
           FROM nexora.projects AS project
           WHERE project.organization_id = $1 AND project.id = $2`,
          [organizationId, projectId],
        );
        if (!access.rows[0]?.can_access) return null;

        const rows = await transaction.query<ActivityEvent>(
          `SELECT event.id,
                  event.action,
                  event.target_type,
                  event.target_id,
                  event.details,
                  event.created_at,
                  actor.display_name AS actor_name,
                  COALESCE(task.title, milestone.name, project_member.display_name) AS target_name
           FROM nexora.audit_events AS event
           LEFT JOIN LATERAL (
             SELECT member.display_name
             FROM nexora.list_current_project_members($1, $2) AS member
             WHERE member.user_id = event.actor_user_id
             LIMIT 1
           ) AS actor ON true
           LEFT JOIN nexora.tasks AS task
             ON event.target_type = 'task'
            AND task.organization_id = event.organization_id
            AND task.project_id = $2
            AND task.id = event.target_id
           LEFT JOIN nexora.milestones AS milestone
             ON event.target_type = 'milestone'
            AND milestone.organization_id = event.organization_id
            AND milestone.project_id = $2
            AND milestone.id = event.target_id
           LEFT JOIN LATERAL (
             SELECT member.display_name
             FROM nexora.list_current_project_members($1, $2) AS member
             WHERE event.target_type = 'project_membership'
               AND member.user_id = event.target_id
             LIMIT 1
           ) AS project_member ON true
           WHERE event.organization_id = $1
             AND (
               (event.target_type = 'project' AND event.target_id = $2)
               OR task.id IS NOT NULL
               OR milestone.id IS NOT NULL
               OR (event.target_type = 'project_membership' AND event.details->>'projectId' = $2::text)
             )
           ORDER BY event.created_at DESC, event.id DESC
           LIMIT $3 OFFSET $4`,
          [organizationId, projectId, limit + 1, offset],
        );
        return {
          events: rows.rows.slice(0, limit),
          pagination: { limit, offset, hasMore: rows.rows.length > limit },
        };
      },
      "guest",
    );

    if (!result) return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    return jsonOk(request, result);
  } catch (error) {
    return jsonServerFailure(request, "project-activity.list", error);
  }
}
