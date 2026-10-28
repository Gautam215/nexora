import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { canTransitionProjectStatus, type ProjectStatus } from "../../../../../../security/project-status.ts";
import { projectDeleteSchema, projectUpdateSchema } from "../../../../../../security/project-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  logRouteFailure,
  parseJson,
} from "../../../../../../server/api.ts";
import { publishRealtimeEvent } from "../../../../../../server/realtime/events.ts";
import { getAuthPrincipal } from "../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext, type DatabaseTransaction } from "../../../../../../server/db.ts";
import { notifyProjectMembers } from "../../../../../../server/project-notifications.ts";
import { lockProjectLifecycle } from "../../../../../../server/project-work.ts";

export const runtime = "nodejs";

// Same pattern as the task/milestone/comment/file routes. For PATCH
// the key is opt-in, not required: existing clients (including the
// project edit form) do not send one, and a missing key keeps the
// previous behaviour. A present but malformed key fails closed.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: string;
  owner_user_id: string;
  owner_name: string | null;
  start_date: string | null;
  target_date: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  viewer_role: string | null;
  can_manage: boolean;
  active_member_count: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readProject(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  userId: string,
  lock = false,
): Promise<ProjectRow | null> {
  const result = await transaction.query<ProjectRow>(
    `SELECT project.id,
            project.organization_id,
            project.name,
            project.description,
            project.status::text AS status,
            project.owner_user_id,
            owner.display_name AS owner_name,
            project.start_date::text AS start_date,
            project.target_date::text AS target_date,
            project.version,
            project.created_at,
            project.updated_at,
            (
              SELECT membership.role::text
              FROM nexora.project_memberships AS membership
              WHERE membership.organization_id = project.organization_id
                AND membership.project_id = project.id
                AND membership.user_id = $3
                AND membership.status = 'active'
            ) AS viewer_role,
            nexora.can_manage_current_project(project.organization_id, project.id) AS can_manage,
            (
              SELECT pg_catalog.count(*)::integer
              FROM nexora.project_memberships AS membership
              WHERE membership.organization_id = project.organization_id
                AND membership.project_id = project.id
                AND membership.status = 'active'
            ) AS active_member_count
     FROM nexora.projects AS project
     LEFT JOIN LATERAL (
       SELECT member.display_name
       FROM nexora.list_current_project_members(project.organization_id, project.id) AS member
       WHERE member.user_id = project.owner_user_id
       LIMIT 1
     ) AS owner ON true
     WHERE project.organization_id = $1 AND project.id = $2 AND project.deleted_at IS NULL
     ${lock ? "FOR UPDATE OF project" : ""}`,
    [organizationId, projectId, userId],
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
        const project = await readProject(transaction, organizationId, projectId, principal.userId);
        if (!project) return null;
        const members = await transaction.query(
          "SELECT * FROM nexora.list_current_project_members($1, $2)",
          [organizationId, projectId],
        );
        return { project, members: members.rows };
      },
      "guest",
    );
    if (!result) {
      return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }
    return jsonOk(request, result);
  } catch (error) {
    return jsonServerFailure(request, "projects.get", error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, projectUpdateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);
  const rawIdempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  const idempotencyKey = rawIdempotencyKey === "" ? null : rawIdempotencyKey;
  if (idempotencyKey !== null && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
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

    const auditId = randomUUID();
    const operation = "project.update";
    const keyHash =
      idempotencyKey === null ? null : createHash("sha256").update(idempotencyKey).digest("hex");
    const requestHash =
      idempotencyKey === null
        ? null
        : createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const visible = await readProject(transaction, organizationId, projectId, principal.userId);
        if (!visible) return { kind: "not_found" as const };
        if (!visible.can_manage) return { kind: "forbidden" as const };

        await lockProjectLifecycle(transaction, organizationId, projectId);
        const current = await readProject(transaction, organizationId, projectId, principal.userId, true);
        if (!current) return { kind: "not_found" as const };
        if (!current.can_manage) return { kind: "forbidden" as const };
        // The lifecycle lock serializes same-key retries: the first
        // commit stores its row, and a retry behind it replays
        // instead of hitting the version check below.
        if (idempotencyKey !== null && keyHash !== null && requestHash !== null) {
          const existing = await transaction.query<{
            request_hash: string;
            response_status: number;
            response_body: { project: ProjectRow };
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
            return { kind: "replayed" as const, project: prior.response_body.project };
          }
          if (prior) {
            await transaction.query(
              `DELETE FROM nexora.project_mutation_idempotency
               WHERE organization_id = $1 AND project_id = $2 AND actor_user_id = $3
                 AND operation = $4 AND key_hash = $5`,
              [organizationId, projectId, principal.userId, operation, keyHash],
            );
          }
        }
        if (current.version !== parsed.value.expectedVersion) {
          return { kind: "conflict" as const, currentVersion: current.version };
        }

        const name = parsed.value.name ?? current.name;
        const description = parsed.value.description === undefined
          ? current.description
          : parsed.value.description;
        const status = parsed.value.status ?? current.status;
        const startDate = parsed.value.startDate === undefined
          ? current.start_date
          : parsed.value.startDate;
        const targetDate = parsed.value.targetDate === undefined
          ? current.target_date
          : parsed.value.targetDate;

        if (startDate && targetDate && targetDate < startDate) {
          return { kind: "invalid_dates" as const };
        }
        if (!canTransitionProjectStatus(current.status as ProjectStatus, status as ProjectStatus)) {
          return { kind: "invalid_transition" as const };
        }

        const changedFields = [
          name !== current.name && "name",
          description !== current.description && "description",
          status !== current.status && "status",
          startDate !== current.start_date && "startDate",
          targetDate !== current.target_date && "targetDate",
        ].filter((field): field is string => Boolean(field));
        if (!changedFields.length) {
          // A no-op still records its row: a retry replays the same
          // result instead of depending on version state.
          if (idempotencyKey !== null && keyHash !== null && requestHash !== null) {
            await transaction.query(
              `INSERT INTO nexora.project_mutation_idempotency
                 (organization_id, project_id, actor_user_id, operation, key_hash,
                  request_hash, response_status, response_body)
               VALUES ($1, $2, $3, $4, $5, $6, 200, $7::jsonb)`,
              [
                organizationId,
                projectId,
                principal.userId,
                operation,
                keyHash,
                requestHash,
                JSON.stringify({ project: current }),
              ],
            );
          }
          return { kind: "ok" as const, project: current };
        }

        const updated = await transaction.query(
          `UPDATE nexora.projects
           SET name = $1,
               description = $2,
               status = $3::nexora.project_status,
               start_date = $4,
               target_date = $5
           WHERE organization_id = $6 AND id = $7 AND version = $8
           RETURNING id`,
          [name, description, status, startDate, targetDate, organizationId, projectId, current.version],
        );
        if (!updated.rowCount) {
          return { kind: "conflict" as const, currentVersion: current.version };
        }

        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'project.updated', 'project', $4, $5::jsonb)`,
          [
            auditId,
            organizationId,
            principal.userId,
            projectId,
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
          targetType: "project",
          targetId: projectId,
          title: "Project details changed",
          body: `The project "${name}" was updated.`,
        });

        const project = await readProject(transaction, organizationId, projectId, principal.userId);
        if (!project) throw new Error("Updated project could not be read");
        if (idempotencyKey !== null && keyHash !== null && requestHash !== null) {
          await transaction.query(
            `INSERT INTO nexora.project_mutation_idempotency
               (organization_id, project_id, actor_user_id, operation, key_hash,
                request_hash, response_status, response_body)
             VALUES ($1, $2, $3, $4, $5, $6, 200, $7::jsonb)`,
            [
              organizationId,
              projectId,
              principal.userId,
              operation,
              keyHash,
              requestHash,
              JSON.stringify({ project }),
            ],
          );
        }
        return { kind: "ok" as const, project };
      },
      "guest",
    );

    if (result.kind === "not_found") {
      return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }
    if (result.kind === "forbidden") {
      return jsonError(request, 403, "PROJECT_MANAGEMENT_REQUIRED", "You do not have permission to manage this project.");
    }
    if (result.kind === "conflict") {
      return jsonError(request, 409, "VERSION_CONFLICT", "This project changed elsewhere. Reload before saving again.");
    }
    if (result.kind === "idempotency_conflict") {
      return jsonError(request, 409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for different project details.");
    }
    if (result.kind === "invalid_dates") {
      return jsonError(request, 400, "INVALID_DATE_RANGE", "Target date must be on or after the start date.");
    }
    if (result.kind === "invalid_transition") {
      return jsonError(request, 409, "INVALID_PROJECT_TRANSITION", "That project status change is not allowed.");
    }
    // A replay returns the stored result without re-notifying,
    // re-auditing, or re-publishing: the original attempt already
    // did all three.
    if (result.kind === "replayed") {
      return jsonOk(request, { project: result.project });
    }
    try {
      await publishRealtimeEvent({
        userId: principal.userId,
        organizationId,
        projectId,
        type: "project.updated",
        data: { projectId: result.project.id, projectName: result.project.name },
      });
    } catch (publishError) {
      logRouteFailure(request, "realtime.publish", publishError);
    }
    return jsonOk(request, { project: result.project });
  } catch (error) {
    return jsonServerFailure(request, "projects.update", error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, projectDeleteSchema);
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
        const visible = await readProject(transaction, organizationId, projectId, principal.userId);
        if (!visible) return { kind: "not_found" as const };
        if (!visible.can_manage) return { kind: "forbidden" as const };

        await lockProjectLifecycle(transaction, organizationId, projectId);
        const current = await readProject(transaction, organizationId, projectId, principal.userId, true);
        if (!current) return { kind: "not_found" as const };
        if (!current.can_manage) return { kind: "forbidden" as const };
        if (current.version !== parsed.value.expectedVersion) {
          return { kind: "conflict" as const, currentVersion: current.version };
        }

        const deleted = await transaction.query(
          `UPDATE nexora.projects
           SET deleted_at = pg_catalog.now(),
               deleted_by_user_id = $1
           WHERE organization_id = $2 AND id = $3 AND version = $4 AND deleted_at IS NULL
           RETURNING id`,
          [principal.userId, organizationId, projectId, current.version],
        );
        if (!deleted.rowCount) {
          return { kind: "conflict" as const, currentVersion: current.version };
        }

        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'project.deleted', 'project', $4, $5::jsonb)`,
          [
            auditId,
            organizationId,
            principal.userId,
            projectId,
            JSON.stringify({
              previousVersion: current.version,
              version: current.version + 1,
            }),
          ],
        );
        return { kind: "ok" as const, projectId };
      },
      "guest",
    );

    if (result.kind === "not_found") {
      return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }
    if (result.kind === "forbidden") {
      return jsonError(request, 403, "PROJECT_MANAGEMENT_REQUIRED", "You do not have permission to manage this project.");
    }
    if (result.kind === "conflict") {
      return jsonError(request, 409, "VERSION_CONFLICT", "This project changed elsewhere. Reload before saving again.");
    }
    return jsonOk(request, { projectId: result.projectId, deleted: true });
  } catch (error) {
    return jsonServerFailure(request, "projects.delete", error);
  }
}
