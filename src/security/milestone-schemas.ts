import { z } from "zod";
import { MILESTONE_STATUSES } from "./milestone-status.ts";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const name = z.string().trim().min(1).max(160);
const description = z.string().trim().max(10_000).nullable().transform((value) => value === "" ? null : value);
const dateValue = z.union([z.iso.date(), z.null()]);
const dependencies = z.array(uuid).max(50).refine((values) => new Set(values).size === values.length);

function validDateRange(value: { startDate?: string | null; endDate?: string | null }) {
  return !value.startDate || !value.endDate || value.endDate >= value.startDate;
}

export const milestoneCreateSchema = z.strictObject({
  name,
  description: description.optional(),
  startDate: dateValue.optional(),
  endDate: dateValue.optional(),
  dependencies: dependencies.optional(),
}).refine(validDateRange, {
  path: ["endDate"],
  message: "End date must be on or after the start date.",
});

export const milestoneUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2_147_483_646),
  name: name.optional(),
  description: description.optional(),
  startDate: dateValue.optional(),
  endDate: dateValue.optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  dependencies: dependencies.optional(),
}).refine(validDateRange, {
  path: ["endDate"],
  message: "End date must be on or after the start date.",
}).refine(
  (value) => Object.entries(value).some(([key, field]) => key !== "expectedVersion" && field !== undefined),
  { message: "At least one milestone field must be changed." },
);
