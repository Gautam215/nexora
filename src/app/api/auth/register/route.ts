import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { registerSchema } from "../../../../security/auth-schemas.ts";
import { createOpaqueToken, hashOpaqueToken } from "../../../../security/tokens.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  logRouteFailure,
  parseJson,
} from "../../../../server/api.ts";
import { isRateLimited } from "../../../../server/auth-rate-limit.ts";
import { withUserContext } from "../../../../server/db.ts";
import { sendVerificationEmail, validateEmailDeliveryConfig } from "../../../../server/email.ts";
import { hashPassword } from "../../../../security/password.ts";

export const runtime = "nodejs";

function isDuplicateEmail(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "users_email_unique"
  );
}

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, registerSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  const { name, email, password } = parsed.value;
  try {
    if (await isRateLimited(request, "register-email", email, 5, 3600, 30)) {
      return jsonError(
        request,
        429,
        "RATE_LIMITED",
        "Too many attempts. Wait before trying again.",
        { "retry-after": "3600" },
      );
    }
    validateEmailDeliveryConfig();

    const userId = randomUUID();
    const token = createOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    if (!tokenHash) throw new Error("Unable to create verification token");
    const passwordHash = await hashPassword(password);
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

    try {
      await withUserContext(userId, async (transaction) => {
        await transaction.query(
          `INSERT INTO nexora.users (id, email, display_name, password_hash)
           VALUES ($1, $2, $3, $4)`,
          [userId, email, name, passwordHash],
        );
        const issued = await transaction.query<{ issued: boolean }>(
          `SELECT nexora.issue_email_verification($1, $2, $3, $4) AS issued`,
          [email, randomUUID(), tokenHash, expiresAt],
        );
        if (issued.rows[0]?.issued !== true) {
          throw new Error("Unable to issue verification token");
        }
      });
    } catch (error) {
      if (!isDuplicateEmail(error)) throw error;
      return jsonOk(
        request,
        { message: "If the address is eligible, a confirmation link will arrive by email." },
        202,
      );
    }

    try {
      await sendVerificationEmail(email, token);
    } catch (error) {
      logRouteFailure(request, "auth.register.email", error);
    }
    return jsonOk(
      request,
      { message: "If the address is eligible, a confirmation link will arrive by email." },
      202,
    );
  } catch (error) {
    return jsonServerFailure(request, "auth.register", error);
  }
}
