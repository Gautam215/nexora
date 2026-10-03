import { z } from "zod";

export const taskCommentCreateSchema = z.strictObject({
  body: z.string().trim().min(1).max(4000),
});
