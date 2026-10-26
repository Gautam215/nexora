import type { NextRequest } from "next/server";
import { aiSummarizeSchema } from "../../../../../../security/ai-schemas.ts";
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

// AI summarization (PRD 20): an authorized summary of one project.
// Read-only: no project data is created or changed. The summary is
// labelled aiGenerated in the response, and the UI must render that
// label (PRD 21). The provider call runs outside any transaction;
// the execution record is started before it and completed after it
// (see src/server/ai/execution.ts).
export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "FORBIDDEN_ORIGIN", "Request origin is not allowed.");
  }
  const parsed = await parseJson(request, aiSummarizeSchema);
  if (!parsed.ok) {
    return jsonError(request, parsed.status, parsed.code, parsed.message);
  }
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) {
      return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
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
      "summarization",
      provider.name,
      provider.model,
    );
    const prompt = buildAiPrompt(
      "summarization",
      "Summarize this project's current status: progress, milestones, overdue work, and recent activity. Keep it concise.",
      context.contextText,
    );
    const startedAt = Date.now();
    try {
      const output = await provider.generate({ ...prompt, maxOutputTokens: 2000 });
      const summary = output.text.trim();
      if (summary.length === 0 || summary.length > 8000) {
        throw new AiProviderError("INVALID_OUTPUT");
      }
      await completeAiExecution(principal.userId, organizationId, executionId, {
        promptTokens: output.promptTokens,
        completionTokens: output.completionTokens,
        latencyMs: Date.now() - startedAt,
      });
      return jsonOk(request, { summary, aiGenerated: true, executionId });
    } catch (error) {
      const code = error instanceof AiProviderError ? error.code : "PROVIDER_REJECTED";
      try {
        await failAiExecution(principal.userId, organizationId, executionId, code);
      } catch (recordError) {
        // The provider failure is the response; a failed record update
        // is logged, not substituted for it.
        logRouteFailure(request, "ai.summarize.record", recordError);
      }
      logRouteFailure(request, "ai.summarize", error);
      return jsonError(request, 503, "AI_FAILED", "The AI summary could not be produced. Please try again later.");
    }
  } catch (error) {
    return jsonServerFailure(request, "ai.summarize", error);
  }
}
