import type { NextRequest } from "next/server";
import { jsonError, jsonOk } from "../../../server/api.ts";
import { checkDatabaseConnection } from "../../../server/db.ts";

export const runtime = "nodejs";

// Readiness, distinct from liveness (GET /api/health, which always
// answers 200 so a Neon scale-to-zero wake-up does not flap a liveness
// probe). Readiness answers 200 only when the database probe succeeds
// and 503 otherwise, so a load balancer or orchestrator can hold
// traffic until the process can actually serve it. Unauthenticated
// like health — a probe cannot sign in — and it returns no detail
// beyond the boolean, so there is nothing to leak.
export async function GET(request: NextRequest) {
  const configured = Boolean(process.env.DATABASE_URL);
  const up = configured ? await checkDatabaseConnection() : false;
  if (!up) {
    return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Service is not ready.");
  }
  return jsonOk(request, { ready: true, database: "up" });
}
