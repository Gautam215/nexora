import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { TASK_PRIORITIES } from "../../../../../../../security/task-schemas.ts";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure, parseJson } from "../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext, type DatabaseTransaction } from "../../../../../../../server/db.ts";
import { notifyProjectMember, notifyProjectMembers } from "../../../../../../../server/project-notifications.ts";
import {
  readProjectMembers,
  readProjectTask,
  readProjectTaskStatuses,
  lockProjectForWork,
  lockProjectTaskGraph,
  type ProjectTaskRow,
} from "../../../../../../../server/project-work.ts";
import { taskCreateSchema } from "../../../../../../../security/task-schemas.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SORTS: Record<string, string> = {
  position: "workflow.sort_order ASC, task.position",
  createdAt: "task.created_at",
  updatedAt: "task.updated_at",
  dueDate: "task.due_date NULLS LAST",
  title: "pg_catalog.lower(task.title)",
  priority: "CASE task.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END",
};

function readPagination(request: NextRequest): { limit: number; offset: number } | null {
  const limitValue = request.nextUrl.searchParams.get("limit") ?? "50";
  const offsetValue = request.nextUrl.searchParams.get("offset") ?? "0";
  if (!/^\d{1,6}$/.test(limitValue) || !/^\d{1,6}$/.test(offsetValue)) return null;
  const limit = Number(limitValue);
  const offset = Number(offsetValue);
  if (limit < 1 || limit > 100 || offset > 100_000) return null;
  return { limit, offset };
}

function addFilter(values: unknown[], clauses: string[], template: (placeholder: string) => string, value: unknown) {
  values.push(value);
  clauses.push(template(`$${values.length}`));
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

async function readWorkAccess(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
) {
  const result = await transaction.query<{
    status: string;
    can_manage: boolean;
    can_work: boolean;
    workflow_version: number;
  }>(
    `SELECT project.status::text AS status,
            nexora.can_manage_current_project(project.organization_id, project.id) AS can_manage,
            nexora.can_work_current_project(project.organization_id, project.id) AS can_work,
            project.task_workflow_version AS workflow_version
     FROM nexora.projects AS project
     WHERE project.organization_id = $1 AND project.id = $2`,
    [organizationId, projectId],
  );
  return result.rows[0] ?? null;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const pagination = readPagination(request);
  if (!pagination) {
    return jsonError(request, 400, "INVALID_PAGINATION", "Use a task page size from 1 to 100 and an offset up to 100000.");
  }

  const sort = request.nextUrl.searchParams.get("sort") ?? "position";
  const direction = request.nextUrl.searchParams.get("direction") ?? "asc";
  if (!Object.hasOwn(SORTS, sort) || !["asc", "desc"].includes(direction)) {
    return jsonError(request, 400, "INVALID_SORT", "Choose a supported task sort and direction.");
  }
  const statusId = request.nextUrl.searchParams.get("statusId");
  const assigneeId = request.nextUrl.searchParams.get("assigneeId");
  const milestoneId = request.nextUrl.searchParams.get("milestoneId");
  const priority = request.nextUrl.searchParams.get("priority");
  const label = request.nextUrl.searchParams.get("label")?.trim() ?? "";
  const search = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (
    (statusId && !UUID_PATTERN.test(statusId))
    || (assigneeId && assigneeId !== "unassigned" && !UUID_PATTERN.test(assigneeId))
    || (milestoneId && !UUID_PATTERN.test(milestoneId))
    || (priority && !TASK_PRIORITIES.includes(priority as (typeof TASK_PRIORITIES)[number]))
    || label.length > 24
    || search.length > 120
  ) {
    return jsonError(request, 400, "INVALID_FILTER", "One or more task filters are invalid.");
  }

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId } = await params;
    if (!UUID_PATTERN.test(projectId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project identifier is invalid.");
    }
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const access = await readWorkAccess(transaction, organizationId, projectId);
        if (!access) return null;

        const values: unknown[] = [organizationId, projectId];
        const clauses = ["task.organization_id = $1", "task.project_id = $2", "task.archived_at IS NULL"];
        if (statusId) addFilter(values, clauses, (placeholder) => `task.workflow_status_id = ${placeholder}`, statusId);
        if (priority) addFilter(values, clauses, (placeholder) => `task.priority = ${placeholder}::nexora.task_priority`, priority);
        if (assigneeId === "unassigned") clauses.push("task.assignee_user_id IS NULL");
        else if (assigneeId) addFilter(values, clauses, (placeholder) => `task.assignee_user_id = ${placeholder}`, assigneeId);
        if (milestoneId) addFilter(values, clauses, (placeholder) => `task.milestone_id = ${placeholder}`, milestoneId);
        if (label) addFilter(values, clauses, (placeholder) => `task.labels @> ARRAY[${placeholder}]::text[]`, label);
        if (search) {
          const escapedSearch = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
          values.push(escapedSearch);
          const placeholder = `$${values.length}`;
          clauses.push(`(task.title ILIKE ${placeholder} ESCAPE E'\\\\' OR task.description ILIKE ${placeholder} ESCAPE E'\\\\')`);
        }
        values.push(pagination.limit + 1, pagination.offset);
        const rows = await transaction.query<ProjectTaskRow>(
          `SELECT task.id,
                  task.organization_id,
                  task.project_id,
                  task.title,
                  task.description,
                  task.workflow_status_id,
                  workflow.name AS status_name,
                  workflow.sort_order AS status_sort_order,
                  workflow.is_done AS status_is_done,
                  task.priority::text AS priority,
                  task.assignee_user_id,
                  assignee.display_name AS assignee_name,
                  creator.display_name AS creator_name,
                  task.milestone_id,
                  milestone.name AS milestone_name,
                  milestone.status::text AS milestone_status,
                  task.parent_task_id,
                  parent.title AS parent_title,
                  task.labels,
                  task.due_date::text AS due_date,
                  task.estimated_effort_hours::text AS estimated_effort_hours,
                  task.position,
                  task.version,
                  task.completed_at,
                  task.archived_at,
                  task.created_at,
                  task.updated_at,
                  COALESCE(subtasks.subtask_count, 0)::integer AS subtask_count,
                  COALESCE(subtasks.completed_subtask_count, 0)::integer AS completed_subtask_count,
                  COALESCE(task_dependencies.dependencies, '[]'::jsonb) AS dependencies,
                  COALESCE(task_dependencies.unresolved_dependency_count, 0)::integer AS unresolved_dependency_count
           FROM nexora.tasks AS task
           JOIN nexora.project_task_statuses AS workflow
             ON workflow.organization_id = task.organization_id
            AND workflow.project_id = task.project_id
            AND workflow.id = task.workflow_status_id
           LEFT JOIN nexora.milestones AS milestone
             ON milestone.organization_id = task.organization_id
            AND milestone.project_id = task.project_id
            AND milestone.id = task.milestone_id
           LEFT JOIN nexora.tasks AS parent
             ON parent.organization_id = task.organization_id
            AND parent.project_id = task.project_id
            AND parent.id = task.parent_task_id
           LEFT JOIN LATERAL (
             SELECT member.display_name
             FROM nexora.list_current_project_members(task.organization_id, task.project_id) AS member
             WHERE member.user_id = task.assignee_user_id LIMIT 1
           ) AS assignee ON true
           LEFT JOIN LATERAL (
             SELECT member.display_name
             FROM nexora.list_current_project_members(task.organization_id, task.project_id) AS member
             WHERE member.user_id = task.created_by_user_id LIMIT 1
           ) AS creator ON true
           LEFT JOIN LATERAL (
             SELECT count(*)::integer AS subtask_count,
                    count(*) FILTER (WHERE child_status.is_done)::integer AS completed_subtask_count
             FROM nexora.tasks AS child
             JOIN nexora.project_task_statuses AS child_status
               ON child_status.organization_id = child.organization_id
              AND child_status.project_id = child.project_id
              AND child_status.id = child.workflow_status_id
             WHERE child.organization_id = task.organization_id
               AND child.project_id = task.project_id
               AND child.parent_task_id = task.id
               AND child.archived_at IS NULL
           ) AS subtasks ON true
           LEFT JOIN LATERAL (
             SELECT pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'id', dependency.id,
                        'title', dependency.title,
                        'status_name', dependency_status.name,
                        'is_done', dependency_status.is_done
                      ) ORDER BY dependency.title, dependency.id
                    ) AS dependencies,
                    count(*) FILTER (WHERE NOT dependency_status.is_done)::integer AS unresolved_dependency_count
             FROM nexora.task_dependencies AS edge
             JOIN nexora.tasks AS dependency
               ON dependency.organization_id = edge.organization_id
              AND dependency.project_id = edge.project_id
              AND dependency.id = edge.depends_on_task_id
             JOIN nexora.project_task_statuses AS dependency_status
               ON dependency_status.organization_id = dependency.organization_id
              AND dependency_status.project_id = dependency.project_id
              AND dependency_status.id = dependency.workflow_status_id
             WHERE edge.organization_id = task.organization_id
               AND edge.project_id = task.project_id
               AND edge.task_id = task.id
           ) AS task_dependencies ON true
           WHERE ${clauses.join(" AND ")}
           ORDER BY ${SORTS[sort]} ${direction.toUpperCase()}, task.id ASC
           LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values,
        );
        const [statuses, members] = await Promise.all([
          readProjectTaskStatuses(transaction, organizationId, projectId),
          readProjectMembers(transaction, organizationId, projectId),
        ]);
        const hasMore = rows.rows.length > pagination.limit;
        return {
          can_manage: access.can_manage,
          can_work: access.can_work,
          project_status: access.status,
          workflow_version: access.workflow_version,
          statuses,
          members,
          tasks: rows.rows.slice(0, pagination.limit),
          pagination: { limit: pagination.limit, offset: pagination.offset, hasMore },
        };
      },
      "guest",
    );

    if (!result) return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    return jsonOk(request, result);
  } catch (error) {
    return jsonServerFailure(request, "tasks.list", error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, taskCreateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return jsonError(request, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid idempotency key and retry.");
  }

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

    const taskId = randomUUID();
    const auditId = randomUUID();
    const operation = "task.create";
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const requestHash = createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
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

        const lockScope = `${organizationId.toLowerCase()}:${projectId.toLowerCase()}:${principal.userId}:${operation}:${keyHash}`;
        await transaction.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [lockScope],
        );
        const existing = await transaction.query<{
          request_hash: string;
          response_status: number;
          response_body: { task: ProjectTaskRow };
          expires_at: Date;
        }>(
          `SELECT request_hash, response_status, response_body, expires_at
           FROM nexora.project_mutation_idempotency
           WHERE organization_id = $1 AND project_id = $2 AND actor_user_id = $3
             AND operation = $4 AND key_hash = $5`,
          [organizationId, projectId, principal.userId, operation, keyHash],
        );
        const prior = existing.rows[0];
        if (prior && prior.expires_at > new Date()) {
          if (prior.request_hash !== requestHash) return { kind: "idempotency_conflict" as const };
          return { kind: "replayed" as const, task: prior.response_body.task, status: prior.response_status };
        }
        if (prior) {
          await transaction.query(
            `DELETE FROM nexora.project_mutation_idempotency
             WHERE organization_id = $1 AND project_id = $2 AND actor_user_id = $3
               AND operation = $4 AND key_hash = $5`,
            [organizationId, projectId, principal.userId, operation, keyHash],
          );
        }

        await lockProjectTaskGraph(transaction, organizationId, projectId);
        const statuses = await readProjectTaskStatuses(transaction, organizationId, projectId);
        const workflow = parsed.value.statusId
          ? statuses.find((status) => status.id === parsed.value.statusId)
          : statuses[0];
        if (!workflow) return { kind: "status_not_found" as const };
        await transaction.query(
          `SELECT id FROM nexora.project_task_statuses
           WHERE organization_id = $1 AND project_id = $2 AND id = $3
           FOR UPDATE`,
          [organizationId, projectId, workflow.id],
        );
        if (parsed.value.assigneeId) {
          const assignee = await transaction.query<{ user_id: string }>(
            `SELECT user_id FROM nexora.project_memberships
             WHERE organization_id = $1 AND project_id = $2
               AND user_id = $3 AND status = 'active'`,
            [organizationId, projectId, parsed.value.assigneeId],
          );
          if (!assignee.rows[0]) return { kind: "assignee_not_found" as const };
        }
        if (parsed.value.milestoneId) {
          const milestone = await transaction.query<{ status: string }>(
            `SELECT status::text AS status FROM nexora.milestones
             WHERE organization_id = $1 AND project_id = $2 AND id = $3
             FOR SHARE`,
            [organizationId, projectId, parsed.value.milestoneId],
          );
          if (!milestone.rows[0]) return { kind: "milestone_not_found" as const };
          if (milestone.rows[0].status === "completed") return { kind: "milestone_closed" as const };
        }
        if (parsed.value.parentTaskId) {
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
            [organizationId, projectId, parsed.value.parentTaskId],
          );
          const parentTask = parent.rows[0];
          if (!parentTask || parentTask.parent_task_id || parentTask.archived_at || parentTask.is_done) {
            return { kind: "parent_not_available" as const };
          }
          if (parentTask.milestone_id !== (parsed.value.milestoneId ?? null)) {
            return { kind: "parent_milestone_mismatch" as const };
          }
        }

        const dependencyIds = parsed.value.dependencies ?? [];
        let dependencyRows: Array<{ id: string; is_done: boolean; archived_at: Date | null }> = [];
        if (dependencyIds.length) {
          const dependencies = await transaction.query<{
            id: string;
            is_done: boolean;
            archived_at: Date | null;
          }>(
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
          );
          dependencyRows = dependencies.rows;
          if (dependencyRows.length !== dependencyIds.length) return { kind: "dependency_not_found" as const };
          if (dependencyRows.some((dependency) => dependency.archived_at)) {
            return { kind: "dependency_archived" as const };
          }
          if (workflow.is_done && dependencyRows.some((dependency) => !dependency.is_done)) {
            return { kind: "dependencies_incomplete" as const };
          }
        }

        const positionResult = await transaction.query<{ position: number }>(
          `SELECT COALESCE(pg_catalog.max(position) + 1, 0)::integer AS position
           FROM nexora.tasks
           WHERE organization_id = $1 AND project_id = $2
             AND workflow_status_id = $3 AND archived_at IS NULL`,
          [organizationId, projectId, workflow.id],
        );
        const position = positionResult.rows[0]?.position ?? 0;
        if (position > 1_000_000) return { kind: "column_full" as const };

        await transaction.query(
          `INSERT INTO nexora.tasks
             (id, organization_id, project_id, title, description, workflow_status_id,
              priority, assignee_user_id, milestone_id, parent_task_id, labels, due_date,
              estimated_effort_hours, position, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7::nexora.task_priority, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            taskId,
            organizationId,
            projectId,
            parsed.value.title,
            parsed.value.description ?? null,
            workflow.id,
            parsed.value.priority ?? "medium",
            parsed.value.assigneeId ?? null,
            parsed.value.milestoneId ?? null,
            parsed.value.parentTaskId ?? null,
            parsed.value.labels ?? [],
            parsed.value.dueDate ?? null,
            parsed.value.estimatedEffortHours ?? null,
            position,
            principal.userId,
          ],
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

        await writeAudit(transaction, auditId, organizationId, principal.userId, "task.created", taskId, {
          title: parsed.value.title,
          status: workflow.name,
          priority: parsed.value.priority ?? "medium",
          assigneeId: parsed.value.assigneeId ?? null,
          milestoneId: parsed.value.milestoneId ?? null,
          dependencies: dependencyIds,
        });
        if (parsed.value.assigneeId) {
          await notifyProjectMember(transaction, {
            organizationId,
            projectId,
            recipientUserId: parsed.value.assigneeId,
            actorUserId: principal.userId,
            eventType: "task_assigned",
            targetType: "task",
            targetId: taskId,
            dedupeKey: `task-assigned:${taskId}:${parsed.value.assigneeId}`,
            title: "A task was assigned to you",
            body: `You were assigned "${parsed.value.title}".`,
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
          body: `A task was created: "${parsed.value.title}".`,
          excludedUserIds: parsed.value.assigneeId ? [parsed.value.assigneeId] : [],
        });
        const task = await readProjectTask(transaction, organizationId, projectId, taskId);
        if (!task) throw new Error("Created task could not be read");
        const responseBody = { task };
        await transaction.query(
          `INSERT INTO nexora.project_mutation_idempotency
             (organization_id, project_id, actor_user_id, operation, key_hash,
              request_hash, response_status, response_body)
           VALUES ($1, $2, $3, $4, $5, $6, 201, $7::jsonb)`,
          [organizationId, projectId, principal.userId, operation, keyHash, requestHash, JSON.stringify(responseBody)],
        );
        return { kind: "created" as const, task };
      },
      "guest",
    );

    if (result.kind === "not_found") return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    if (result.kind === "forbidden") return jsonError(request, 403, "PROJECT_WORK_ACCESS_REQUIRED", "You do not have permission to work in this project.");
    if (result.kind === "project_closed") return jsonError(request, 409, "PROJECT_CLOSED", "Tasks cannot be changed in a completed or archived project.");
    if (result.kind === "idempotency_conflict") return jsonError(request, 409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for different task details.");
    if (result.kind === "status_not_found") return jsonError(request, 409, "TASK_STATUS_NOT_FOUND", "Choose a workflow column that belongs to this project.");
    if (result.kind === "assignee_not_found") return jsonError(request, 409, "TASK_ASSIGNEE_NOT_AVAILABLE", "Assign tasks only to active project members.");
    if (result.kind === "milestone_not_found") return jsonError(request, 404, "MILESTONE_NOT_FOUND", "Milestone not found in this project.");
    if (result.kind === "milestone_closed") return jsonError(request, 409, "MILESTONE_CLOSED", "Tasks cannot be added to a completed milestone.");
    if (result.kind === "parent_not_available") return jsonError(request, 409, "PARENT_TASK_NOT_AVAILABLE", "Subtasks need an active top-level parent task.");
    if (result.kind === "parent_milestone_mismatch") return jsonError(request, 409, "SUBTASK_MILESTONE_MISMATCH", "A subtask must share its parent task's milestone.");
    if (result.kind === "dependency_not_found") return jsonError(request, 404, "TASK_DEPENDENCY_NOT_FOUND", "One or more prerequisite tasks are not available in this project.");
    if (result.kind === "dependency_archived") return jsonError(request, 409, "TASK_DEPENDENCY_ARCHIVED", "Archived tasks cannot be prerequisites.");
    if (result.kind === "dependencies_incomplete") return jsonError(request, 409, "TASK_DEPENDENCIES_INCOMPLETE", "Complete prerequisite tasks before placing this task in a completion column.");
    if (result.kind === "column_full") return jsonError(request, 409, "TASK_COLUMN_FULL", "This workflow column needs to be reordered before adding another task.");
    return jsonOk(request, { task: result.task }, result.kind === "created" ? 201 : result.status);
  } catch (error) {
    return jsonServerFailure(request, "tasks.create", error);
  }
}
