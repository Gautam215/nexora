import { createHash, randomUUID } from "node:crypto";
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

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

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

class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key reused with different details");
    this.name = "IdempotencyConflictError";
  }
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

    const organizationId = randomUUID();
    const auditId = randomUUID();
    const { name, slug } = parsed.value;
    let created: { id: string; name: string; slug: string; created_at: Date };
    try {
      created = await withUserContext(principal.userId, async (transaction) => {
        // Idempotency replay, following the project-update pattern:
        // same key + same body returns the stored organization, same
        // key + different body is a conflict, and an expired row is
        // removed so a later retry can create afresh.
        if (idempotencyKey !== null && keyHash !== null && requestHash !== null) {
          const existing = await transaction.query<{
            request_hash: string;
            response_body: { organization: { id: string; name: string; slug: string; created_at: Date } };
            expires_at: Date;
          }>(
            `SELECT request_hash, response_body, expires_at
             FROM nexora.organization_creation_idempotency
             WHERE actor_user_id = $1 AND operation = $2 AND key_hash = $3`,
            [principal.userId, "organization.create", keyHash],
          );
          const prior = existing.rows[0];
          if (prior && prior.expires_at > new Date()) {
            if (prior.request_hash !== requestHash) throw new IdempotencyConflictError();
            return prior.response_body.organization;
          }
          if (prior) {
            await transaction.query(
              `DELETE FROM nexora.organization_creation_idempotency
               WHERE actor_user_id = $1 AND operation = $2 AND key_hash = $3`,
              [principal.userId, "organization.create", keyHash],
            );
          }
        }
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
        if (idempotencyKey !== null && keyHash !== null && requestHash !== null) {
          await transaction.query(
            `INSERT INTO nexora.organization_creation_idempotency
               (actor_user_id, operation, key_hash, request_hash, response_status, response_body)
             VALUES ($1, $2, $3, $4, 201, $5::jsonb)`,
            [principal.userId, "organization.create", keyHash, requestHash, JSON.stringify({ organization: row })],
          );
        }
        return row;
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return jsonError(request, 409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for different workspace details.");
      }
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
