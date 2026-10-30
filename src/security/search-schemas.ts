import { z } from "zod";

const uuid = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());

export const MAX_SEARCH_OFFSET = 10_000;

const searchLimit = z.string()
  .regex(/^\d{1,2}$/)
  .default("20")
  .transform(Number)
  .pipe(z.number().int().min(1).max(50));

const searchOffset = z.string()
  .regex(/^\d{1,6}$/)
  .default("0")
  .transform(Number)
  .pipe(z.number().int().min(0).max(MAX_SEARCH_OFFSET));

const searchDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

const projectStatus = z.enum(["planned", "active", "on_hold", "completed", "archived"]);

export const searchRequestSchema = z.strictObject({
  q: z.string()
    .trim()
    .min(2)
    .max(120)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  type: z.enum(["all", "project", "task", "comment", "member", "file"]).default("all"),
  projectId: uuid.optional(),
  // Date range on created_at (member rows use joined_at). `to` is inclusive
  // as a calendar day; the route turns it into an exclusive upper bound.
  from: searchDate.optional(),
  to: searchDate.optional(),
  ownerId: uuid.optional(),
  // Project status. It scopes projects by their own status and tasks,
  // comments and files by their project's status; members have no project
  // and are never filtered by it.
  status: projectStatus.optional(),
  limit: searchLimit,
  offset: searchOffset,
}).refine(
  (data) => !data.from || !data.to || data.from <= data.to,
  { message: "The from date must be on or before the to date." },
);

export type SearchEntityType = Exclude<z.infer<typeof searchRequestSchema>["type"], "all">;
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export function parseSearchRequest(params: URLSearchParams) {
  return searchRequestSchema.safeParse({
    q: params.get("q") ?? undefined,
    type: params.get("type") ?? undefined,
    projectId: params.get("projectId") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    ownerId: params.get("ownerId") ?? undefined,
    status: params.get("status") ?? undefined,
    limit: params.get("limit") ?? undefined,
    offset: params.get("offset") ?? undefined,
  });
}

export function hasMoreSearchResults(offset: number, pageLength: number, total: number): boolean {
  return offset < MAX_SEARCH_OFFSET && offset + pageLength < total;
}
