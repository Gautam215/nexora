import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { jsonError, jsonOk, jsonServerFailure } from "../../../../server/api.ts";
import { applyScanResult } from "../../../../server/db.ts";
import { scanCallbackSchema } from "../../../../security/scan-callback-schema.ts";

export const runtime = "nodejs";

// Scan-result callback for async GitHub Actions scanning
// (design: docs/async-scan-github-actions-design.md).
//
// This route deliberately does NOT use the browser origin check:
// the caller is a GitHub Actions runner, not a browser, and
// sends no Origin. Authentication is the shared secret alone
// (header x-nexora-scan-secret), compared timing-safe. The
// secret must be a long random value; when it is unset, the
// route fails closed with 503 instead of accepting verdicts
// unauthenticated. A failed authentication is logged as a
// structured scan.callback_auth_failed event (endpoint only,
// never the secret).
//
// The route always answers 200 after authentication, whether
// the verdict was applied or ignored (stale version, deleted
// file, duplicate delivery): a stale callback is an expected
// race, and the pending-only database function (migration 0064)
// is the authority on what changed. The workflow treats a 500
// as a failed delivery, which is the honest signal when the
// verdict could not be recorded at all.
export class ScanCallbackConfigurationError extends Error {
  constructor() {
    super("Scan callbacks are not configured");
    this.name = "ScanCallbackConfigurationError";
  }
}

function scanCallbackSecretMatches(presented: string | null): boolean {
  const configured = process.env.NEXORA_SCAN_WEBHOOK_SECRET;
  if (!configured) throw new ScanCallbackConfigurationError();
  if (presented === null) return false;
  const configuredBuffer = Buffer.from(configured, "utf8");
  const presentedBuffer = Buffer.from(presented, "utf8");
  if (presentedBuffer.length !== configuredBuffer.length) return false;
  return timingSafeEqual(configuredBuffer, presentedBuffer);
}

export async function POST(request: NextRequest) {
  try {
    let matches: boolean;
    try {
      matches = scanCallbackSecretMatches(request.headers.get("x-nexora-scan-secret"));
    } catch (error) {
      if (error instanceof ScanCallbackConfigurationError) {
        return jsonError(request, 503, "SERVICE_UNAVAILABLE", "Scan callbacks are not configured.");
      }
      throw error;
    }
    if (!matches) {
      console.error(JSON.stringify({ event: "scan.callback_auth_failed", endpoint: "scan-result" }));
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    const body: unknown = await request.json().catch(() => null);
    const validation = scanCallbackSchema.safeParse(body);
    if (!validation.success) {
      return jsonError(request, 400, "VALIDATION_FAILED", "The scan result is not valid.");
    }
    const { fileId, version, outcome } = validation.data;
    await applyScanResult(fileId, version, outcome);
    return jsonOk(request, { ok: true });
  } catch (error) {
    return jsonServerFailure(request, "scan-result.callback", error);
  }
}
