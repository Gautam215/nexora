import { z } from "zod";

// Scan-result callback payload (async GitHub Actions scanning,
// migration 0064). Strict: unknown keys are rejected, and the
// outcome enum is the only accepted vocabulary — the route maps
// 'clean' to clean and anything else ('infected', 'error') to
// quarantined via the pending-only database function, so a
// future outcome value cannot slip through as clean.
export const scanCallbackSchema = z.strictObject({
  fileId: z.string().uuid(),
  version: z.number().int().positive(),
  outcome: z.enum(["clean", "infected", "error"]),
  runId: z.string().trim().min(1).max(128),
});
