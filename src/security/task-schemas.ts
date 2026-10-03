import { z } from "zod";

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());
const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(20_000).nullable().transform((value) => value === "" ? null : value);
const dateValue = z.union([z.iso.date(), z.null()]);
const labels = z.array(z.string().trim().min(1).max(24)).max(12).refine(
  (values) => new Set(values.map((value) => value.toLocaleLowerCase("en-US"))).size === values.length,
);
const dependencies = z.array(uuid).max(50).refine(
  (values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
);
const estimate = z.union([z.number().min(0).max(99_999.99), z.null()]);
const taskPriority = z.enum(TASK_PRIORITIES);

export const taskCreateSchema = z.strictObject({
  title,
  description: description.optional(),
  statusId: uuid.optional(),
  priority: taskPriority.optional(),
  assigneeId: z.union([uuid, z.null()]).optional(),
  milestoneId: z.union([uuid, z.null()]).optional(),
  parentTaskId: z.union([uuid, z.null()]).optional(),
  labels: labels.optional(),
  dueDate: dateValue.optional(),
  estimatedEffortHours: estimate.optional(),
  dependencies: dependencies.optional(),
});

export const taskUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2_147_483_646),
  title: title.optional(),
  description: description.optional(),
  statusId: uuid.optional(),
  priority: taskPriority.optional(),
  assigneeId: z.union([uuid, z.null()]).optional(),
  milestoneId: z.union([uuid, z.null()]).optional(),
  parentTaskId: z.union([uuid, z.null()]).optional(),
  labels: labels.optional(),
  dueDate: dateValue.optional(),
  estimatedEffortHours: estimate.optional(),
  dependencies: dependencies.optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
}).refine(
  (value) => Object.entries(value).some(([key, field]) => key !== "expectedVersion" && field !== undefined),
  { message: "At least one task field must be changed." },
);

export const taskArchiveSchema = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2_147_483_646),
});

export const taskCommentCreateSchema = z.strictObject({
  body: z.string().min(1).max(4000).refine((value) => value.trim().length > 0),
});
