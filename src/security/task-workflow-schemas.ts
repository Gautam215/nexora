import { z } from "zod";
import { TASK_PRIORITIES } from "./task-schemas.ts";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());
const statusName = z.string().trim().min(1).max(60);

export const taskWorkflowUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2_147_483_646),
  statuses: z.array(z.strictObject({
    id: uuid.optional(),
    name: statusName,
    isDone: z.boolean(),
  })).min(2).max(12),
}).refine(
  (value) => value.statuses.filter((status) => status.isDone).length === 1,
  { path: ["statuses"], message: "Choose exactly one completion column." },
).refine(
  (value) => new Set(value.statuses.map((status) => status.id?.toLowerCase()).filter(Boolean)).size
    === value.statuses.filter((status) => status.id).length,
  { path: ["statuses"], message: "A workflow column can only appear once." },
).refine(
  (value) => new Set(value.statuses.map((status) => status.name.toLocaleLowerCase("en-US"))).size
    === value.statuses.length,
  { path: ["statuses"], message: "Workflow column names must be unique." },
);

export const taskBulkUpdateSchema = z.strictObject({
  tasks: z.array(z.strictObject({
    id: uuid,
    expectedVersion: z.number().int().min(1).max(2_147_483_646),
  })).min(1).max(50),
  priority: z.enum(TASK_PRIORITIES),
}).refine(
  (value) => new Set(value.tasks.map((task) => task.id.toLowerCase())).size === value.tasks.length,
  { path: ["tasks"], message: "A task can only appear once." },
);
