import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { projectMemberCreateSchema } from "../../../../../../../security/project-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../../server/db.ts";
import { notifyProjectMember, notifyProjectMembers } from "../../../../../../../server/project-notifications.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, projectMemberCreateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId, projectId } = await params;
    if (!UUID_PATTERN.test(projectId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project identifier is invalid.");
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
        if (!project.rows[0]) return { kind: "not_found" as const };

        const manager = await transaction.query<{ can_manage: boolean }>(
          "SELECT nexora.can_manage_current_project($1, $2) AS can_manage",
          [organizationId, projectId],
        );
        if (manager.rows[0]?.can_manage !== true) return { kind: "forbidden" as const };

        const activeMember = await transaction.query<{ active: boolean }>(
          "SELECT nexora.is_active_organization_member($1, $2) AS active",
          [organizationId, parsed.value.userId],
        );
        if (activeMember.rows[0]?.active !== true) return { kind: "not_org_member" as const };

        const inserted = await transaction.query(
          `INSERT INTO nexora.project_memberships
             (organization_id, project_id, user_id, role, status, added_by_user_id)
           VALUES ($1, $2, $3, $4::nexora.project_role, 'active', $5)
           ON CONFLICT (organization_id, project_id, user_id) DO NOTHING
           RETURNING user_id`,
          [organizationId, projectId, parsed.value.userId, parsed.value.role, principal.userId],
        );
        if (!inserted.rowCount) return { kind: "already_member" as const };

        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'project.member.added', 'project_membership', $4, $5::jsonb)`,
          [
            auditId,
            organizationId,
            principal.userId,
            parsed.value.userId,
            JSON.stringify({ projectId, role: parsed.value.role }),
          ],
        );
        await notifyProjectMember(transaction, {
          organizationId,
          projectId,
          recipientUserId: parsed.value.userId,
          actorUserId: principal.userId,
          eventType: "project_activity",
          targetType: "project_membership",
          targetId: parsed.value.userId,
          dedupeKey: `project-member-added:${auditId}:${parsed.value.userId}`,
          title: "You were added to a project",
          body: `You now have ${parsed.value.role} access to a project.`,
        });
        await notifyProjectMembers(transaction, {
          organizationId,
          projectId,
          actorUserId: principal.userId,
          eventId: auditId,
          targetType: "project_membership",
          targetId: parsed.value.userId,
          title: "Project membership changed",
          body: "A new member was added to the project.",
          excludedUserIds: [parsed.value.userId],
        });
        return { kind: "created" as const };
      },
      "guest",
    );

    if (result.kind === "not_found") {
      return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }
    if (result.kind === "forbidden") {
      return jsonError(request, 403, "PROJECT_MANAGEMENT_REQUIRED", "You do not have permission to manage this project's members.");
    }
    if (result.kind === "not_org_member") {
      return jsonError(request, 409, "ACTIVE_ORGANIZATION_MEMBER_REQUIRED", "Only active workspace members can be added to a project.");
    }
    if (result.kind === "already_member") {
      return jsonError(request, 409, "PROJECT_MEMBER_EXISTS", "That person is already assigned to this project.");
    }
    return jsonOk(request, { membership: { userId: parsed.value.userId, role: parsed.value.role, status: "active" } }, 201);
  } catch (error) {
    return jsonServerFailure(request, "projects.members.add", error);
  }
}
