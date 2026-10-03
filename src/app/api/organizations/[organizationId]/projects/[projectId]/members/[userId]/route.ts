import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { projectMemberUpdateSchema } from "../../../../../../../../security/project-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../../../server/db.ts";
import { notifyProjectMember, notifyProjectMembers } from "../../../../../../../../server/project-notifications.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string; userId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, projectMemberUpdateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId, projectId, userId } = await params;
    if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(userId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project or member identifier is invalid.");
    }
    if (userId === principal.userId) {
      return jsonError(request, 409, "SELF_CHANGE_UNAVAILABLE", "You cannot change your own project access here.");
    }
    if (await isRateLimited(request, "project-management-user", principal.userId, 40, 3600, 80)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many project changes. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }

    const auditId = randomUUID();
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const project = await transaction.query<{ id: string }>(
          "SELECT id FROM nexora.projects WHERE organization_id = $1 AND id = $2",
          [organizationId, projectId],
        );
        if (!project.rows[0]) return { kind: "project_not_found" as const };

        const manager = await transaction.query<{ can_manage: boolean }>(
          "SELECT nexora.can_manage_current_project($1, $2) AS can_manage",
          [organizationId, projectId],
        );
        if (manager.rows[0]?.can_manage !== true) return { kind: "forbidden" as const };

        const owner = await transaction.query<{ is_owner: boolean }>(
          "SELECT nexora.is_project_owner($1, $2, $3) AS is_owner",
          [organizationId, projectId, userId],
        );
        if (owner.rows[0]?.is_owner === true) return { kind: "owner_protected" as const };

        const previousResult = await transaction.query<{ role: string; status: string }>(
          `SELECT role::text AS role, status::text AS status
           FROM nexora.project_memberships
           WHERE organization_id = $1 AND project_id = $2 AND user_id = $3
           LIMIT 1`,
          [organizationId, projectId, userId],
        );
        const previous = previousResult.rows[0];
        if (!previous) return { kind: "member_not_found" as const };

        const activeMember = await transaction.query<{ active: boolean }>(
          "SELECT nexora.is_active_organization_member($1, $2) AS active",
          [organizationId, userId],
        );
        if (activeMember.rows[0]?.active !== true) return { kind: "org_member_inactive" as const };

        const role = parsed.value.role ?? previous.role;
        const status = parsed.value.status ?? previous.status;
        if (role === previous.role && status === previous.status) {
          return { kind: "updated" as const, membership: { role, status } };
        }

        const updated = await transaction.query<{ role: string; status: string }>(
          `UPDATE nexora.project_memberships
           SET role = $1::nexora.project_role,
               status = $2::nexora.project_membership_status
           WHERE organization_id = $3 AND project_id = $4 AND user_id = $5
           RETURNING role::text AS role, status::text AS status`,
          [role, status, organizationId, projectId, userId],
        );
        const membership = updated.rows[0];
        if (!membership) return { kind: "member_not_found" as const };
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'project.member.updated', 'project_membership', $4, $5::jsonb)`,
          [
            auditId,
            organizationId,
            principal.userId,
            userId,
            JSON.stringify({
              projectId,
              previousRole: previous.role,
              role: membership.role,
              previousStatus: previous.status,
              status: membership.status,
            }),
          ],
        );
        if (membership.status === "active") {
          await notifyProjectMember(transaction, {
            organizationId,
            projectId,
            recipientUserId: userId,
            actorUserId: principal.userId,
            eventType: "project_activity",
            targetType: "project_membership",
            targetId: userId,
            dedupeKey: `project-member-updated:${auditId}:${userId}`,
            title: "Your project access changed",
            body: `Your project role is now ${membership.role}.`,
          });
        }
        await notifyProjectMembers(transaction, {
          organizationId,
          projectId,
          actorUserId: principal.userId,
          eventId: auditId,
          targetType: "project_membership",
          targetId: userId,
          title: "Project access changed",
          body: "A team member's project access was updated.",
          excludedUserIds: [userId],
        });
        return { kind: "updated" as const, membership };
      },
      "guest",
    );

    if (result.kind === "project_not_found") {
      return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }
    if (result.kind === "forbidden") {
      return jsonError(request, 403, "PROJECT_MANAGEMENT_REQUIRED", "You do not have permission to manage this project's members.");
    }
    if (result.kind === "owner_protected") {
      return jsonError(request, 409, "PROJECT_OWNER_PROTECTED", "The project owner cannot be changed here.");
    }
    if (result.kind === "member_not_found") {
      return jsonError(request, 404, "PROJECT_MEMBER_NOT_FOUND", "Project member not found.");
    }
    if (result.kind === "org_member_inactive") {
      return jsonError(request, 409, "ACTIVE_ORGANIZATION_MEMBER_REQUIRED", "Only active workspace members can be assigned to a project.");
    }
    return jsonOk(request, { membership: { userId, ...result.membership } });
  } catch (error) {
    return jsonServerFailure(request, "projects.members.update", error);
  }
}
