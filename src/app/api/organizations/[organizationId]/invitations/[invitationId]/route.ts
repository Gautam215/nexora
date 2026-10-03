import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
} from "../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; invitationId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId, invitationId } = await params;
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(invitationId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Workspace or invitation identifier is invalid.");
    }
    if (await isRateLimited(request, "organization-invite-user", principal.userId, 50, 3600, 80)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many membership changes. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }

    const revoked = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          `UPDATE nexora.organization_invitations
           SET revoked_at = pg_catalog.clock_timestamp()
           WHERE id = $1
             AND organization_id = $2
             AND accepted_at IS NULL
             AND revoked_at IS NULL
           RETURNING id`,
          [invitationId, organizationId],
        );
        if (!result.rows[0]) return false;
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id)
           VALUES ($1, $2, $3, 'invitation.revoked', 'invitation', $4)`,
          [randomUUID(), organizationId, principal.userId, invitationId],
        );
        return true;
      },
      "admin",
    );
    if (!revoked) {
      return jsonError(request, 404, "INVITATION_NOT_FOUND", "Pending invitation not found.");
    }
    return jsonOk(request, { revoked: true });
  } catch (error) {
    return jsonServerFailure(request, "organizations.invitation.revoke", error);
  }
}
