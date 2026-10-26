import type { NextRequest } from "next/server";
import { jsonOk } from "../../../server/api.ts";
import { checkDatabaseConnection } from "../../../server/db.ts";

export const runtime = "nodejs";

// Liveness only, not readiness: a live process always answers 200, and
// the database field — not the status code — reports database state, so
// a Neon scale-to-zero wake-up does not flap a liveness probe. No
// authentication: a health probe cannot sign in. No secrets, versions,
// or database detail are ever returned.
export async function GET(request: NextRequest) {
  const configured = Boolean(process.env.DATABASE_URL);
  const up = configured ? await checkDatabaseConnection() : false;
  const database = !configured ? "unconfigured" : up ? "up" : "unavailable";
  return jsonOk(request, {
    status: database === "up" ? "ok" : "degraded",
    database,
  });
}
