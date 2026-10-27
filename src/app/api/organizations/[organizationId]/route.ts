import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  organizationDeleteSchema,
  organizationUpdateSchema,
} from "../../../../security/auth-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../server/auth.ts";
import { isRateLimited } from "../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../server/db.ts";

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    const organization = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const result = await transaction.query<{
          id: string;
          name: string;
          slug: string;
          role: string;
          storage_quota_bytes: string | null;
          storage_usage_bytes: string;
          created_at: Date;
        }>(
          `SELECT organization.id, organization.name, organization.slug,
                  membership.role::text AS role,
                  organization.storage_quota_bytes::text AS storage_quota_bytes,
                  (SELECT COALESCE(sum(byte_size), 0)::text FROM nexora.task_files
                   WHERE organization_id = organization.id AND deleted_at IS NULL) AS storage_usage_bytes,
                  organization.created_at
           FROM nexora.organizations AS organization
           JOIN nexora.organization_memberships AS membership
             ON membership.organization_id = organization.id
           WHERE organization.id = $1
             AND membership.user_id = $2
             AND membership.status = 'active'
             AND organization.status = 'active'
           LIMIT 1`,
          [organizationId, principal.userId],
        );
        return result.rows[0] ?? null;
      },
      "guest",
    );
    if (!organization) {
      return jsonError(request, 404, "ORGANIZATION_NOT_FOUND", "Workspace not found.");
    }
    return jsonOk(request, {
      organization: {
        ...organization,
        storage_quota_bytes: organization.storage_quota_bytes === null ? null : Number(organization.storage_quota_bytes),
        storage_usage_bytes: Number(organization.storage_usage_bytes),
      },
    });
  } catch (error) {
    return jsonServerFailure(request, "organizations.get", error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, organizationUpdateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    if (
      await isRateLimited(request, "organization-settings-user", principal.userId, 40, 3600, 80)
    ) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many workspace changes. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }

    const auditId = randomUUID();
    let updated:
      | { kind: "not_found" }
      | { kind: "forbidden" }
      | {
          kind: "ok";
          organization: {
            id: string;
            name: string;
            slug: string;
            storage_quota_bytes: number | null;
            storage_usage_bytes: number;
            updated_at: Date;
          };
        };
    try {
      updated = await withOrganizationContext(
        principal.userId,
        organizationId,
        async (transaction) => {
          const memberResult = await transaction.query<{ user_id: string; role: string }>(
            "SELECT user_id, role::text AS role FROM nexora.list_current_organization_members($1)",
            [organizationId],
          );
          const viewerRole = memberResult.rows.find(
            (member) => member.user_id === principal.userId,
          )?.role;
          const currentResult = await transaction.query<{
            id: string;
            name: string;
            slug: string;
            storage_quota_bytes: string | null;
          }>(
            `SELECT id, name, slug, storage_quota_bytes::text AS storage_quota_bytes
             FROM nexora.organizations
             WHERE id = $1 AND status = 'active' LIMIT 1`,
            [organizationId],
          );
          const current = currentResult.rows[0];
          if (!current || viewerRole === undefined) return { kind: "not_found" as const };
          if (viewerRole !== "owner" && viewerRole !== "admin") {
            return { kind: "forbidden" as const };
          }

          const name = parsed.value.name ?? current.name;
          const slug = parsed.value.slug ?? current.slug;
          const currentQuota = current.storage_quota_bytes === null ? null : Number(current.storage_quota_bytes);
          const quota = parsed.value.storageQuotaBytes !== undefined ? parsed.value.storageQuotaBytes : currentQuota;
          const changedFields = [
            ...(name !== current.name ? ["name"] : []),
            ...(slug !== current.slug ? ["slug"] : []),
            ...(quota !== currentQuota ? ["storageQuotaBytes"] : []),
          ];
          const result = await transaction.query<{
            id: string;
            name: string;
            slug: string;
            storage_quota_bytes: string | null;
            updated_at: Date;
          }>(
            `UPDATE nexora.organizations SET name = $1, slug = $2, storage_quota_bytes = $3
             WHERE id = $4 AND status = 'active'
             RETURNING id, name, slug, storage_quota_bytes::text AS storage_quota_bytes, updated_at`,
            [name, slug, quota, organizationId],
          );
          const rawRow = result.rows[0];
          if (!rawRow) return { kind: "not_found" as const };
          const usageResult = await transaction.query<{ byte_count: string }>(
            `SELECT COALESCE(sum(byte_size), 0)::text AS byte_count FROM nexora.task_files
             WHERE organization_id = $1 AND deleted_at IS NULL`,
            [organizationId],
          );
          const row = {
            ...rawRow,
            storage_quota_bytes: rawRow.storage_quota_bytes === null ? null : Number(rawRow.storage_quota_bytes),
            storage_usage_bytes: Number(usageResult.rows[0]?.byte_count ?? 0),
          };
          if (changedFields.length > 0) {
            await transaction.query(
              `INSERT INTO nexora.audit_events
                 (id, organization_id, actor_user_id, action, target_type, target_id, details)
               VALUES ($1, $2, $3, 'organization.updated', 'organization', $4, $5::jsonb)`,
              [
                auditId,
                organizationId,
                principal.userId,
                organizationId,
                JSON.stringify({
                  changedFields,
                  ...(name !== current.name
                    ? { previousName: current.name, name }
                    : {}),
                  ...(slug !== current.slug
                    ? { previousSlug: current.slug, slug }
                    : {}),
                  ...(quota !== currentQuota
                    ? { previousStorageQuotaBytes: currentQuota, storageQuotaBytes: quota }
                    : {}),
                }),
              ],
            );
          }
          return { kind: "ok" as const, organization: row };
        },
        "guest",
      );
    } catch (error) {
      if (isSlugConflict(error)) {
        return jsonError(request, 409, "SLUG_TAKEN", "That workspace address is already in use.");
      }
      throw error;
    }

    if (updated.kind === "not_found") {
      return jsonError(request, 404, "ORGANIZATION_NOT_FOUND", "Workspace not found.");
    }
    if (updated.kind === "forbidden") {
      return jsonError(
        request,
        403,
        "ORGANIZATION_MANAGEMENT_REQUIRED",
        "Only workspace owners and admins can change workspace settings.",
      );
    }
    return jsonOk(request, { organization: updated.organization });
  } catch (error) {
    return jsonServerFailure(request, "organizations.update", error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, organizationDeleteSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    if (
      await isRateLimited(request, "organization-deletion-user", principal.userId, 40, 3600, 80)
    ) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many workspace changes. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }

    const auditId = randomUUID();
    const deleted = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const memberResult = await transaction.query<{ user_id: string; role: string }>(
          "SELECT user_id, role::text AS role FROM nexora.list_current_organization_members($1)",
          [organizationId],
        );
        const viewerRole = memberResult.rows.find(
          (member) => member.user_id === principal.userId,
        )?.role;
        if (viewerRole === undefined) return { kind: "not_found" as const };
        // Organization deletion is owner-only: it is the most
        // destructive operation in the product, and unlike settings
        // it cannot be undone within the retention window by an admin.
        // This check comes before the locked read on purpose: a
        // FOR UPDATE read also applies the organizations UPDATE
        // policy, which is owner/admin-only, so a member's locked
        // read would silently return no row and misreport 404.
        if (viewerRole !== "owner") return { kind: "forbidden" as const };

        // Row lock serializes a concurrent delete or settings update.
        const currentResult = await transaction.query<{
          id: string;
          name: string;
          slug: string;
          status: string;
        }>(
          `SELECT id, name, slug, status FROM nexora.organizations
           WHERE id = $1 FOR UPDATE LIMIT 1`,
          [organizationId],
        );
        const current = currentResult.rows[0];
        if (!current || current.status !== "active") return { kind: "not_found" as const };
        if (parsed.value.slug !== current.slug) return { kind: "slug_mismatch" as const };

        const updated = await transaction.query(
          `UPDATE nexora.organizations
           SET status = 'deletion_pending', deleted_at = pg_catalog.now(),
               deleted_by_user_id = $2
           WHERE id = $1 AND status = 'active'
           RETURNING id`,
          [organizationId, principal.userId],
        );
        if (updated.rows.length === 0) return { kind: "not_found" as const };
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'organization.deleted', 'organization', $4, $5::jsonb)`,
          [
            auditId,
            organizationId,
            principal.userId,
            organizationId,
            JSON.stringify({ name: current.name, slug: current.slug }),
          ],
        );
        return { kind: "ok" as const, organizationId };
      },
      "guest",
    );

    if (deleted.kind === "not_found") {
      return jsonError(request, 404, "ORGANIZATION_NOT_FOUND", "Workspace not found.");
    }
    if (deleted.kind === "forbidden") {
      return jsonError(
        request,
        403,
        "ORGANIZATION_MANAGEMENT_REQUIRED",
        "Only workspace owners can delete a workspace.",
      );
    }
    if (deleted.kind === "slug_mismatch") {
      return jsonError(
        request,
        409,
        "ORGANIZATION_SLUG_MISMATCH",
        "The confirmation does not match this workspace address.",
      );
    }
    return jsonOk(request, { organizationId: deleted.organizationId, deleted: true });
  } catch (error) {
    return jsonServerFailure(request, "organizations.delete", error);
  }
}
