import "server-only";
import { randomUUID } from "node:crypto";
import { withOrganizationContext } from "../db.ts";
import type { AiWorkflow } from "./provider.ts";

// AI execution records (migration 0034). Each call writes exactly two
// short transactions — start, then complete or fail — around the
// provider call, which runs outside any transaction. A transaction
// spanning a provider round-trip would hold a pooled connection for
// up to the 30-second provider timeout and exhaust the pool under
// load. RLS additionally restricts every write to the caller's own
// rows in the current organization, so a forged execution id cannot
// complete or fail another user's record: the UPDATE affects zero
// rows and the caller gets an error, not a silent success.

export async function startAiExecution(
  userId: string,
  organizationId: string,
  projectId: string | null,
  workflow: AiWorkflow,
  provider: string,
  model: string,
): Promise<string> {
  const executionId = randomUUID();
  await withOrganizationContext(userId, organizationId, async (transaction) => {
    await transaction.query(
      `INSERT INTO nexora.ai_executions
         (id, organization_id, project_id, user_id, workflow, provider, model, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'started')`,
      [executionId, organizationId, projectId, userId, workflow, provider, model],
    );
  });
  return executionId;
}

export async function completeAiExecution(
  userId: string,
  organizationId: string,
  executionId: string,
  usage: { promptTokens: number; completionTokens: number; latencyMs: number },
): Promise<void> {
  const updated = await withOrganizationContext(userId, organizationId, async (transaction) => {
    const result = await transaction.query(
      `UPDATE nexora.ai_executions
       SET status = 'succeeded',
           prompt_tokens = $4,
           completion_tokens = $5,
           latency_ms = $6,
           completed_at = pg_catalog.now()
       WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND status = 'started'`,
      [executionId, organizationId, userId, usage.promptTokens, usage.completionTokens, usage.latencyMs],
    );
    return result.rowCount ?? 0;
  });
  if (updated !== 1) {
    throw new Error("AI execution record could not be completed");
  }
}

export async function failAiExecution(
  userId: string,
  organizationId: string,
  executionId: string,
  errorCode: string,
): Promise<void> {
  const updated = await withOrganizationContext(userId, organizationId, async (transaction) => {
    const result = await transaction.query(
      `UPDATE nexora.ai_executions
       SET status = 'failed',
           error_code = $4,
           completed_at = pg_catalog.now()
       WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND status = 'started'`,
      [executionId, organizationId, userId, errorCode],
    );
    return result.rowCount ?? 0;
  });
  if (updated !== 1) {
    throw new Error("AI execution record could not be marked failed");
  }
}
