import { z } from "zod";

const email = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email()
  .transform((value) => value.toLowerCase());

const password = z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= 12 && length <= 128;
});

const loginPassword = z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= 1 && length <= 128;
});

const opaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

// Authenticator code: exactly 6 digits. Kept as a string so a
// leading zero survives, and so the shape rejects anything that
// is not a code before any verification runs.
export const totpCode = z.string().regex(/^\d{6}$/);

export const registerSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email,
  password,
});

export const loginSchema = z.strictObject({
  email,
  password: loginPassword,
});

export const emailSchema = z.strictObject({ email });

export const tokenSchema = z.strictObject({ token: opaqueToken });

export const resetPasswordSchema = z.strictObject({
  token: opaqueToken,
  password,
});

// Logged-in password change. The current password uses the login
// password shape (1–128) so that a legacy short password can still be
// verified; the new password uses the full registration policy
// (12–128), enforced here so that a policy failure is a 400, not a 500
// from hashPassword.
export const changePasswordSchema = z.strictObject({
  currentPassword: loginPassword,
  newPassword: password,
});

// Destructive-action re-entry: deleting an account requires the
// current password in addition to the typed-email confirmation,
// so a stolen session alone cannot destroy the account. The login
// shape (1–128) is used so a legacy short password still verifies.
// totpCode is optional at the schema level because unenrolled
// callers have no code; the route requires it when the caller has
// an enrolled authenticator, and rejects its absence then.
export const accountDeletionSchema = z.strictObject({
  confirmation: email,
  password: loginPassword,
  totpCode: totpCode.optional(),
});

// Authenticator enrollment: setup returns the secret, verify
// proves possession of it, disable removes it (password first,
// so a stolen session alone cannot strip the second factor).
export const totpVerifySchema = z.strictObject({
  code: totpCode,
});

export const totpDisableSchema = z.strictObject({
  password: loginPassword,
  code: totpCode,
});

export const sessionRevokeSchema = z.strictObject({
  sessionId: z.string().uuid(),
});

export const organizationCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

// Organization settings use the same name and slug rules as creation;
// at least one field must be present, and only the provided fields change.
export const organizationDeleteSchema = z.strictObject({
  // Explicit confirmation: the caller must repeat the workspace's
  // current slug. A mismatch is a conflict, not a validation failure,
  // because the slug itself is well-formed but does not match.
  slug: z.string().trim().toLowerCase().min(2).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  // Destructive-action re-entry, same rule as account deletion:
  // the owner's current password, so a stolen session alone cannot
  // destroy the workspace. totpCode is optional at the schema
  // level for the same reason as account deletion: the route
  // requires it only when the caller has an enrolled authenticator.
  password: loginPassword,
  totpCode: totpCode.optional(),
});

export const organizationUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    // Per-organization storage quota in bytes. Null clears the
    // quota (no organization cap; per-task caps still apply).
    // No product quota value is invented: this is a configuration
    // an owner or admin sets explicitly. 1 TiB is a schema guard
    // against nonsense values, not a recommended quota.
    storageQuotaBytes: z.number().int().positive().max(1099511627776).nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.slug !== undefined || value.storageQuotaBytes !== undefined,
    {
      message: "At least one organization field must be changed.",
    },
  );

export const organizationInvitationCreateSchema = z.strictObject({
  email,
  role: z.enum(["admin", "member", "guest"]),
});

export const membershipUpdateSchema = z.strictObject({
  role: z.enum(["admin", "member", "guest"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((value) => value.role !== undefined || value.status !== undefined);

export function normalizeAuthEmail(value: string): string {
  return value.trim().toLowerCase();
}
