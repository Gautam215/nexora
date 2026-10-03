import type { NextRequest } from "next/server";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../server/auth.ts";
import { withOrganizationContext } from "../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

interface NotificationRow {
  id: string;
  project_id: string;
  event_type: string;
  target_type: string;
  target_id: string;
  title: string;
  body: string;
  href: string;
  created_at: Date;
  read_at: Date | null;
  project_name: string;
  actor_name: string | null;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId } = await params;
    const limitValue = request.nextUrl.searchParams.get("limit") ?? "50";
    const offsetValue = request.nextUrl.searchParams.get("offset") ?? "0";
    const unreadOnlyValue = request.nextUrl.searchParams.get("unreadOnly") ?? "false";
    if (!/^\d{1,3}$/.test(limitValue) || !/^\d{1,6}$/.test(offsetValue) || !["true", "false"].includes(unreadOnlyValue)) {
      return jsonError(request, 400, "INVALID_PAGINATION", "Notification filters are invalid.");
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
        const unread = await transaction.query<{ unread_count: number }>(
          `SELECT count(*)::integer AS unread_count
           FROM nexora.notifications
           WHERE organization_id = $1 AND recipient_user_id = $2 AND read_at IS NULL`,
          [organizationId, principal.userId],
        );
        const rows = await transaction.query<NotificationRow>(
          `SELECT notification.id,
                  notification.project_id,
                  notification.event_type,
                  notification.target_type,
                  notification.target_id,
                  notification.title,
                  notification.body,
                  notification.href,
                  notification.created_at,
                  notification.read_at,
                  project.name AS project_name,
                  actor.display_name AS actor_name
           FROM nexora.notifications AS notification
           JOIN nexora.projects AS project
             ON project.organization_id = notification.organization_id
            AND project.id = notification.project_id
           LEFT JOIN LATERAL (
             SELECT member.display_name
             FROM nexora.list_current_project_members(notification.organization_id, notification.project_id) AS member
             WHERE member.user_id = notification.actor_user_id
             LIMIT 1
           ) AS actor ON true
           WHERE notification.organization_id = $1
             AND notification.recipient_user_id = $2
             AND ($3::boolean = false OR notification.read_at IS NULL)
           ORDER BY notification.created_at DESC, notification.id DESC
           LIMIT $4 OFFSET $5`,
          [organizationId, principal.userId, unreadOnlyValue === "true", limit + 1, offset],
        );
        return {
          notifications: rows.rows.slice(0, limit),
          unreadCount: unread.rows[0]?.unread_count ?? 0,
          pagination: { limit, offset, hasMore: rows.rows.length > limit },
        };
      },
      "guest",
    );
    return jsonOk(request, result);
  } catch (error) {
    return jsonServerFailure(request, "notifications.list", error);
  }
}
