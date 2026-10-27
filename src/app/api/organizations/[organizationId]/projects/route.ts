import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { projectCreateSchema } from "../../../../../security/project-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../server/db.ts";

export const runtime = "nodejs";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key reused with different details");
    this.name = "IdempotencyConflictError";
  }
}

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

function readPagination(request: NextRequest): { limit: number; offset: number } | null {
  const limitValue = request.nextUrl.searchParams.get("limit") ?? "50";
  const offsetValue = request.nextUrl.searchParams.get("offset") ?? "0";
  if (!/^\d{1,6}$/.test(limitValue) || !/^\d{1,6}$/.test(offsetValue)) return null;
  const limit = Number(limitValue);
  const offset = Number(offsetValue);
  if (limit < 1 || limit > 100 || offset > 100_000) return null;
  return { limit, offset };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const pagination = readPagination(request);
  if (!pagination) {
    return jsonError(request, 400, "INVALID_PAGINATION", "Use a project page size from 1 to 100 and an offset up to 100000.");
  }
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    const projects = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const result = await transaction.query(
          `SELECT project.id,
                  project.organization_id,
                  project.name,
                  project.description,
                  project.status::text AS status,
                  project.owner_user_id,
                  owner.display_name AS owner_name,
                  project.start_date,
                  project.target_date,
                  project.version,
                  project.created_at,
                  project.updated_at,
                  (
                    SELECT membership.role::text
                    FROM nexora.project_memberships AS membership
                    WHERE membership.organization_id = project.organization_id
                      AND membership.project_id = project.id
                      AND membership.user_id = $2
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
           WHERE project.organization_id = $1
             AND project.deleted_at IS NULL
           ORDER BY project.created_at DESC, project.id DESC
           LIMIT $3 OFFSET $4`,
          [organizationId, principal.userId, pagination.limit + 1, pagination.offset],
        );
        return result.rows;
      },
      "guest",
    );
    const hasMore = projects.length > pagination.limit;
    return jsonOk(request, {
      projects: projects.slice(0, pagination.limit),
      pagination: { limit: pagination.limit, offset: pagination.offset, hasMore },
    });
  } catch (error) {
    return jsonServerFailure(request, "projects.list", error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, projectCreateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    if (await isRateLimited(request, "project-management-user", principal.userId, 40, 3600, 80)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many project changes. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }

    const rawIdempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const idempotencyKey = rawIdempotencyKey === "" ? null : rawIdempotencyKey;
    if (idempotencyKey !== null && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return jsonError(request, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid idempotency key and retry.");
    }
    const keyHash =
      idempotencyKey === null ? null : createHash("sha256").update(idempotencyKey).digest("hex");
    const requestHash =
      idempotencyKey === null
        ? null
        : createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");

    const projectId = randomUUID();
    const auditId = randomUUID();
    let project: {
      id: string;
      organization_id: string;
      name: string;
      description: string | null;
      status: string;
      owner_user_id: string;
      start_date: string | null;
      target_date: string | null;
      version: number;
      created_at: Date;
      updated_at: Date;
    };
    try {
      project = await withOrganizationContext(
        principal.userId,
        organizationId,
        async (transaction) => {
          // Idempotency replay, following the organization pattern:
          // same key + same body returns the stored project, same
          // key + different body is a conflict, and an expired row
          // is removed so a later retry can create afresh.
          if (idempotencyKey !== null && keyHash !== null && requestHash !== null) {
            const existing = await transaction.query<{
              request_hash: string;
              response_body: {
                project: {
                  id: string;
                  organization_id: string;
                  name: string;
                  description: string | null;
                  status: string;
                  owner_user_id: string;
                  start_date: string | null;
                  target_date: string | null;
                  version: number;
                  created_at: Date;
                  updated_at: Date;
                };
              };
              expires_at: Date;
            }>(
              `SELECT request_hash, response_body, expires_at
               FROM nexora.project_creation_idempotency
               WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3 AND key_hash = $4`,
              [organizationId, principal.userId, "project.create", keyHash],
            );
            const prior = existing.rows[0];
            if (prior && prior.expires_at > new Date()) {
              if (prior.request_hash !== requestHash) throw new IdempotencyConflictError();
              return prior.response_body.project;
            }
            if (prior) {
              await transaction.query(
                `DELETE FROM nexora.project_creation_idempotency
                 WHERE organization_id = $1 AND actor_user_id = $2 AND operation = $3 AND key_hash = $4`,
                [organizationId, principal.userId, "project.create", keyHash],
              );
            }
          }
          await transaction.query(
            `INSERT INTO nexora.projects
             (id, organization_id, name, description, owner_user_id, start_date, target_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              projectId,
              organizationId,
              parsed.value.name,
              parsed.value.description ?? null,
              principal.userId,
              parsed.value.startDate ?? null,
              parsed.value.targetDate ?? null,
            ],
          );

        await transaction.query(
          `INSERT INTO nexora.project_memberships
             (organization_id, project_id, user_id, role, status, added_by_user_id)
           VALUES ($1, $2, $3, 'manager', 'active', $3)`,
          [organizationId, projectId, principal.userId],
        );
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'project.created', 'project', $4, $5::jsonb)`,
          [
            auditId,
            organizationId,
            principal.userId,
            projectId,
            JSON.stringify({ status: "planned" }),
          ],
        );

        const created = await transaction.query<{
          id: string;
          organization_id: string;
          name: string;
          description: string | null;
          status: string;
          owner_user_id: string;
          start_date: string | null;
          target_date: string | null;
          version: number;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT id, organization_id, name, description, status::text AS status,
                  owner_user_id, start_date, target_date, version, created_at, updated_at
           FROM nexora.projects
           WHERE organization_id = $1 AND id = $2`,
          [organizationId, projectId],
        );
        const createdProject = created.rows[0];
        if (!createdProject) throw new Error("Created project could not be read");
        if (idempotencyKey !== null && keyHash !== null && requestHash !== null) {
          await transaction.query(
            `INSERT INTO nexora.project_creation_idempotency
               (organization_id, actor_user_id, operation, key_hash, request_hash, response_status, response_body)
             VALUES ($1, $2, $3, $4, $5, 201, $6::jsonb)`,
            [organizationId, principal.userId, "project.create", keyHash, requestHash, JSON.stringify({ project: createdProject })],
          );
        }
        return createdProject;
        },
        "member",
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonError(request, 409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for different project details.");
      }
      throw error;
    }

    return jsonOk(request, { project }, 201);
  } catch (error) {
    return jsonServerFailure(request, "projects.create", error);
  }
}
