import { z } from "zod";

const uuid = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());

const searchLimit = z.string()
  .regex(/^\d{1,2}$/)
  .default("20")
  .transform(Number)
  .pipe(z.number().int().min(1).max(50));

const searchOffset = z.string()
  .regex(/^\d{1,6}$/)
  .default("0")
  .transform(Number)
  .pipe(z.number().int().min(0).max(10_000));

export const searchRequestSchema = z.strictObject({
  q: z.string()
    .trim()
    .min(2)
    .max(120)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  type: z.enum(["all", "project", "task", "comment", "member", "file"]).default("all"),
  projectId: uuid.optional(),
  limit: searchLimit,
  offset: searchOffset,
});

export type SearchEntityType = Exclude<z.infer<typeof searchRequestSchema>["type"], "all">;
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export function parseSearchRequest(params: URLSearchParams) {
  return searchRequestSchema.safeParse({
    q: params.get("q") ?? undefined,
    type: params.get("type") ?? undefined,
    projectId: params.get("projectId") ?? undefined,
    limit: params.get("limit") ?? undefined,
    offset: params.get("offset") ?? undefined,
  });
}
