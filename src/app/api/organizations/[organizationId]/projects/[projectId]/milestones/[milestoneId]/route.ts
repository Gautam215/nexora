import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  canTransitionMilestoneStatus,
  type MilestoneStatus,
} from "../../../../../../../../security/milestone-status.ts";
import { milestoneUpdateSchema } from "../../../../../../../../security/milestone-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext, type DatabaseTransaction } from "../../../../../../../../server/db.ts";
import { notifyProjectMembers } from "../../../../../../../../server/project-notifications.ts";
import type { MilestoneRow } from "../route.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string; milestoneId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readMilestone(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  milestoneId: string,
): Promise<MilestoneRow | null> {
  const result = await transaction.query<MilestoneRow>(
    `SELECT milestone.id,
            milestone.organization_id,
            milestone.project_id,
            milestone.name,
            milestone.description,
            milestone.start_date,
            milestone.end_date,
            milestone.status::text AS status,
            milestone.created_by_user_id,
            milestone.version,
            milestone.completed_at,
            milestone.created_at,
            milestone.updated_at,
            COALESCE(task_metrics.task_count, 0)::integer AS task_count,
            COALESCE(task_metrics.completed_task_count, 0)::integer AS completed_task_count,
            COALESCE(task_metrics.progress_percent, 0)::integer AS progress_percent,
            COALESCE(dependency_list.dependencies, '[]'::jsonb) AS dependencies
     FROM nexora.milestones AS milestone
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS task_count,
              count(*) FILTER (WHERE workflow.is_done)::integer AS completed_task_count,
              CASE WHEN count(*) = 0 THEN 0
                   ELSE pg_catalog.round(
                     100.0 * count(*) FILTER (WHERE workflow.is_done) / count(*)
                   )::integer
              END AS progress_percent
       FROM nexora.tasks AS task
       JOIN nexora.project_task_statuses AS workflow
         ON workflow.organization_id = task.organization_id
        AND workflow.project_id = task.project_id
        AND workflow.id = task.workflow_status_id
       WHERE task.organization_id = milestone.organization_id
         AND task.project_id = milestone.project_id
         AND task.milestone_id = milestone.id
         AND task.archived_at IS NULL
     ) AS task_metrics ON true
     LEFT JOIN LATERAL (
       SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id', dependency.id,
                  'name', dependency.name,
                  'status', dependency.status::text
                ) ORDER BY dependency.start_date NULLS LAST, dependency.name
              ) AS dependencies
       FROM nexora.milestone_dependencies AS edge
       JOIN nexora.milestones AS dependency
         ON dependency.organization_id = edge.organization_id
        AND dependency.project_id = edge.project_id
        AND dependency.id = edge.depends_on_milestone_id
       WHERE edge.organization_id = milestone.organization_id
         AND edge.project_id = milestone.project_id
         AND edge.milestone_id = milestone.id
     ) AS dependency_list ON true
     WHERE milestone.organization_id = $1
       AND milestone.project_id = $2
       AND milestone.id = $3`,
    [organizationId, projectId, milestoneId],
  );
  return result.rows[0] ?? null;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId, projectId, milestoneId } = await params;
    if (![projectId, milestoneId].every((value) => UUID_PATTERN.test(value))) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project or milestone identifier is invalid.");
    }
    const milestone = await withOrganizationContext(
      principal.userId,
      organizationId,
      (transaction) => readMilestone(transaction, organizationId, projectId, milestoneId),
      "guest",
    );
    if (!milestone) return jsonError(request, 404, "MILESTONE_NOT_FOUND", "Milestone not found.");
    return jsonOk(request, { milestone });
  } catch (error) {
    return jsonServerFailure(request, "milestones.get", error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, milestoneUpdateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId, projectId, milestoneId } = await params;
    if (![projectId, milestoneId].every((value) => UUID_PATTERN.test(value))) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project or milestone identifier is invalid.");
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
        const access = await transaction.query<{ can_manage: boolean }>(
          `SELECT nexora.can_manage_current_project(project.organization_id, project.id) AS can_manage
           FROM nexora.projects AS project
           WHERE project.organization_id = $1 AND project.id = $2`,
          [organizationId, projectId],
        );
        if (!access.rows[0]) return { kind: "not_found" as const };
        if (!access.rows[0].can_manage) return { kind: "forbidden" as const };

        const project = await transaction.query<{ status: string; can_manage: boolean }>(
          `SELECT project.status::text AS status,
                  nexora.can_manage_current_project(project.organization_id, project.id) AS can_manage
           FROM nexora.projects AS project
           WHERE project.organization_id = $1 AND project.id = $2
           FOR UPDATE OF project`,
          [organizationId, projectId],
        );
        if (!project.rows[0]) return { kind: "not_found" as const };
        if (!project.rows[0].can_manage) return { kind: "forbidden" as const };
        if (["completed", "archived"].includes(project.rows[0].status)) {
          return { kind: "project_closed" as const };
        }

        const currentResult = await transaction.query<{
          id: string;
          name: string;
          description: string | null;
          start_date: string | null;
          end_date: string | null;
          status: MilestoneStatus;
          version: number;
        }>(
          `SELECT id, name, description, start_date, end_date, status::text AS status, version
           FROM nexora.milestones
           WHERE organization_id = $1 AND project_id = $2 AND id = $3
           FOR UPDATE`,
          [organizationId, projectId, milestoneId],
        );
        const current = currentResult.rows[0];
        if (!current) return { kind: "not_found" as const };
        if (current.version !== parsed.value.expectedVersion) return { kind: "conflict" as const };

        const name = parsed.value.name ?? current.name;
        const description = parsed.value.description === undefined
          ? current.description
          : parsed.value.description;
        const startDate = parsed.value.startDate === undefined
          ? current.start_date
          : parsed.value.startDate;
        const endDate = parsed.value.endDate === undefined
          ? current.end_date
          : parsed.value.endDate;
        const status = parsed.value.status ?? current.status;
        if (!canTransitionMilestoneStatus(current.status, status)) {
          return { kind: "invalid_transition" as const };
        }

        const currentDependencies = await transaction.query<{ depends_on_milestone_id: string }>(
          `SELECT depends_on_milestone_id
           FROM nexora.milestone_dependencies
           WHERE organization_id = $1 AND project_id = $2 AND milestone_id = $3
           ORDER BY depends_on_milestone_id`,
          [organizationId, projectId, milestoneId],
        );
        const currentDependencyIds = currentDependencies.rows.map((row) => row.depends_on_milestone_id);
        const dependencyIds = parsed.value.dependencies ?? currentDependencyIds;
        const dependenciesChanged = parsed.value.dependencies !== undefined
          && !sameIds(currentDependencyIds, dependencyIds);

        if (parsed.value.dependencies !== undefined && dependencyIds.length) {
          const available = await transaction.query<{ count: number }>(
            `SELECT count(*)::integer AS count
             FROM nexora.milestones
             WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])`,
            [organizationId, projectId, dependencyIds],
          );
          if (available.rows[0]?.count !== dependencyIds.length) {
            return { kind: "dependency_not_found" as const };
          }

          const cycle = await transaction.query<{ cycle: boolean }>(
            `WITH RECURSIVE dependency_chain(milestone_id) AS (
               SELECT pg_catalog.unnest($3::uuid[])
               UNION
               SELECT edge.depends_on_milestone_id
               FROM nexora.milestone_dependencies AS edge
               JOIN dependency_chain AS chain ON edge.milestone_id = chain.milestone_id
               WHERE edge.organization_id = $1 AND edge.project_id = $2
             )
             SELECT EXISTS (
               SELECT 1 FROM dependency_chain WHERE milestone_id = $4
             ) AS cycle`,
            [organizationId, projectId, dependencyIds, milestoneId],
          );
          if (cycle.rows[0]?.cycle) return { kind: "dependency_cycle" as const };
        }

        if (["active", "completed"].includes(status) && dependencyIds.length) {
          const incomplete = await transaction.query<{ count: number }>(
            `SELECT count(*)::integer AS count
             FROM nexora.milestones
             WHERE organization_id = $1 AND project_id = $2
               AND id = ANY($3::uuid[]) AND status <> 'completed'`,
            [organizationId, projectId, dependencyIds],
          );
          if (incomplete.rows[0]?.count) return { kind: "dependencies_incomplete" as const };
        }

        if (status === "completed") {
          const incompleteTasks = await transaction.query<{ count: number }>(
            `SELECT count(*)::integer AS count
             FROM nexora.tasks AS task
             JOIN nexora.project_task_statuses AS workflow
               ON workflow.organization_id = task.organization_id
              AND workflow.project_id = task.project_id
              AND workflow.id = task.workflow_status_id
             WHERE task.organization_id = $1 AND task.project_id = $2
               AND task.milestone_id = $3 AND task.archived_at IS NULL
               AND NOT workflow.is_done`,
            [organizationId, projectId, milestoneId],
          );
          if (incompleteTasks.rows[0]?.count) return { kind: "tasks_incomplete" as const };
        }

        if (current.status === "completed" && status === "active") {
          const completedDependents = await transaction.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM nexora.milestone_dependencies AS edge
               JOIN nexora.milestones AS dependent
                 ON dependent.organization_id = edge.organization_id
                AND dependent.project_id = edge.project_id
                AND dependent.id = edge.milestone_id
               WHERE edge.organization_id = $1 AND edge.project_id = $2
                 AND edge.depends_on_milestone_id = $3
                 AND dependent.status = 'completed'
             ) AS exists`,
            [organizationId, projectId, milestoneId],
          );
          if (completedDependents.rows[0]?.exists) return { kind: "completed_dependent" as const };
        }

        const changedFields = [
          name !== current.name && "name",
          description !== current.description && "description",
          startDate !== current.start_date && "startDate",
          endDate !== current.end_date && "endDate",
          status !== current.status && "status",
          dependenciesChanged && "dependencies",
        ].filter((field): field is string => Boolean(field));
        if (!changedFields.length) {
          const milestone = await readMilestone(transaction, organizationId, projectId, milestoneId);
          if (!milestone) throw new Error("Milestone could not be read");
          return { kind: "ok" as const, milestone };
        }

        if (dependenciesChanged) {
          await transaction.query(
            `DELETE FROM nexora.milestone_dependencies
             WHERE organization_id = $1 AND project_id = $2 AND milestone_id = $3`,
            [organizationId, projectId, milestoneId],
          );
          if (dependencyIds.length) {
            await transaction.query(
              `INSERT INTO nexora.milestone_dependencies
                 (organization_id, project_id, milestone_id, depends_on_milestone_id)
               SELECT $1, $2, $3, dependency_id
               FROM pg_catalog.unnest($4::uuid[]) AS dependency_id`,
              [organizationId, projectId, milestoneId, dependencyIds],
            );
          }
        }

        const update = await transaction.query(
          `UPDATE nexora.milestones
           SET name = $1, description = $2, start_date = $3, end_date = $4,
               status = $5::nexora.milestone_status
           WHERE organization_id = $6 AND project_id = $7 AND id = $8 AND version = $9
           RETURNING version`,
          [name, description, startDate, endDate, status, organizationId, projectId, milestoneId, current.version],
        );
        if (!update.rowCount) return { kind: "conflict" as const };

        const action = status === "completed" && current.status !== "completed"
          ? "milestone.completed"
          : current.status === "completed" && status === "active"
            ? "milestone.reopened"
            : "milestone.updated";
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, $4, 'milestone', $5, $6::jsonb)`,
          [
            auditId,
            organizationId,
            principal.userId,
            action,
            milestoneId,
            JSON.stringify({
              changedFields,
              previousVersion: current.version,
              version: current.version + 1,
              ...(status === current.status ? {} : { previousStatus: current.status, status }),
            }),
          ],
        );
        await notifyProjectMembers(transaction, {
          organizationId,
          projectId,
          actorUserId: principal.userId,
          eventId: auditId,
          targetType: "milestone",
          targetId: milestoneId,
          title: action === "milestone.completed" ? "Milestone completed" : "Milestone updated",
          body: `The milestone "${name}" was updated.`,
        });

        const milestone = await readMilestone(transaction, organizationId, projectId, milestoneId);
        if (!milestone) throw new Error("Updated milestone could not be read");
        return { kind: "ok" as const, milestone };
      },
      "guest",
    );

    if (result.kind === "not_found") {
      return jsonError(request, 404, "MILESTONE_NOT_FOUND", "Milestone not found.");
    }
    if (result.kind === "forbidden") {
      return jsonError(request, 403, "PROJECT_MANAGEMENT_REQUIRED", "You do not have permission to manage milestones.");
    }
    if (result.kind === "project_closed") {
      return jsonError(request, 409, "PROJECT_CLOSED", "Milestones cannot be changed in a completed or archived project.");
    }
    if (result.kind === "conflict") {
      return jsonError(request, 409, "VERSION_CONFLICT", "This milestone changed elsewhere. Reload before saving again.");
    }
    if (result.kind === "invalid_transition") {
      return jsonError(request, 409, "INVALID_MILESTONE_TRANSITION", "That milestone status change is not allowed.");
    }
    if (result.kind === "dependency_not_found") {
      return jsonError(request, 404, "MILESTONE_DEPENDENCY_NOT_FOUND", "One or more dependency milestones are not available in this project.");
    }
    if (result.kind === "dependency_cycle") {
      return jsonError(request, 409, "MILESTONE_DEPENDENCY_CYCLE", "Milestone dependencies cannot form a cycle.");
    }
    if (result.kind === "dependencies_incomplete") {
      return jsonError(request, 409, "MILESTONE_DEPENDENCIES_INCOMPLETE", "Complete prerequisite milestones before starting or completing this milestone.");
    }
    if (result.kind === "tasks_incomplete") {
      return jsonError(request, 409, "MILESTONE_TASKS_INCOMPLETE", "Complete every linked task before completing this milestone.");
    }
    if (result.kind === "completed_dependent") {
      return jsonError(request, 409, "MILESTONE_HAS_COMPLETED_DEPENDENTS", "Reopen dependent milestones before reopening this milestone.");
    }
    return jsonOk(request, { milestone: result.milestone });
  } catch (error) {
    return jsonServerFailure(request, "milestones.update", error);
  }
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}
