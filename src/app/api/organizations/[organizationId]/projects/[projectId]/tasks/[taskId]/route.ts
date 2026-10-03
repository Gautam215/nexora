import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { taskArchiveSchema, taskUpdateSchema } from "../../../../../../../../security/task-schemas.ts";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure, parseJson } from "../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext, type DatabaseTransaction } from "../../../../../../../../server/db.ts";
import { notifyProjectMember, notifyProjectMembers } from "../../../../../../../../server/project-notifications.ts";
import { lockProjectForWork, lockProjectTaskGraph, readProjectTask } from "../../../../../../../../server/project-work.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string; taskId: string }>;
}

interface CurrentTask {
  id: string;
  title: string;
  description: string | null;
  workflow_status_id: string;
  status_is_done: boolean;
  priority: string;
  assignee_user_id: string | null;
  milestone_id: string | null;
  milestone_status: string | null;
  parent_task_id: string | null;
  labels: string[];
  due_date: string | null;
  estimated_effort_hours: string | null;
  position: number;
  version: number;
  archived_at: Date | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readWorkAccess(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
) {
  await lockProjectForWork(transaction, organizationId, projectId);
  const result = await transaction.query<{ status: string; can_work: boolean }>(
    `SELECT project.status::text AS status,
            nexora.can_work_current_project(project.organization_id, project.id) AS can_work
     FROM nexora.projects AS project
     WHERE project.organization_id = $1 AND project.id = $2`,
    [organizationId, projectId],
  );
  return result.rows[0] ?? null;
}

async function readCurrentTask(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  taskId: string,
  lock = false,
): Promise<CurrentTask | null> {
  const result = await transaction.query<CurrentTask>(
    `SELECT task.id,
            task.title,
            task.description,
            task.workflow_status_id,
            workflow.is_done AS status_is_done,
            task.priority::text AS priority,
            task.assignee_user_id,
            task.milestone_id,
            milestone.status::text AS milestone_status,
            task.parent_task_id,
            task.labels,
            task.due_date::text AS due_date,
            task.estimated_effort_hours::text AS estimated_effort_hours,
            task.position,
            task.version,
            task.archived_at
     FROM nexora.tasks AS task
     JOIN nexora.project_task_statuses AS workflow
       ON workflow.organization_id = task.organization_id
      AND workflow.project_id = task.project_id
      AND workflow.id = task.workflow_status_id
     LEFT JOIN nexora.milestones AS milestone
       ON milestone.organization_id = task.organization_id
      AND milestone.project_id = task.project_id
      AND milestone.id = task.milestone_id
     WHERE task.organization_id = $1 AND task.project_id = $2 AND task.id = $3
     ${lock ? "FOR UPDATE OF task" : ""}`,
    [organizationId, projectId, taskId],
  );
  return result.rows[0] ?? null;
}

async function writeAudit(
  transaction: DatabaseTransaction,
  id: string,
  organizationId: string,
  actorUserId: string,
  action: string,
  taskId: string,
  details: Record<string, unknown>,
) {
  await transaction.query(
    `INSERT INTO nexora.audit_events
       (id, organization_id, actor_user_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, 'task', $5, $6::jsonb)`,
    [id, organizationId, actorUserId, action, taskId, JSON.stringify(details)],
  );
}

async function getDependencyIds(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  taskId: string,
): Promise<string[]> {
  const result = await transaction.query<{ depends_on_task_id: string }>(
    `SELECT depends_on_task_id FROM nexora.task_dependencies
     WHERE organization_id = $1 AND project_id = $2 AND task_id = $3
     ORDER BY depends_on_task_id`,
    [organizationId, projectId, taskId],
  );
  return result.rows.map((row) => row.depends_on_task_id);
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId, taskId } = await params;
    if (![projectId, taskId].every((value) => UUID_PATTERN.test(value))) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project or task identifier is invalid.");
    }
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const task = await readProjectTask(transaction, organizationId, projectId, taskId);
        if (!task) return null;
        const activity = await transaction.query(
           `SELECT event.id,
                   CASE WHEN event.action = 'task.comment_created' THEN 'comment.added'
                        ELSE event.action
                   END AS action,
                   event.details,
                  event.created_at,
                  actor.display_name AS actor_name
           FROM nexora.audit_events AS event
           LEFT JOIN LATERAL (
             SELECT member.display_name
             FROM nexora.list_current_project_members($1, $2) AS member
             WHERE member.user_id = event.actor_user_id
             LIMIT 1
           ) AS actor ON true
           WHERE event.organization_id = $1
             AND event.target_type = 'task'
             AND event.target_id = $3
           ORDER BY event.created_at DESC, event.id DESC
           LIMIT 30`,
          [organizationId, projectId, taskId],
        );
        return { task, activity: activity.rows };
      },
      "guest",
    );
    if (!result) return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
    return jsonOk(request, result);
  } catch (error) {
    return jsonServerFailure(request, "tasks.get", error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, taskUpdateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId, taskId } = await params;
    if (![projectId, taskId].every((value) => UUID_PATTERN.test(value))) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project or task identifier is invalid.");
    }
    if (await isRateLimited(request, "project-management-user", principal.userId, 40, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many project changes. Wait before trying again.", { "retry-after": "3600" });
    }

    const auditId = randomUUID();
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const access = await readWorkAccess(transaction, organizationId, projectId);
        if (!access) return { kind: "not_found" as const };
        if (!access.can_work) return { kind: "forbidden" as const };
        if (["completed", "archived"].includes(access.status)) return { kind: "project_closed" as const };

        await lockProjectTaskGraph(transaction, organizationId, projectId);
        const current = await readCurrentTask(transaction, organizationId, projectId, taskId, true);
        if (!current) return { kind: "not_found" as const };
        if (current.version !== parsed.value.expectedVersion) return { kind: "conflict" as const };
        if (current.archived_at) return { kind: "archived" as const };
        if (current.milestone_status === "completed") return { kind: "milestone_closed" as const };

        const title = parsed.value.title ?? current.title;
        const description = parsed.value.description === undefined ? current.description : parsed.value.description;
        const priority = parsed.value.priority ?? current.priority;
        const statusId = parsed.value.statusId ?? current.workflow_status_id;
        const assigneeId = parsed.value.assigneeId === undefined ? current.assignee_user_id : parsed.value.assigneeId;
        const milestoneId = parsed.value.milestoneId === undefined ? current.milestone_id : parsed.value.milestoneId;
        const parentTaskId = parsed.value.parentTaskId === undefined ? current.parent_task_id : parsed.value.parentTaskId;
        const labels = parsed.value.labels ?? current.labels;
        const dueDate = parsed.value.dueDate === undefined ? current.due_date : parsed.value.dueDate;
        const estimatedEffortHours = parsed.value.estimatedEffortHours === undefined
          ? current.estimated_effort_hours
          : parsed.value.estimatedEffortHours;
        const hasChildren = current.parent_task_id === null
          && await hasActiveChildren(transaction, organizationId, projectId, taskId);
        if (hasChildren && (parentTaskId !== null || milestoneId !== current.milestone_id)) {
          return { kind: "parent_has_subtasks" as const };
        }

        const statusResult = await transaction.query<{ id: string; is_done: boolean }>(
          `SELECT id, is_done FROM nexora.project_task_statuses
           WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
          [organizationId, projectId, statusId],
        );
        const status = statusResult.rows[0];
        if (!status) return { kind: "status_not_found" as const };

        if (assigneeId) {
          const assignee = await transaction.query<{ user_id: string }>(
            `SELECT user_id FROM nexora.project_memberships
             WHERE organization_id = $1 AND project_id = $2
               AND user_id = $3 AND status = 'active'`,
            [organizationId, projectId, assigneeId],
          );
          if (!assignee.rows[0]) return { kind: "assignee_not_found" as const };
        }

        const milestoneIds = [...new Set([current.milestone_id, milestoneId].filter((id): id is string => Boolean(id)))].sort();
        if (milestoneIds.length) {
          const milestones = await transaction.query<{ id: string; status: string }>(
            `SELECT id, status::text AS status
             FROM nexora.milestones
             WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])
             ORDER BY id
             FOR UPDATE`,
            [organizationId, projectId, milestoneIds],
          );
          if (milestones.rows.length !== milestoneIds.length) return { kind: "milestone_not_found" as const };
          if (milestones.rows.some((milestone) => milestone.status === "completed")) {
            return { kind: "milestone_closed" as const };
          }
        }

        if (parentTaskId) {
          if (parentTaskId.toLowerCase() === taskId.toLowerCase()) return { kind: "parent_not_available" as const };
          const parent = await transaction.query<{
            parent_task_id: string | null;
            milestone_id: string | null;
            archived_at: Date | null;
            is_done: boolean;
          }>(
            `SELECT task.parent_task_id, task.milestone_id, task.archived_at, workflow.is_done
             FROM nexora.tasks AS task
             JOIN nexora.project_task_statuses AS workflow
               ON workflow.organization_id = task.organization_id
              AND workflow.project_id = task.project_id
              AND workflow.id = task.workflow_status_id
             WHERE task.organization_id = $1 AND task.project_id = $2 AND task.id = $3
             FOR UPDATE OF task`,
            [organizationId, projectId, parentTaskId],
          );
          const parentTask = parent.rows[0];
          if (!parentTask || parentTask.parent_task_id || parentTask.archived_at || parentTask.is_done) {
            return { kind: "parent_not_available" as const };
          }
          if (parentTask.milestone_id !== milestoneId) return { kind: "parent_milestone_mismatch" as const };
        }

        const oldDependencies = await getDependencyIds(transaction, organizationId, projectId, taskId);
        const dependencyIds = parsed.value.dependencies ?? oldDependencies;
        const dependenciesChanged = parsed.value.dependencies !== undefined && !sameIds(oldDependencies, dependencyIds);
        if (dependencyIds.some((id) => id.toLowerCase() === taskId.toLowerCase())) {
          return { kind: "dependency_cycle" as const };
        }

        const dependencyRows = dependencyIds.length
          ? await transaction.query<{ id: string; is_done: boolean; archived_at: Date | null }>(
              `SELECT task.id, workflow.is_done, task.archived_at
               FROM nexora.tasks AS task
               JOIN nexora.project_task_statuses AS workflow
                 ON workflow.organization_id = task.organization_id
                AND workflow.project_id = task.project_id
                AND workflow.id = task.workflow_status_id
               WHERE task.organization_id = $1 AND task.project_id = $2
                 AND task.id = ANY($3::uuid[])
               ORDER BY task.id
               FOR UPDATE OF task`,
              [organizationId, projectId, dependencyIds],
            )
          : { rows: [] };
        if (dependencyRows.rows.length !== dependencyIds.length) return { kind: "dependency_not_found" as const };
        if (dependenciesChanged && dependencyRows.rows.some((dependency) => dependency.archived_at)) {
          return { kind: "dependency_archived" as const };
        }
        if (status.is_done && dependencyRows.rows.some((dependency) => !dependency.is_done)) {
          return { kind: "dependencies_incomplete" as const };
        }
        if (dependenciesChanged) {
          const cycle = await transaction.query<{ cycle: boolean }>(
            `WITH RECURSIVE dependency_chain(task_id) AS (
               SELECT dependency_id
               FROM pg_catalog.unnest($3::uuid[]) AS requested(dependency_id)
               UNION
               SELECT edge.depends_on_task_id
               FROM nexora.task_dependencies AS edge
               JOIN dependency_chain AS chain ON edge.task_id = chain.task_id
               WHERE edge.organization_id = $1 AND edge.project_id = $2
             )
             SELECT EXISTS (SELECT 1 FROM dependency_chain WHERE task_id = $4) AS cycle`,
            [organizationId, projectId, dependencyIds, taskId],
          );
          if (cycle.rows[0]?.cycle) return { kind: "dependency_cycle" as const };
        }

        if (status.is_done) {
          const unfinishedChildren = await transaction.query<{ count: number }>(
            `SELECT count(*)::integer AS count
             FROM nexora.tasks AS child
             JOIN nexora.project_task_statuses AS child_status
               ON child_status.organization_id = child.organization_id
              AND child_status.project_id = child.project_id
              AND child_status.id = child.workflow_status_id
             WHERE child.organization_id = $1 AND child.project_id = $2
               AND child.parent_task_id = $3 AND child.archived_at IS NULL
               AND NOT child_status.is_done`,
            [organizationId, projectId, taskId],
          );
          if (unfinishedChildren.rows[0]?.count) return { kind: "subtasks_incomplete" as const };
        }
        if (current.status_is_done && !status.is_done) {
          const completedDependents = await transaction.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM nexora.task_dependencies AS edge
               JOIN nexora.tasks AS dependent
                 ON dependent.organization_id = edge.organization_id
                AND dependent.project_id = edge.project_id
                AND dependent.id = edge.task_id
               JOIN nexora.project_task_statuses AS dependent_status
                 ON dependent_status.organization_id = dependent.organization_id
                AND dependent_status.project_id = dependent.project_id
                AND dependent_status.id = dependent.workflow_status_id
               WHERE edge.organization_id = $1 AND edge.project_id = $2
                 AND edge.depends_on_task_id = $3
                 AND dependent.archived_at IS NULL AND dependent_status.is_done
             ) AS exists`,
            [organizationId, projectId, taskId],
          );
          if (completedDependents.rows[0]?.exists) return { kind: "completed_dependent" as const };
        }

        const movingStatus = statusId !== current.workflow_status_id;
        const requestedPosition = parsed.value.position;
        const movingPosition = movingStatus || (requestedPosition !== undefined && requestedPosition !== current.position);
        let position = current.position;
        if (movingPosition) {
          const statusIds = [...new Set([current.workflow_status_id, statusId])].sort();
          await transaction.query(
            `SELECT id FROM nexora.project_task_statuses
             WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])
             ORDER BY id FOR UPDATE`,
            [organizationId, projectId, statusIds],
          );
          if (movingStatus) {
            const targetCount = await transaction.query<{ count: number }>(
              `SELECT count(*)::integer AS count
               FROM nexora.tasks
               WHERE organization_id = $1 AND project_id = $2
                 AND workflow_status_id = $3 AND archived_at IS NULL AND id <> $4`,
              [organizationId, projectId, statusId, taskId],
            );
            position = Math.min(requestedPosition ?? targetCount.rows[0]?.count ?? 0, targetCount.rows[0]?.count ?? 0);
            await transaction.query(
              `UPDATE nexora.tasks SET position = position + 1
               WHERE organization_id = $1 AND project_id = $2
                 AND workflow_status_id = $3 AND archived_at IS NULL AND position >= $4`,
              [organizationId, projectId, statusId, position],
            );
            await transaction.query(
              `UPDATE nexora.tasks SET position = position - 1
               WHERE organization_id = $1 AND project_id = $2
                 AND workflow_status_id = $3 AND archived_at IS NULL AND position > $4`,
              [organizationId, projectId, current.workflow_status_id, current.position],
            );
          } else {
            const activeCount = await transaction.query<{ count: number }>(
              `SELECT count(*)::integer AS count
               FROM nexora.tasks
               WHERE organization_id = $1 AND project_id = $2
                 AND workflow_status_id = $3 AND archived_at IS NULL`,
              [organizationId, projectId, current.workflow_status_id],
            );
            position = Math.min(requestedPosition ?? current.position, Math.max(0, (activeCount.rows[0]?.count ?? 1) - 1));
            if (position < current.position) {
              await transaction.query(
                `UPDATE nexora.tasks SET position = position + 1
                 WHERE organization_id = $1 AND project_id = $2
                   AND workflow_status_id = $3 AND archived_at IS NULL
                   AND id <> $4 AND position >= $5 AND position < $6`,
                [organizationId, projectId, statusId, taskId, position, current.position],
              );
            } else if (position > current.position) {
              await transaction.query(
                `UPDATE nexora.tasks SET position = position - 1
                 WHERE organization_id = $1 AND project_id = $2
                   AND workflow_status_id = $3 AND archived_at IS NULL
                   AND id <> $4 AND position > $5 AND position <= $6`,
                [organizationId, projectId, statusId, taskId, current.position, position],
              );
            }
          }
        }

        const changedFields = [
          title !== current.title && "title",
          description !== current.description && "description",
          statusId !== current.workflow_status_id && "status",
          priority !== current.priority && "priority",
          assigneeId !== current.assignee_user_id && "assignee",
          milestoneId !== current.milestone_id && "milestone",
          parentTaskId !== current.parent_task_id && "parentTask",
          !sameLabels(labels, current.labels) && "labels",
          dueDate !== current.due_date && "dueDate",
          !sameEstimate(estimatedEffortHours, current.estimated_effort_hours) && "estimatedEffortHours",
          movingPosition && "position",
          dependenciesChanged && "dependencies",
        ].filter((field): field is string => Boolean(field));
        if (!changedFields.length) {
          const task = await readProjectTask(transaction, organizationId, projectId, taskId);
          if (!task) throw new Error("Task could not be read");
          return { kind: "ok" as const, task };
        }

        if (dependenciesChanged) {
          await transaction.query(
            `DELETE FROM nexora.task_dependencies
             WHERE organization_id = $1 AND project_id = $2 AND task_id = $3`,
            [organizationId, projectId, taskId],
          );
          if (dependencyIds.length) {
            await transaction.query(
              `INSERT INTO nexora.task_dependencies
                 (organization_id, project_id, task_id, depends_on_task_id)
               SELECT $1, $2, $3, dependency_id
               FROM pg_catalog.unnest($4::uuid[]) AS dependencies(dependency_id)`,
              [organizationId, projectId, taskId, dependencyIds],
            );
          }
        }

        const updated = await transaction.query(
          `UPDATE nexora.tasks
           SET title = $1, description = $2, workflow_status_id = $3,
               priority = $4::nexora.task_priority, assignee_user_id = $5,
               milestone_id = $6, parent_task_id = $7, labels = $8, due_date = $9,
               estimated_effort_hours = $10, position = $11
           WHERE organization_id = $12 AND project_id = $13 AND id = $14 AND version = $15
           RETURNING version`,
          [
            title,
            description,
            statusId,
            priority,
            assigneeId,
            milestoneId,
            parentTaskId,
            labels,
            dueDate,
            estimatedEffortHours,
            position,
            organizationId,
            projectId,
            taskId,
            current.version,
          ],
        );
        if (!updated.rowCount) return { kind: "conflict" as const };

        const action = statusId !== current.workflow_status_id
          ? "task.status_changed"
          : assigneeId !== current.assignee_user_id
            ? "task.assigned"
            : "task.updated";
        await writeAudit(transaction, auditId, organizationId, principal.userId, action, taskId, {
          changedFields,
          previousVersion: current.version,
          version: current.version + 1,
          ...(statusId === current.workflow_status_id ? {} : { previousStatusId: current.workflow_status_id, statusId }),
          ...(assigneeId === current.assignee_user_id ? {} : { previousAssigneeId: current.assignee_user_id, assigneeId }),
        });
        if (assigneeId && assigneeId !== current.assignee_user_id) {
          await notifyProjectMember(transaction, {
            organizationId,
            projectId,
            recipientUserId: assigneeId,
            actorUserId: principal.userId,
            eventType: "task_assigned",
            targetType: "task",
            targetId: taskId,
            dedupeKey: `task-assigned:${taskId}:${assigneeId}`,
            title: "A task was assigned to you",
            body: `You were assigned "${title}".`,
          });
        }
        await notifyProjectMembers(transaction, {
          organizationId,
          projectId,
          actorUserId: principal.userId,
          eventId: auditId,
          targetType: "task",
          targetId: taskId,
          title: "New project activity",
          body: `Task "${title}" was updated.`,
          excludedUserIds: assigneeId && assigneeId !== current.assignee_user_id ? [assigneeId] : [],
        });
        const task = await readProjectTask(transaction, organizationId, projectId, taskId);
        if (!task) throw new Error("Updated task could not be read");
        return { kind: "ok" as const, task };
      },
      "guest",
    );

    if (result.kind === "not_found") return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
    if (result.kind === "forbidden") return jsonError(request, 403, "PROJECT_WORK_ACCESS_REQUIRED", "You do not have permission to work in this project.");
    if (result.kind === "project_closed") return jsonError(request, 409, "PROJECT_CLOSED", "Tasks cannot be changed in a completed or archived project.");
    if (result.kind === "conflict") return jsonError(request, 409, "VERSION_CONFLICT", "This task changed elsewhere. Reload before saving again.");
    if (result.kind === "archived") return jsonError(request, 409, "TASK_ARCHIVED", "Archived tasks cannot be edited.");
    if (result.kind === "milestone_closed") return jsonError(request, 409, "MILESTONE_CLOSED", "Tasks in a completed milestone cannot be changed.");
    if (result.kind === "status_not_found") return jsonError(request, 409, "TASK_STATUS_NOT_FOUND", "Choose a workflow column that belongs to this project.");
    if (result.kind === "assignee_not_found") return jsonError(request, 409, "TASK_ASSIGNEE_NOT_AVAILABLE", "Assign tasks only to active project members.");
    if (result.kind === "milestone_not_found") return jsonError(request, 404, "MILESTONE_NOT_FOUND", "Milestone not found in this project.");
    if (result.kind === "parent_not_available") return jsonError(request, 409, "PARENT_TASK_NOT_AVAILABLE", "Subtasks need an active top-level parent task.");
    if (result.kind === "parent_milestone_mismatch") return jsonError(request, 409, "SUBTASK_MILESTONE_MISMATCH", "A subtask must share its parent task's milestone.");
    if (result.kind === "parent_has_subtasks") return jsonError(request, 409, "TASK_HAS_SUBTASKS", "A task with subtasks cannot become a subtask itself.");
    if (result.kind === "dependency_not_found") return jsonError(request, 404, "TASK_DEPENDENCY_NOT_FOUND", "One or more prerequisite tasks are not available in this project.");
    if (result.kind === "dependency_archived") return jsonError(request, 409, "TASK_DEPENDENCY_ARCHIVED", "Archived tasks cannot be prerequisites.");
    if (result.kind === "dependency_cycle") return jsonError(request, 409, "TASK_DEPENDENCY_CYCLE", "Task dependencies cannot form a cycle.");
    if (result.kind === "dependencies_incomplete") return jsonError(request, 409, "TASK_DEPENDENCIES_INCOMPLETE", "Complete prerequisite tasks before placing this task in a completion column.");
    if (result.kind === "subtasks_incomplete") return jsonError(request, 409, "TASK_SUBTASKS_INCOMPLETE", "Complete every active subtask before completing this task.");
    if (result.kind === "completed_dependent") return jsonError(request, 409, "TASK_HAS_COMPLETED_DEPENDENTS", "Reopen dependent tasks before reopening this task.");
    return jsonOk(request, { task: result.task });
  } catch (error) {
    return jsonServerFailure(request, "tasks.update", error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, taskArchiveSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId, taskId } = await params;
    if (![projectId, taskId].every((value) => UUID_PATTERN.test(value))) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project or task identifier is invalid.");
    }
    if (await isRateLimited(request, "project-management-user", principal.userId, 40, 3600, 80)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many project changes. Wait before trying again.", { "retry-after": "3600" });
    }

    const auditId = randomUUID();
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const access = await readWorkAccess(transaction, organizationId, projectId);
        if (!access) return { kind: "not_found" as const };
        if (!access.can_work) return { kind: "forbidden" as const };
        if (["completed", "archived"].includes(access.status)) return { kind: "project_closed" as const };
        await lockProjectTaskGraph(transaction, organizationId, projectId);
        const current = await readCurrentTask(transaction, organizationId, projectId, taskId, true);
        if (!current) return { kind: "not_found" as const };
        if (current.version !== parsed.value.expectedVersion) return { kind: "conflict" as const };
        if (current.archived_at) return { kind: "already_archived" as const };
        if (current.milestone_status === "completed") return { kind: "milestone_closed" as const };
        if (await hasActiveChildren(transaction, organizationId, projectId, taskId)) {
          return { kind: "active_children" as const };
        }
        await transaction.query(
          `SELECT id FROM nexora.project_task_statuses
           WHERE organization_id = $1 AND project_id = $2 AND id = $3
           FOR UPDATE`,
          [organizationId, projectId, current.workflow_status_id],
        );
        const activeDependents = await transaction.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM nexora.task_dependencies AS edge
             JOIN nexora.tasks AS dependent
               ON dependent.organization_id = edge.organization_id
              AND dependent.project_id = edge.project_id
              AND dependent.id = edge.task_id
             JOIN nexora.project_task_statuses AS workflow
               ON workflow.organization_id = dependent.organization_id
              AND workflow.project_id = dependent.project_id
              AND workflow.id = dependent.workflow_status_id
             WHERE edge.organization_id = $1 AND edge.project_id = $2
               AND edge.depends_on_task_id = $3
               AND dependent.archived_at IS NULL AND NOT workflow.is_done
           ) AS exists`,
          [organizationId, projectId, taskId],
        );
        if (activeDependents.rows[0]?.exists) return { kind: "active_dependents" as const };

        await transaction.query(
          `UPDATE nexora.tasks SET archived_at = pg_catalog.clock_timestamp()
           WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND version = $4`,
          [organizationId, projectId, taskId, current.version],
        );
        await transaction.query(
          `UPDATE nexora.tasks SET position = position - 1
           WHERE organization_id = $1 AND project_id = $2
             AND workflow_status_id = $3 AND archived_at IS NULL AND position > $4`,
          [organizationId, projectId, current.workflow_status_id, current.position],
        );
        await writeAudit(transaction, auditId, organizationId, principal.userId, "task.archived", taskId, {
          previousVersion: current.version,
          version: current.version + 1,
        });
        await notifyProjectMembers(transaction, {
          organizationId,
          projectId,
          actorUserId: principal.userId,
          eventId: auditId,
          targetType: "task",
          targetId: taskId,
          title: "Task archived",
          body: `The task "${current.title}" was archived.`,
        });
        const task = await readProjectTask(transaction, organizationId, projectId, taskId);
        if (!task) throw new Error("Archived task could not be read");
        return { kind: "ok" as const, task };
      },
      "guest",
    );

    if (result.kind === "not_found") return jsonError(request, 404, "TASK_NOT_FOUND", "Task not found.");
    if (result.kind === "forbidden") return jsonError(request, 403, "PROJECT_WORK_ACCESS_REQUIRED", "You do not have permission to work in this project.");
    if (result.kind === "project_closed") return jsonError(request, 409, "PROJECT_CLOSED", "Tasks cannot be changed in a completed or archived project.");
    if (result.kind === "conflict") return jsonError(request, 409, "VERSION_CONFLICT", "This task changed elsewhere. Reload before trying again.");
    if (result.kind === "already_archived") return jsonError(request, 409, "TASK_ARCHIVED", "This task is already archived.");
    if (result.kind === "milestone_closed") return jsonError(request, 409, "MILESTONE_CLOSED", "Tasks in a completed milestone cannot be changed.");
    if (result.kind === "active_children") return jsonError(request, 409, "TASK_HAS_ACTIVE_SUBTASKS", "Archive subtasks before archiving their parent task.");
    if (result.kind === "active_dependents") return jsonError(request, 409, "TASK_HAS_ACTIVE_DEPENDENTS", "Reassign or complete dependent tasks before archiving this task.");
    return jsonOk(request, { task: result.task });
  } catch (error) {
    return jsonServerFailure(request, "tasks.archive", error);
  }
}

async function hasActiveChildren(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  taskId: string,
): Promise<boolean> {
  const result = await transaction.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM nexora.tasks
       WHERE organization_id = $1 AND project_id = $2
         AND parent_task_id = $3 AND archived_at IS NULL
     ) AS exists`,
    [organizationId, projectId, taskId],
  );
  return result.rows[0]?.exists === true;
}

function sameIds(left: string[], right: string[]): boolean {
  const normalizedRight = new Set(right.map((id) => id.toLowerCase()));
  return left.length === right.length && left.every((id) => normalizedRight.has(id.toLowerCase()));
}

function sameEstimate(left: number | string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return Number(left) === Number(right);
}

function sameLabels(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((label, index) => label === right[index]);
}
