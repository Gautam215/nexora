import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { taskWorkflowUpdateSchema } from "../../../../../../../../security/task-workflow-schemas.ts";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure, parseJson } from "../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../../../server/db.ts";
import { notifyProjectMembers } from "../../../../../../../../server/project-notifications.ts";
import { readProjectTaskStatuses } from "../../../../../../../../server/project-work.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

interface WorkflowStatus {
  id: string;
  name: string;
  sort_order: number;
  is_done: boolean;
  task_count: number;
  total_task_count: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, taskWorkflowUpdateSchema);
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

    const auditId = randomUUID();
    const newIds = parsed.value.statuses.map((status) => status.id ?? randomUUID());
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const project = await transaction.query<{
          status: string;
          task_workflow_version: number;
          can_manage: boolean;
        }>(
          `SELECT project.status::text AS status,
                  project.task_workflow_version,
                  nexora.can_manage_current_project(project.organization_id, project.id) AS can_manage
           FROM nexora.projects AS project
           WHERE project.organization_id = $1 AND project.id = $2
           FOR UPDATE OF project`,
          [organizationId, projectId],
        );
        const currentProject = project.rows[0];
        if (!currentProject) return { kind: "not_found" as const };
        if (!currentProject.can_manage) return { kind: "forbidden" as const };
        if (["completed", "archived"].includes(currentProject.status)) return { kind: "project_closed" as const };
        if (currentProject.task_workflow_version !== parsed.value.expectedVersion) {
          return { kind: "conflict" as const, version: currentProject.task_workflow_version };
        }

        const currentResult = await transaction.query<WorkflowStatus>(
          `SELECT workflow.id,
                  workflow.name,
                  workflow.sort_order,
                  workflow.is_done,
                  (SELECT count(*) FILTER (WHERE task.archived_at IS NULL)::integer
                   FROM nexora.tasks AS task
                   WHERE task.organization_id = workflow.organization_id
                     AND task.project_id = workflow.project_id
                     AND task.workflow_status_id = workflow.id) AS task_count,
                  (SELECT count(*)::integer
                   FROM nexora.tasks AS task
                   WHERE task.organization_id = workflow.organization_id
                     AND task.project_id = workflow.project_id
                     AND task.workflow_status_id = workflow.id) AS total_task_count
           FROM nexora.project_task_statuses AS workflow
           WHERE workflow.organization_id = $1 AND workflow.project_id = $2
           ORDER BY workflow.id
           FOR UPDATE OF workflow`,
          [organizationId, projectId],
        );
        const currentStatuses = currentResult.rows;
        const currentById = new Map(currentStatuses.map((status) => [status.id, status]));
        const suppliedIds = parsed.value.statuses.flatMap((status) => status.id ? [status.id] : []);
        if (suppliedIds.some((id) => !currentById.has(id))) return { kind: "unknown_status" as const };

        const requestedIds = new Set(suppliedIds);
        const removed = currentStatuses.filter((status) => !requestedIds.has(status.id));
        if (removed.some((status) => status.total_task_count > 0)) return { kind: "status_in_use" as const };

        const requested = parsed.value.statuses.map((status, index) => ({
          ...status,
          id: newIds[index],
          sortOrder: index,
        }));
        const requestedById = new Map(requested.map((status) => [status.id, status]));
        if (currentStatuses.some((status) => {
          const next = requestedById.get(status.id);
          return next && next.isDone !== status.is_done && status.total_task_count > 0;
        })) {
          return { kind: "status_in_use" as const };
        }

        const unchanged = currentStatuses.length === requested.length
          && requested.every((status) => {
            const current = currentById.get(status.id);
            return current
              && current.name === status.name
              && current.sort_order === status.sortOrder
              && current.is_done === status.isDone;
          });
        if (unchanged) {
          return {
            kind: "ok" as const,
            statuses: await readProjectTaskStatuses(transaction, organizationId, projectId),
            version: currentProject.task_workflow_version,
          };
        }

        if (removed.length) {
          await transaction.query(
            `DELETE FROM nexora.project_task_statuses
             WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])`,
            [organizationId, projectId, removed.map((status) => status.id)],
          );
        }

        const temporaryPrefix = `__r_${randomUUID()}`;
        for (const [index, status] of requested.entries()) {
          if (!currentById.has(status.id)) continue;
          await transaction.query(
            `UPDATE nexora.project_task_statuses SET name = $1
             WHERE organization_id = $2 AND project_id = $3 AND id = $4`,
            [`${temporaryPrefix}_${index}`, organizationId, projectId, status.id],
          );
        }

        const currentDoneId = currentStatuses.find((status) => status.is_done)?.id;
        const requestedDoneId = requested.find((status) => status.isDone)?.id;
        if (currentDoneId && currentDoneId !== requestedDoneId) {
          await transaction.query(
            `UPDATE nexora.project_task_statuses SET is_done = false
             WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
            [organizationId, projectId, currentDoneId],
          );
        }

        for (const status of requested) {
          if (currentById.has(status.id)) {
            await transaction.query(
              `UPDATE nexora.project_task_statuses
               SET name = $1, sort_order = $2, is_done = $3
               WHERE organization_id = $4 AND project_id = $5 AND id = $6`,
              [status.name, status.sortOrder, status.isDone, organizationId, projectId, status.id],
            );
          } else {
            await transaction.query(
              `INSERT INTO nexora.project_task_statuses
                 (id, organization_id, project_id, name, sort_order, is_done)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [status.id, organizationId, projectId, status.name, status.sortOrder, status.isDone],
            );
          }
        }

        const nextVersion = currentProject.task_workflow_version + 1;
        const updated = await transaction.query(
          `UPDATE nexora.projects
           SET task_workflow_version = $1
           WHERE organization_id = $2 AND id = $3 AND task_workflow_version = $4
           RETURNING task_workflow_version`,
          [nextVersion, organizationId, projectId, currentProject.task_workflow_version],
        );
        if (!updated.rowCount) return { kind: "conflict" as const, version: currentProject.task_workflow_version };

        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'project.task_workflow.updated', 'project', $4, $5::jsonb)`,
          [
            auditId,
            organizationId,
            principal.userId,
            projectId,
            JSON.stringify({
              previousVersion: currentProject.task_workflow_version,
              version: nextVersion,
              statuses: requested.map(({ id, name, isDone, sortOrder }) => ({ id, name, isDone, sortOrder })),
            }),
          ],
        );
        await notifyProjectMembers(transaction, {
          organizationId,
          projectId,
          actorUserId: principal.userId,
          eventId: auditId,
          targetType: "project",
          targetId: projectId,
          title: "Task workflow updated",
          body: "The project task workflow columns were changed.",
        });
        return {
          kind: "ok" as const,
          statuses: await readProjectTaskStatuses(transaction, organizationId, projectId),
          version: nextVersion,
        };
      },
      "guest",
    );

    if (result.kind === "not_found") return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    if (result.kind === "forbidden") return jsonError(request, 403, "PROJECT_MANAGEMENT_REQUIRED", "Only project managers can change workflow columns.");
    if (result.kind === "project_closed") return jsonError(request, 409, "PROJECT_CLOSED", "Workflow columns cannot change in a completed or archived project.");
    if (result.kind === "conflict") return jsonError(request, 409, "WORKFLOW_VERSION_CONFLICT", "The task workflow changed elsewhere. Reload before saving again.");
    if (result.kind === "unknown_status") return jsonError(request, 409, "TASK_STATUS_NOT_FOUND", "Reload the workflow before editing its columns.");
    if (result.kind === "status_in_use") return jsonError(request, 409, "TASK_STATUS_IN_USE", "A column with task history cannot be removed or changed to/from the completion column.");
    return jsonOk(request, { statuses: result.statuses, version: result.version });
  } catch (error) {
    return jsonServerFailure(request, "tasks.workflow.update", error);
  }
}
