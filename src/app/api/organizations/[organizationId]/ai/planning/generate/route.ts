import type { NextRequest } from "next/server";
import { aiPlanningGenerateSchema, aiPlanningOutputSchema } from "../../../../../../../security/ai-schemas.ts";
import {
  hasSameOrigin,
  jsonError,
  jsonOk,
  jsonServerFailure,
  logRouteFailure,
  parseJson,
} from "../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../server/auth-rate-limit.ts";
import { buildAiPrompt } from "../../../../../../../server/ai/context.ts";
import { completeAiExecution, failAiExecution, startAiExecution } from "../../../../../../../server/ai/execution.ts";
import { AiProviderError, parseAiJsonOutput, resolveAiProvider } from "../../../../../../../server/ai/provider.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

// AI project planning, step 1: generate. The provider
// returns a structured draft; this endpoint creates NOTHING. The
// draft is returned for review, and only the confirm endpoint may
// create milestones or tasks. The execution record is org-level
// (project_id NULL) because no project exists yet.
export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  }
  const parsed = await parseJson(request, aiPlanningGenerateSchema);
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
    // Membership is verified by the execution insert itself, which
    // runs under the organization context and RLS.
    const executionId = await startAiExecution(
      principal.userId,
      organizationId,
      null,
      "planning",
      provider.name,
      provider.model,
    );
    const prompt = buildAiPrompt(
      "planning",
      `Project goal: ${parsed.value.goal}\n\nGenerate a plan as JSON only, with this exact shape: { "milestones": [{ "name": string, "description"?: string, "tasks": [{ "title": string, "description"?: string, "subtasks"?: string[] }] }], "dependencies"?: [{ "from": string, "to": string }] }. Dependencies reference task titles: "from" must finish before "to" starts. Do not invent dates or owners.`,
      "",
    );
    const startedAt = Date.now();
    try {
      const output = await provider.generate({ ...prompt, maxOutputTokens: 4000 });
      let draftJson: unknown;
      try {
        draftJson = parseAiJsonOutput(output.text);
      } catch {
        throw new AiProviderError("INVALID_OUTPUT");
      }
      const draft = aiPlanningOutputSchema.safeParse(draftJson);
      if (!draft.success) {
        throw new AiProviderError("INVALID_OUTPUT");
      }
      await completeAiExecution(principal.userId, organizationId, executionId, {
        promptTokens: output.promptTokens,
        completionTokens: output.completionTokens,
        latencyMs: Date.now() - startedAt,
      });
      return jsonOk(request, { draft: draft.data, aiGenerated: true, executionId });
    } catch (error) {
      const code = error instanceof AiProviderError ? error.code : "PROVIDER_REJECTED";
      try {
        await failAiExecution(principal.userId, organizationId, executionId, code);
      } catch (recordError) {
        logRouteFailure(request, "ai.planning.generate.record", recordError);
      }
      logRouteFailure(request, "ai.planning.generate", error);
      return jsonError(request, 503, "AI_FAILED", "The AI plan could not be produced. Please try again later.");
    }
  } catch (error) {
    return jsonServerFailure(request, "ai.planning.generate", error);
  }
}
