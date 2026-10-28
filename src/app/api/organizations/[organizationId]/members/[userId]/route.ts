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
import {
  getAuthPrincipal,
  shouldRevokeSessionsOnOrganizationChange,
} from "../../../../../../server/auth.ts";
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
        let sessionsRevoked = 0;
        if (
          shouldRevokeSessionsOnOrganizationChange(previous, {
            role: membership.role,
            status: membership.status,
          })
        ) {
          const revoked = await transaction.query<{ revoked_count: number }>(
            `SELECT nexora.revoke_user_sessions_for_org_privilege_change($1, $2) AS revoked_count`,
            [organizationId, userId],
          );
          sessionsRevoked = revoked.rows[0]?.revoked_count ?? 0;
        }
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
              sessionsRevoked,
            }),
          ],
        );
        return { ...membership, sessionsRevoked };
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

// Member removal (PRD 6): an owner/admin removes another member, or a
// member leaves on their own. Owners cannot be removed by anyone else;
// a sole owner cannot leave (the workspace would be orphaned).
//
// Removal is deliberately NOT a hard delete of the membership row. The
// schema anchors history to memberships with RESTRICT foreign keys:
// tasks created by the member, comments they authored, files they
// uploaded, and notifications all reference the membership row, and
// deleting it would either fail or rewrite history. So removal means:
// the member's tasks in this workspace become unassigned, their
// notification preferences and pending invitations are deleted, their
// sessions are revoked when someone else removes them (a voluntary
// leave keeps the leaver's sessions, since their other workspaces
// must keep working), and the membership itself moves
// to 'disabled', which the organization context already denies exactly
// like a non-member. Project membership rows stay as history anchors
// (assignee and mention references); they grant nothing once the org
// membership is disabled. Removal is reversible by reactivation, and
// the 'membership.removed' audit event distinguishes it from a plain
// disable.
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId, userId } = await params;
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(userId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Workspace or member identifier is invalid.");
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

    const removed = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        // Direct SELECTs on organization_memberships are RLS-restricted to
        // the caller's own row plus manager-visible rows, so a plain
        // member could never see the target. The SECURITY DEFINER member
        // list is the established read path for all members of the org.
        const members = await transaction.query<{ user_id: string; email: string; role: string; status: string }>(
          `SELECT user_id, email, role, status FROM nexora.list_current_organization_members($1)`,
          [organizationId],
        );
        const caller = members.rows.find(
          (entry) => entry.user_id === principal.userId && entry.status === "active",
        );
        if (!caller) return { kind: "forbidden" as const };
        const callerRole = caller.role;
        const target = members.rows.find((entry) => entry.user_id === userId);
        if (!target) return { kind: "not_found" as const };
        const selfRemoval = userId === principal.userId;
        if (selfRemoval) {
          if (target.role === "owner") {
            const otherOwners = await transaction.query<{ count: string }>(
              `SELECT pg_catalog.count(*)::text AS count
               FROM nexora.organization_memberships
               WHERE organization_id = $1 AND role = 'owner' AND user_id <> $2 AND status = 'active'`,
              [organizationId, userId],
            );
            if (Number(otherOwners.rows[0]?.count ?? 0) === 0) {
              return { kind: "last_owner" as const };
            }
          }
        } else {
          if (callerRole !== "owner" && callerRole !== "admin") {
            return { kind: "forbidden" as const };
          }
          if (target.role === "owner") return { kind: "forbidden" as const };
        }

        await transaction.query(
          `DELETE FROM nexora.notification_preferences
           WHERE organization_id = $1 AND user_id = $2`,
          [organizationId, userId],
        );
        // Only pending invitations are removed: accepted invitations are
        // history, and a pending token left behind would let a removed
        // member rejoin by accepting it. The email comes from the
        // SECURITY DEFINER member list above, not from nexora.users:
        // users RLS restricts reads to the caller's own row, so for an
        // admin removing another member that subquery returned no row
        // and the DELETE silently matched nothing.
        await transaction.query(
          `DELETE FROM nexora.organization_invitations
           WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
             AND email = $2`,
          [organizationId, target.email],
        );
        // Sessions are revoked only when someone else is removed: the
        // revoke function requires a manager caller and refuses owner
        // targets, so it cannot run for a voluntary leave. A leaver
        // keeps their sessions (their other workspaces must keep
        // working); org access is denied by the disabled membership
        // alone, which is the same guarantee disable already gives.
        let sessionsRevoked = 0;
        if (!selfRemoval && target.role !== "owner") {
          const revoked = await transaction.query<{ revoked_count: number }>(
            `SELECT nexora.revoke_user_sessions_for_org_privilege_change($1, $2) AS revoked_count`,
            [organizationId, userId],
          );
          sessionsRevoked = revoked.rows[0]?.revoked_count ?? 0;
        }
        // The audit row is written BEFORE the membership is disabled:
        // the audit INSERT policy requires an active membership, so
        // writing it after the disable would fail for a voluntary leave
        // (the actor's own membership just went inactive). The task
        // count is read here for the same reason; the removal function
        // below unassigns exactly these rows in the same transaction.
        const assignedCount = await transaction.query<{ count: string }>(
          `SELECT pg_catalog.count(*)::text AS count FROM nexora.tasks
           WHERE organization_id = $1 AND assignee_user_id = $2`,
          [organizationId, userId],
        );
        const tasksUnassigned = Number(assignedCount.rows[0]?.count ?? 0);
        const previousStatus = target.status;
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'membership.removed', 'membership', $4, $5::jsonb)`,
          [
            randomUUID(),
            organizationId,
            principal.userId,
            userId,
            JSON.stringify({
              role: target.role,
              previousStatus,
              status: "disabled",
              selfRemoved: selfRemoval,
              sessionsRevoked,
              tasksUnassigned,
            }),
          ],
        );
        // The member's tasks return to the pool, and the membership is
        // disabled, through the SECURITY DEFINER removal function
        // (migration 0056): there is no update-self RLS policy, so a
        // direct UPDATE would silently affect zero rows for a voluntary
        // leave, and a viewer could not unassign their own tasks.
        const applied = await transaction.query<{ tasks_unassigned: number; membership_disabled: boolean }>(
          `SELECT tasks_unassigned, membership_disabled
           FROM nexora.apply_organization_member_removal($1, $2)`,
          [organizationId, userId],
        );
        if (!applied.rows[0]?.membership_disabled) return { kind: "not_found" as const };
        return { kind: "removed" as const, sessionsRevoked, tasksUnassigned };
      },
      "guest",
    );
    if (removed.kind === "not_found") {
      return jsonError(request, 404, "MEMBER_NOT_FOUND", "Workspace member not found.");
    }
    if (removed.kind === "forbidden") {
      return jsonError(request, 403, "ORGANIZATION_ACCESS_DENIED", "You do not have permission to remove this member.");
    }
    if (removed.kind === "last_owner") {
      // No ownership-transfer route exists (role updates cannot set
      // owner), so deleting the workspace is the only way out for a
      // sole owner; do not point them at a transfer that does not exist.
      return jsonError(
        request,
        409,
        "LAST_OWNER",
        "Delete the workspace before leaving.",
      );
    }
    return jsonOk(request, { removed: true, userId, sessionsRevoked: removed.sessionsRevoked, tasksUnassigned: removed.tasksUnassigned });
  } catch (error) {
    return jsonServerFailure(request, "organizations.members.remove", error);
  }
}
