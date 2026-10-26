import type { NextRequest } from "next/server";
import { aiAssistantSchema } from "../../../../../../security/ai-schemas.ts";
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

// AI project assistant (PRD 22): read-only question answering over
// one authorized project. Authorization runs BEFORE retrieval: the
// context builder returns null for an invisible project, so the
// provider never sees data the caller cannot access, and the whole
// tenant is never retrieved for the model to filter. The answer is
// labelled aiGenerated, and the prompt contract requires the model to
// say when the data does not answer the question.
export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, aiAssistantSchema);
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
      "assistant",
      provider.name,
      provider.model,
    );
    const prompt = buildAiPrompt(
      "assistant",
      `Question about this project: ${parsed.value.question}\n\nAnswer only from the project data provided. If the data does not answer the question, say so rather than guessing.`,
      context.contextText,
    );
    const startedAt = Date.now();
    try {
      const output = await provider.generate({ ...prompt, maxOutputTokens: 2000 });
      const answer = output.text.trim();
      if (answer.length === 0 || answer.length > 8000) {
        throw new AiProviderError("INVALID_OUTPUT");
      }
      await completeAiExecution(principal.userId, organizationId, executionId, {
        promptTokens: output.promptTokens,
        completionTokens: output.completionTokens,
        latencyMs: Date.now() - startedAt,
      });
      return jsonOk(request, { answer, aiGenerated: true, executionId });
    } catch (error) {
      const code = error instanceof AiProviderError ? error.code : "PROVIDER_REJECTED";
      try {
        await failAiExecution(principal.userId, organizationId, executionId, code);
      } catch (recordError) {
        logRouteFailure(request, "ai.assistant.record", recordError);
      }
      logRouteFailure(request, "ai.assistant", error);
      return jsonError(request, 503, "AI_FAILED", "The AI answer could not be produced. Please try again later.");
    }
  } catch (error) {
    return jsonServerFailure(request, "ai.assistant", error);
  }
}
