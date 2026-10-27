import type { NextRequest } from "next/server";
import { NOTIFICATION_EVENT_TYPES, notificationPreferencesSchema } from "../../../../../../security/notification-schemas.ts";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure, parseJson } from "../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../server/auth.ts";
import { withOrganizationContext } from "../../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId } = await params;
    const preferences = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const result = await transaction.query<{ event_type: string; in_app_enabled: boolean; email_enabled: boolean }>(
          `SELECT event_type, in_app_enabled, email_enabled
           FROM nexora.notification_preferences
           WHERE organization_id = $1 AND user_id = $2`,
          [organizationId, principal.userId],
        );
        const saved = new Map(result.rows.map((row) => [row.event_type, row]));
        return NOTIFICATION_EVENT_TYPES.map((eventType) => ({
          eventType,
          inAppEnabled: saved.get(eventType)?.in_app_enabled ?? true,
          emailEnabled: saved.get(eventType)?.email_enabled ?? false,
        }));
      },
      "guest",
    );
    return jsonOk(request, { preferences });
  } catch (error) {
    return jsonServerFailure(request, "notification-preferences.get", error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, notificationPreferencesSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId } = await params;
    const preferences = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        for (const preference of parsed.value.preferences) {
          // emailEnabled is optional in the request: omitting it
          // leaves the stored email preference unchanged, so an
          // in-app-only update never silently turns email on or off.
          if (preference.emailEnabled === undefined) {
            await transaction.query(
              `INSERT INTO nexora.notification_preferences
                 (organization_id, user_id, event_type, in_app_enabled)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (organization_id, user_id, event_type)
               DO UPDATE SET in_app_enabled = EXCLUDED.in_app_enabled,
                             updated_at = pg_catalog.clock_timestamp()`,
              [organizationId, principal.userId, preference.eventType, preference.inAppEnabled],
            );
          } else {
            await transaction.query(
              `INSERT INTO nexora.notification_preferences
                 (organization_id, user_id, event_type, in_app_enabled, email_enabled)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (organization_id, user_id, event_type)
               DO UPDATE SET in_app_enabled = EXCLUDED.in_app_enabled,
                             email_enabled = EXCLUDED.email_enabled,
                             updated_at = pg_catalog.clock_timestamp()`,
              [organizationId, principal.userId, preference.eventType, preference.inAppEnabled, preference.emailEnabled],
            );
          }
        }
        const result = await transaction.query<{ event_type: string; in_app_enabled: boolean; email_enabled: boolean }>(
          `SELECT event_type, in_app_enabled, email_enabled
           FROM nexora.notification_preferences
           WHERE organization_id = $1 AND user_id = $2`,
          [organizationId, principal.userId],
        );
        const saved = new Map(result.rows.map((row) => [row.event_type, row]));
        return NOTIFICATION_EVENT_TYPES.map((eventType) => ({
          eventType,
          inAppEnabled: saved.get(eventType)?.in_app_enabled ?? true,
          emailEnabled: saved.get(eventType)?.email_enabled ?? false,
        }));
      },
      "guest",
    );
    return jsonOk(request, { preferences });
  } catch (error) {
    return jsonServerFailure(request, "notification-preferences.update", error);
  }
}
