import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { emailSchema } from "../../../../../security/auth-schemas.ts";
import { createOpaqueToken, hashOpaqueToken } from "../../../../../security/tokens.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  parseJson,
} from "../../../../../server/api.ts";
import { isRateLimited } from "../../../../../server/auth-rate-limit.ts";
import { issuePasswordReset } from "../../../../../server/db.ts";
import {
  sendPasswordResetEmail,
  validateEmailDeliveryConfig,
  verifyEmailDelivery,
} from "../../../../../server/email.ts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, emailSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const { email } = parsed.value;
    if (await isRateLimited(request, "password-reset-email", email, 3, 3600, 20)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }
    validateEmailDeliveryConfig();
    await verifyEmailDelivery();

    const token = createOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    if (!tokenHash) throw new Error("Unable to create password reset token");
    const issued = await issuePasswordReset(
      email,
      randomUUID(),
      tokenHash,
      new Date(Date.now() + 60 * 60 * 1000),
    );
    if (issued) {
      // No swallow here: a delivery failure must reach jsonServerFailure
      // (503), not a 202 claiming instructions "will arrive". The verify
      // above means this path is only reached for a transient failure
      // after a successful verify, and an unissued (ineligible) address
      // still receives the same 202 as before.
      await sendPasswordResetEmail(email, token);
    }
    return jsonOk(
      request,
      { message: "If the address is eligible, password reset instructions will arrive by email." },
      202,
    );
  } catch (error) {
    return jsonServerFailure(request, "auth.password-reset.request", error);
  }
}
