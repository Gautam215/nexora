import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { membershipUpdateSchema } from "../../../../../../security/auth-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; userId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, membershipUpdateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId, userId } = await params;
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(userId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Workspace or member identifier is invalid.");
    }
    if (userId === principal.userId) {
      return jsonError(request, 409, "SELF_CHANGE_UNAVAILABLE", "You cannot change your own workspace membership here.");
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

    const updated = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const previousResult = await transaction.query<{ role: string; status: string }>(
          `SELECT role::text AS role, status::text AS status
           FROM nexora.organization_memberships
           WHERE organization_id = $1 AND user_id = $2 AND role <> 'owner'
           LIMIT 1`,
          [organizationId, userId],
        );
        const previous = previousResult.rows[0];
        if (!previous) return null;

        const role = parsed.value.role ?? previous.role;
        const status = parsed.value.status ?? previous.status;
        if (role === previous.role && status === previous.status) return { role, status };

        const result = await transaction.query<{ role: string; status: string }>(
          `UPDATE nexora.organization_memberships
           SET role = $1::nexora.organization_role,
               status = $2::nexora.membership_status
           WHERE organization_id = $3 AND user_id = $4 AND role <> 'owner'
           RETURNING role::text AS role, status::text AS status`,
          [role, status, organizationId, userId],
        );
        const membership = result.rows[0];
        if (!membership) return null;
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'membership.updated', 'membership', $4, $5::jsonb)`,
          [
            randomUUID(),
            organizationId,
            principal.userId,
            userId,
            JSON.stringify({
              previousRole: previous.role,
              role: membership.role,
              previousStatus: previous.status,
              status: membership.status,
            }),
          ],
        );
        return membership;
      },
      "admin",
    );
    if (!updated) {
      return jsonError(request, 404, "MEMBER_NOT_FOUND", "Workspace member not found.");
    }
    return jsonOk(request, { membership: { userId, ...updated } });
  } catch (error) {
    return jsonServerFailure(request, "organizations.members.update", error);
  }
}
