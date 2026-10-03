import { z } from "zod";
import { PROJECT_STATUSES } from "./project-status.ts";

const projectName = z.string().trim().min(1).max(160);
const projectDescription = z
  .string()
  .trim()
  .max(10_000)
  .nullable()
  .transform((value) => value === "" ? null : value);
const dateValue = z.union([z.iso.date(), z.null()]);
const userId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const projectCreateSchema = z.strictObject({
  name: projectName,
  description: projectDescription.optional(),
  startDate: dateValue.optional(),
  targetDate: dateValue.optional(),
}).refine(
  (value) => !value.startDate || !value.targetDate || value.targetDate >= value.startDate,
  { path: ["targetDate"], message: "Target date must be on or after the start date." },
);

export const projectUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2_147_483_646),
  name: projectName.optional(),
  description: projectDescription.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  startDate: dateValue.optional(),
  targetDate: dateValue.optional(),
}).refine(
  (value) => Object.entries(value).some(([key, field]) => key !== "expectedVersion" && field !== undefined),
  { message: "At least one project field must be changed." },
);

export const projectMemberCreateSchema = z.strictObject({
  userId,
  role: z.enum(["manager", "member", "viewer"]),
});

export const projectMemberUpdateSchema = z.strictObject({
  role: z.enum(["manager", "member", "viewer"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((value) => value.role !== undefined || value.status !== undefined);
