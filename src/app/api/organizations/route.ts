import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { organizationCreateSchema } from "../../../security/auth-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../server/api.ts";
import { getAuthPrincipal } from "../../../server/auth.ts";
import { isRateLimited } from "../../../server/auth-rate-limit.ts";
import { withUserContext } from "../../../server/db.ts";

export const runtime = "nodejs";

function isSlugConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "organizations_slug_unique"
  );
}

export async function GET(request: NextRequest) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const organizations = await withUserContext(principal.userId, async (transaction) => {
      const result = await transaction.query<{
        id: string;
        name: string;
        slug: string;
        role: string;
        created_at: Date;
      }>(
        `SELECT organization.id, organization.name, organization.slug,
                membership.role::text AS role, organization.created_at
         FROM nexora.organization_memberships AS membership
         JOIN nexora.organizations AS organization
           ON organization.id = membership.organization_id
         WHERE membership.user_id = $1
           AND membership.status = 'active'
           AND organization.status = 'active'
         ORDER BY organization.created_at, organization.id`,
        [principal.userId],
      );
      return result.rows;
    });
    return jsonOk(request, { organizations });
  } catch (error) {
    return jsonServerFailure(request, "organizations.list", error);
  }
}

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, organizationCreateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    if (
      await isRateLimited(
        request,
        "organization-create-user",
        principal.userId,
        5,
        3600,
        30,
      )
    ) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many workspace creations. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }

    const organizationId = randomUUID();
    const auditId = randomUUID();
    const { name, slug } = parsed.value;
    let created: { id: string; name: string; slug: string; created_at: Date };
    try {
      created = await withUserContext(principal.userId, async (transaction) => {
        const organization = await transaction.query<{
          id: string;
          name: string;
          slug: string;
          created_at: Date;
        }>(
          `INSERT INTO nexora.organizations (id, name, slug, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, slug, created_at`,
          [organizationId, name, slug, principal.userId],
        );
        const row = organization.rows[0];
        if (!row) throw new Error("Organization insert returned no row");

        await transaction.query(
          `INSERT INTO nexora.organization_memberships
             (organization_id, user_id, role, status, joined_at)
           VALUES ($1, $2, 'owner', 'active', pg_catalog.clock_timestamp())`,
          [organizationId, principal.userId],
        );
        await transaction.query(
          "SELECT pg_catalog.set_config('nexora.organization_id', $1, true)",
          [organizationId],
        );
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'organization.created', 'organization', $2, $4::jsonb)`,
          [auditId, organizationId, principal.userId, JSON.stringify({ slug })],
        );
        return row;
      });
    } catch (error) {
      if (isSlugConflict(error)) {
        return jsonError(request, 409, "SLUG_TAKEN", "That workspace address is already in use.");
      }
      throw error;
    }

    return jsonOk(request, { organization: created }, 201);
  } catch (error) {
    return jsonServerFailure(request, "organizations.create", error);
  }
}
