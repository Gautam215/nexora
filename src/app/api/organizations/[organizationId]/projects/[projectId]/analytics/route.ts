import type { NextRequest } from "next/server";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../server/auth.ts";
import { withOrganizationContext } from "../../../../../../../server/db.ts";
import { readProjectAnalytics } from "../../../../../../../server/project-analytics.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");

    const { organizationId, projectId } = await params;
    if (!UUID_PATTERN.test(projectId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project identifier is invalid.");
    }

    const analytics = await withOrganizationContext(
      principal.userId,
      organizationId,
      (transaction) => readProjectAnalytics(transaction, organizationId, projectId),
      "guest",
    );
    if (!analytics) return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    return jsonOk(request, analytics);
  } catch (error) {
    return jsonServerFailure(request, "project-analytics.get", error);
  }
}
