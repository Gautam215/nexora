import type { NextRequest } from "next/server";
import {
  jsonError,
  jsonOk,
  jsonServerFailure,
} from "../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../server/auth.ts";
import { withOrganizationContext } from "../../../../server/db.ts";

export const runtime = "nodejs";

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
          created_at: Date;
        }>(
          `SELECT organization.id, organization.name, organization.slug,
                  membership.role::text AS role, organization.created_at
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
    return jsonOk(request, { organization });
  } catch (error) {
    return jsonServerFailure(request, "organizations.get", error);
  }
}
