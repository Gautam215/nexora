import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure } from "../../../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../../../server/auth.ts";
import { withOrganizationContext } from "../../../../../../../../../../server/db.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string; taskId: string; commentId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE a task comment. Comments are append-only by design, so
// this is a soft delete: the row stays (mentions and the
// comment.created event history keep working) and the list and
// search queries filter it out. Only the comment's author or a
// project manager may delete it; the SECURITY DEFINER helper
// enforces that and sets deleted_at and nothing else. An
// already-deleted or nonexistent comment answers 404, and a
// non-author non-manager answers 403.
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId, projectId, taskId, commentId } = await params;
    if (![projectId, taskId, commentId].every((value) => UUID_PATTERN.test(value))) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Comment identifier is invalid.");
    }

    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const project = await transaction.query<{ can_access: boolean }>(
          `SELECT nexora.can_access_current_project(project.organization_id, project.id) AS can_access
           FROM nexora.projects AS project
           WHERE project.organization_id = $1 AND project.id = $2 AND project.deleted_at IS NULL`,
          [organizationId, projectId],
        );
        if (!project.rows[0]?.can_access) return null;

        const task = await transaction.query(
          `SELECT id FROM nexora.tasks
           WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
          [organizationId, projectId, taskId],
        );
        if (!task.rowCount) return null;

        const deleted = await transaction.query<{ delete_task_comment: boolean }>(
          "SELECT nexora.delete_task_comment($1, $2, $3, $4) AS delete_task_comment",
          [organizationId, projectId, taskId, commentId],
        );
        if (!deleted.rows[0]?.delete_task_comment) return false;

        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'comment.deleted', 'task_comment', $4,
                   pg_catalog.jsonb_build_object('taskId', $5::text))`,
          [randomUUID(), organizationId, principal.userId, commentId, taskId],
        );
        return true;
      },
      "guest",
    );

    if (result === null) {
      return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
    }
    if (result === false) {
      return jsonError(request, 404, "COMMENT_NOT_FOUND", "Comment not found.");
    }
    return jsonOk(request, { deleted: true, commentId });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "42501") {
      return jsonError(request, 403, "COMMENT_DELETE_NOT_ALLOWED", "Only the comment author or a project manager may delete a comment.");
    }
    return jsonServerFailure(request, "task-comments.delete", error);
  }
}
