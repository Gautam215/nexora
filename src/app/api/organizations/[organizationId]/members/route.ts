import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  organizationInvitationCreateSchema,
} from "../../../../../security/auth-schemas.ts";
import { createOpaqueToken, hashOpaqueToken } from "../../../../../security/tokens.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  logRouteFailure,
  parseJson,
} from "../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../server/db.ts";
import { sendOrganizationInvitationEmail } from "../../../../../server/email.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

function isPendingInvitationConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "invitations_one_pending_per_org_email"
  );
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const memberResult = await transaction.query<{
          user_id: string;
          email: string;
          display_name: string;
          role: string;
          status: string;
          joined_at: Date | null;
        }>(
          "SELECT * FROM nexora.list_current_organization_members($1)",
          [organizationId],
        );
        const viewerRole = memberResult.rows.find(
          (member) => member.user_id === principal.userId,
        )?.role;
        const managesMembers = viewerRole === "owner" || viewerRole === "admin";
        const invitationResult = managesMembers
          ? await transaction.query<{
              id: string;
              email: string;
              role: string;
              created_at: Date;
              expires_at: Date;
            }>(
              `SELECT id, email, role::text AS role, created_at, expires_at
               FROM nexora.organization_invitations
               WHERE organization_id = $1
                 AND accepted_at IS NULL
                 AND revoked_at IS NULL
               ORDER BY created_at, id`,
              [organizationId],
            )
          : { rows: [] };
        const members = managesMembers
          ? memberResult.rows
          : memberResult.rows.map(({ email: _email, ...member }) => member);
        return {
          members,
          invitations: invitationResult.rows,
          viewerRole,
          viewerUserId: principal.userId,
        };
      },
      "guest",
    );
    return jsonOk(request, result);
  } catch (error) {
    return jsonServerFailure(request, "organizations.members.list", error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, organizationInvitationCreateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const { organizationId } = await params;
    const { email, role } = parsed.value;
    if (await isRateLimited(request, "organization-invite-user", principal.userId, 25, 3600, 60)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many invitations. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }
    if (await isRateLimited(request, "organization-invite-email", email, 3, 3600, 40)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many invitations for that address. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }

    const token = createOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    if (!tokenHash) throw new Error("Unable to create invitation token");
    const invitationId = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const result = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const members = await transaction.query<{ email: string }>(
          "SELECT email FROM nexora.list_current_organization_members($1)",
          [organizationId],
        );
        if (members.rows.some((member) => member.email === email)) {
          return { alreadyMember: true as const };
        }

        const organization = await transaction.query<{ name: string }>(
          "SELECT name FROM nexora.organizations WHERE id = $1 LIMIT 1",
          [organizationId],
        );
        const organizationName = organization.rows[0]?.name;
        if (!organizationName) throw new Error("Organization is unavailable");
        const invitation = await transaction.query<{
          id: string;
          email: string;
          role: string;
          expires_at: Date;
        }>(
          `INSERT INTO nexora.organization_invitations
             (id, organization_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, email, role::text AS role, expires_at`,
          [invitationId, organizationId, email, role, tokenHash, principal.userId, expiresAt],
        );
        await transaction.query(
          `INSERT INTO nexora.audit_events
             (id, organization_id, actor_user_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, 'invitation.created', 'invitation', $4, $5::jsonb)`,
          [randomUUID(), organizationId, principal.userId, invitationId, JSON.stringify({ role })],
        );
        return {
          alreadyMember: false as const,
          invitation: invitation.rows[0],
          organizationName,
        };
      },
      "admin",
    );

    if (result.alreadyMember) {
      return jsonError(request, 409, "ALREADY_A_MEMBER", "That person already belongs to this workspace.");
    }
    let emailAccepted = true;
    try {
      await sendOrganizationInvitationEmail(email, token, result.organizationName);
    } catch (error) {
      emailAccepted = false;
      logRouteFailure(request, "organizations.invitation.email", error);
    }
    return jsonOk(request, { invitation: result.invitation, emailAccepted }, 201);
  } catch (error) {
    if (isPendingInvitationConflict(error)) {
      return jsonError(request, 409, "INVITATION_PENDING", "A pending invitation already exists for that address.");
    }
    return jsonServerFailure(request, "organizations.members.invite", error);
  }
}
