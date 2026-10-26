import type { NextRequest } from "next/server";
import { hasSameOrigin, jsonError } from "../../../../../../server/api.ts";
import { safeReturnPath } from "../../../../../../security/return-path.ts";
import { handleOAuthStart } from "../../../../../../server/oauth/start.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  let next = "/workspaces";
  try {
    const body = (await request.json()) as { next?: unknown };
    const validated = safeReturnPath(body?.next);
    if (validated) next = validated;
  } catch {
    // No usable body: fall back to the default return path.
  }
  return handleOAuthStart(request, "signin", next, null);
}
