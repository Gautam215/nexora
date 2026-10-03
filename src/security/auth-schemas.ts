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
