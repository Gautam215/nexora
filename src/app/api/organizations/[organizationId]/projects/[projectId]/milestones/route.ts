import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { milestoneCreateSchema } from "../../../../../../../security/milestone-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext, type DatabaseTransaction } from "../../../../../../../server/db.ts";
import { notifyProjectMembers } from "../../../../../../../server/project-notifications.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

export interface MilestoneRow {
  id: string;
  organization_id: string;
  project_id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  created_by_user_id: string;
  version: number;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  task_count: number;
  completed_task_count: number;
  progress_percent: number;
  dependencies: Array<{ id: string; name: string; status: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

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
    const { organizationId, projectId } = await params;
    if (!UUID_PATTERN.test(projectId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project identifier is invalid.");
    }

    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const projectResult = await transaction.query<{ can_manage: boolean }>(
          `SELECT nexora.can_manage_current_project(organization_id, id) AS can_manage
           FROM nexora.projects
           WHERE organization_id = $1 AND id = $2`,
          [organizationId, projectId],
        );
        if (!projectResult.rows[0]) return null;

        const milestones = await transaction.query<MilestoneRow>(
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
           WHERE milestone.organization_id = $1 AND milestone.project_id = $2
           ORDER BY milestone.start_date NULLS LAST, milestone.end_date NULLS LAST, milestone.created_at, milestone.id`,
          [organizationId, projectId],
        );
        return {
          can_manage: projectResult.rows[0].can_manage,
          milestones: milestones.rows,
        };
      },
      "guest",
    );

    if (!result) return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    return jsonOk(request, result);
  } catch (error) {
    return jsonServerFailure(request, "milestones.list", error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, milestoneCreateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return jsonError(request, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid idempotency key and retry.");
  }

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

    const milestoneId = randomUUID();
    const auditId = randomUUID();
    const operation = "milestone.create";
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const requestHash = createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
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

        const project = await transaction.query<{ id: string; status: string; can_manage: boolean }>(
          `SELECT project.id,
                  project.status::text AS status,
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

        const existing = await transaction.query<{
          request_hash: string;
          response_status: number;
          response_body: { milestone: MilestoneRow };
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
          return {
            kind: "replayed" as const,
            milestone: prior.response_body.milestone,
            status: prior.response_status,
          };
        }
        if (prior) {
          await transaction.query(
            `DELETE FROM nexora.project_mutation_idempotency
             WHERE organization_id = $1 AND project_id = $2 AND actor_user_id = $3
               AND operation = $4 AND key_hash = $5`,
            [organizationId, projectId, principal.userId, operation, keyHash],
          );
        }

        const dependencyIds = parsed.value.dependencies ?? [];
        if (dependencyIds.length) {
          const dependencyCount = await transaction.query<{ count: number }>(
            `SELECT count(*)::integer AS count
             FROM nexora.milestones
             WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])`,
            [organizationId, projectId, dependencyIds],
          );
          if (dependencyCount.rows[0]?.count !== dependencyIds.length) {
            return { kind: "dependency_not_found" as const };
          }
        }

        await transaction.query(
          `INSERT INTO nexora.milestones
             (id, organization_id, project_id, name, description, start_date, end_date, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            milestoneId,
            organizationId,
            projectId,
            parsed.value.name,
            parsed.value.description ?? null,
            parsed.value.startDate ?? null,
            parsed.value.endDate ?? null,
            principal.userId,
          ],
        );
        if (dependencyIds.length) {
          await transaction.query(
            `INSERT INTO nexora.milestone_dependencies
              (organization_id, project_id, milestone_id, depends_on_milestone_id)
              SELECT $1, $2, $3, dependency_id
              FROM pg_catalog.unnest($4::uuid[]) AS dependencies(dependency_id)`,
            [organizationId, projectId, milestoneId, dependencyIds],
          );
        }

        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'milestone.created', 'milestone', $4, $5::jsonb)`,
          [
            auditId,
            organizationId,
            principal.userId,
            milestoneId,
            JSON.stringify({ name: parsed.value.name, status: "planned", dependencies: dependencyIds }),
          ],
        );
        await notifyProjectMembers(transaction, {
          organizationId,
          projectId,
          actorUserId: principal.userId,
          eventId: auditId,
          targetType: "milestone",
          targetId: milestoneId,
          title: "Milestone added",
          body: `The milestone "${parsed.value.name}" was created.`,
        });

        const milestone = await readMilestone(transaction, organizationId, projectId, milestoneId);
        if (!milestone) throw new Error("Created milestone could not be read");
        const responseBody = { milestone };
        await transaction.query(
          `INSERT INTO nexora.project_mutation_idempotency
             (organization_id, project_id, actor_user_id, operation, key_hash,
              request_hash, response_status, response_body)
           VALUES ($1, $2, $3, $4, $5, $6, 201, $7::jsonb)`,
          [organizationId, projectId, principal.userId, operation, keyHash, requestHash, JSON.stringify(responseBody)],
        );
        return { kind: "created" as const, milestone };
      },
      "guest",
    );

    if (result.kind === "not_found") {
      return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }
    if (result.kind === "forbidden") {
      return jsonError(request, 403, "PROJECT_MANAGEMENT_REQUIRED", "You do not have permission to manage milestones.");
    }
    if (result.kind === "project_closed") {
      return jsonError(request, 409, "PROJECT_CLOSED", "Milestones cannot be changed in a completed or archived project.");
    }
    if (result.kind === "idempotency_conflict") {
      return jsonError(request, 409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for different milestone details.");
    }
    if (result.kind === "dependency_not_found") {
      return jsonError(request, 404, "MILESTONE_DEPENDENCY_NOT_FOUND", "One or more dependency milestones are not available in this project.");
    }
    return jsonOk(request, { milestone: result.milestone }, result.kind === "created" ? 201 : result.status);
  } catch (error) {
    return jsonServerFailure(request, "milestones.create", error);
  }
}
