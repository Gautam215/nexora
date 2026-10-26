import type { NextRequest } from "next/server";
import { aiRiskOutputSchema, aiRiskSchema } from "../../../../../../security/ai-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  logRouteFailure,
  parseJson,
} from "../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../server/db.ts";
import { buildAiPrompt, buildProjectContext } from "../../../../../../server/ai/context.ts";
import { completeAiExecution, failAiExecution, startAiExecution } from "../../../../../../server/ai/execution.ts";
import { AiProviderError, resolveAiProvider } from "../../../../../../server/ai/provider.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

// AI risk analysis (PRD 21): read-only. The context is retrieved
// through the same tenant gates as summarization, and every finding
// is labelled aiGenerated: a risk is a possibility, never a confirmed
// fact, and the UI must render it that way.
export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, aiRiskSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId } = await params;
    if (
      (await isRateLimited(request, "ai-request-user", principal.userId, 60, 3600, 120)) ||
      (await isRateLimited(request, "ai-request-org", organizationId, 120, 3600, 120))
    ) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many AI requests. Wait before trying again.", {
        "retry-after": "3600",
      });
    }
    const provider = resolveAiProvider();
    if (!provider) {
      return jsonError(request, 503, "AI_UNAVAILABLE", "AI is not configured yet. Contact the workspace administrator.");
    }
    const context = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => buildProjectContext(transaction, organizationId, parsed.value.projectId),
    );
    if (!context) {
      return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }
    const executionId = await startAiExecution(
      principal.userId,
      organizationId,
      parsed.value.projectId,
      "risk",
      provider.name,
      provider.model,
    );
    const prompt = buildAiPrompt(
      "risk",
      `Identify risks for this project: delays, blockers, dependency risks, overdue work, and workload or schedule pressure. Respond with JSON only, with this exact shape: { "risks": [{ "title": string, "detail": string, "severity": "low" | "medium" | "high" }] }. Present each finding as a possible risk, never as a confirmed fact.`,
      context.contextText,
    );
    const startedAt = Date.now();
    try {
      const output = await provider.generate({ ...prompt, maxOutputTokens: 4000 });
      let risksJson: unknown;
      try {
        risksJson = JSON.parse(output.text) as unknown;
      } catch {
        throw new AiProviderError("INVALID_OUTPUT");
      }
      const risks = aiRiskOutputSchema.safeParse(risksJson);
      if (!risks.success) {
        throw new AiProviderError("INVALID_OUTPUT");
      }
      await completeAiExecution(principal.userId, organizationId, executionId, {
        promptTokens: output.promptTokens,
        completionTokens: output.completionTokens,
        latencyMs: Date.now() - startedAt,
      });
      return jsonOk(request, { risks: risks.data.risks, aiGenerated: true, executionId });
    } catch (error) {
      const code = error instanceof AiProviderError ? error.code : "PROVIDER_REJECTED";
      try {
        await failAiExecution(principal.userId, organizationId, executionId, code);
      } catch (recordError) {
        logRouteFailure(request, "ai.risk.record", recordError);
      }
      logRouteFailure(request, "ai.risk", error);
      return jsonError(request, 503, "AI_FAILED", "The AI risk analysis could not be produced. Please try again later.");
    }
  } catch (error) {
    return jsonServerFailure(request, "ai.risk", error);
  }
}
