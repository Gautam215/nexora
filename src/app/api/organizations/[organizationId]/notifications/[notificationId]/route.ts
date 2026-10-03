import type { NextRequest } from "next/server";
import { notificationReadSchema } from "../../../../../../security/notification-schemas.ts";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure, parseJson } from "../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../server/auth.ts";
import { withOrganizationContext } from "../../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; notificationId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, notificationReadSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, notificationId } = await params;
    if (!UUID_PATTERN.test(notificationId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Notification identifier is invalid.");
    }
    const notification = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const result = await transaction.query<{ id: string; read_at: Date | null }>(
          `UPDATE nexora.notifications
           SET read_at = CASE WHEN $1 THEN COALESCE(read_at, pg_catalog.clock_timestamp()) ELSE NULL END
           WHERE organization_id = $2 AND recipient_user_id = $3 AND id = $4
           RETURNING id, read_at`,
          [parsed.value.read, organizationId, principal.userId, notificationId],
        );
        return result.rows[0] ?? null;
      },
      "guest",
    );
    if (!notification) return jsonError(request, 404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
    return jsonOk(request, { notification });
  } catch (error) {
    return jsonServerFailure(request, "notifications.update", error);
  }
}
