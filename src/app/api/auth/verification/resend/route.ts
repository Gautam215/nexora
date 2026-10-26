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
import { issueEmailVerification } from "../../../../../server/db.ts";
import {
  sendVerificationEmail,
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
    if (await isRateLimited(request, "verification-email", email, 3, 3600, 20)) {
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
    if (!tokenHash) throw new Error("Unable to create verification token");
    const issued = await issueEmailVerification(
      email,
      randomUUID(),
      tokenHash,
      new Date(Date.now() + 2 * 60 * 60 * 1000),
    );
    if (issued) {
      // No swallow here: see the password-reset route for why a delivery
      // failure must surface as 503 instead of a 202 claiming a link
      // "will arrive".
      await sendVerificationEmail(email, token);
    }
    return jsonOk(
      request,
      { message: "If the address is eligible, a confirmation link will arrive by email." },
      202,
    );
  } catch (error) {
    return jsonServerFailure(request, "auth.verification.resend", error);
  }
}
