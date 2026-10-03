import { randomUUID } from "node:crypto";
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

    const projectId = randomUUID();
    const auditId = randomUUID();
    const project = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
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
        const project = created.rows[0];
        if (!project) throw new Error("Created project could not be read");
        return project;
      },
      "member",
    );

    return jsonOk(request, { project }, 201);
  } catch (error) {
    return jsonServerFailure(request, "projects.create", error);
  }
}
