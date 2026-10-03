import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { taskBulkUpdateSchema } from "../../../../../../../../security/task-workflow-schemas.ts";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure, parseJson } from "../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../../../server/db.ts";
import { notifyProjectMembers } from "../../../../../../../../server/project-notifications.ts";
import { lockProjectForWork, readProjectTask } from "../../../../../../../../server/project-work.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

interface SelectedTask {
  id: string;
  version: number;
  priority: string;
  archived_at: Date | null;
  milestone_status: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, taskBulkUpdateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId } = await params;
    if (!UUID_PATTERN.test(projectId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project identifier is invalid.");
    }
    if (await isRateLimited(request, "project-management-user", principal.userId, 40, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many project changes. Wait before trying again.", { "retry-after": "3600" });
    }

    const auditIds = parsed.value.tasks.map(() => randomUUID());
    const notificationEventId = randomUUID();
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        await lockProjectForWork(transaction, organizationId, projectId);
        const access = await transaction.query<{ status: string; can_work: boolean }>(
          `SELECT project.status::text AS status,
                  nexora.can_work_current_project(project.organization_id, project.id) AS can_work
           FROM nexora.projects AS project
           WHERE project.organization_id = $1 AND project.id = $2`,
          [organizationId, projectId],
        );
        if (!access.rows[0]) return { kind: "not_found" as const };
        if (!access.rows[0].can_work) return { kind: "forbidden" as const };
        if (["completed", "archived"].includes(access.rows[0].status)) return { kind: "project_closed" as const };

        const selected = await transaction.query<SelectedTask>(
          `SELECT task.id,
                  task.version,
                  task.priority::text AS priority,
                  task.archived_at,
                  milestone.status::text AS milestone_status
           FROM nexora.tasks AS task
           LEFT JOIN nexora.milestones AS milestone
             ON milestone.organization_id = task.organization_id
            AND milestone.project_id = task.project_id
            AND milestone.id = task.milestone_id
           WHERE task.organization_id = $1 AND task.project_id = $2
             AND task.id = ANY($3::uuid[])
           ORDER BY task.id
           FOR UPDATE OF task`,
          [organizationId, projectId, parsed.value.tasks.map((task) => task.id)],
        );
        if (selected.rows.length !== parsed.value.tasks.length) return { kind: "not_found" as const };
        const requested = new Map(parsed.value.tasks.map((task) => [task.id, task.expectedVersion]));
        if (selected.rows.some((task) => task.version !== requested.get(task.id))) {
          return { kind: "conflict" as const };
        }
        if (selected.rows.some((task) => task.archived_at)) return { kind: "archived" as const };
        if (selected.rows.some((task) => task.milestone_status === "completed")) {
          return { kind: "milestone_closed" as const };
        }

        const updatedTaskIds: string[] = [];
        for (const [index, task] of selected.rows.entries()) {
          if (task.priority === parsed.value.priority) continue;
          await transaction.query(
            `UPDATE nexora.tasks SET priority = $1::nexora.task_priority
             WHERE organization_id = $2 AND project_id = $3 AND id = $4 AND version = $5`,
            [parsed.value.priority, organizationId, projectId, task.id, task.version],
          );
          await transaction.query(
            `INSERT INTO nexora.audit_events
               (id, organization_id, actor_user_id, action, target_type, target_id, details)
             VALUES ($1, $2, $3, 'task.updated', 'task', $4, $5::jsonb)`,
            [
              auditIds[index],
              organizationId,
              principal.userId,
              task.id,
              JSON.stringify({
                changedFields: ["priority"],
                previousPriority: task.priority,
                priority: parsed.value.priority,
                previousVersion: task.version,
                version: task.version + 1,
                bulk: true,
              }),
            ],
          );
          updatedTaskIds.push(task.id);
        }
        if (updatedTaskIds.length) {
          await notifyProjectMembers(transaction, {
            organizationId,
            projectId,
            actorUserId: principal.userId,
            eventId: notificationEventId,
            targetType: "task",
            targetId: updatedTaskIds[0]!,
            title: "Tasks updated",
            body: `Priority changed for ${updatedTaskIds.length} task${updatedTaskIds.length === 1 ? "" : "s"}.`,
          });
        }

        const tasks = [];
        for (const item of parsed.value.tasks) {
          const task = await readProjectTask(transaction, organizationId, projectId, item.id);
          if (!task) throw new Error("Updated task could not be read");
          tasks.push(task);
        }
        return { kind: "ok" as const, tasks };
      },
      "guest",
    );

    if (result.kind === "not_found") return jsonError(request, 404, "TASK_NOT_FOUND", "One or more tasks are not available in this project.");
    if (result.kind === "forbidden") return jsonError(request, 403, "PROJECT_WORK_ACCESS_REQUIRED", "You do not have permission to work in this project.");
    if (result.kind === "project_closed") return jsonError(request, 409, "PROJECT_CLOSED", "Tasks cannot be changed in a completed or archived project.");
    if (result.kind === "conflict") return jsonError(request, 409, "VERSION_CONFLICT", "One or more selected tasks changed elsewhere. Reload before applying the bulk change.");
    if (result.kind === "archived") return jsonError(request, 409, "TASK_ARCHIVED", "Archived tasks cannot be changed in bulk.");
    if (result.kind === "milestone_closed") return jsonError(request, 409, "MILESTONE_CLOSED", "Tasks in completed milestones cannot be changed.");
    return jsonOk(request, { tasks: result.tasks });
  } catch (error) {
    return jsonServerFailure(request, "tasks.bulk_update", error);
  }
}
