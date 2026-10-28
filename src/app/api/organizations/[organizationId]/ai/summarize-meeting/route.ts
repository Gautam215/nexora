import type { NextRequest } from "next/server";
import { aiMeetingSummarizeSchema } from "../../../../../../security/ai-schemas.ts";
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
import { buildAiPrompt, redactSecrets } from "../../../../../../server/ai/context.ts";
import { completeAiExecution, failAiExecution, startAiExecution } from "../../../../../../server/ai/execution.ts";
import { AiProviderError, resolveAiProvider } from "../../../../../../server/ai/provider.ts";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

// AI meeting-notes summary (PRD 20): a free-text summary of meeting
// notes supplied by the caller. Read-only: nothing is created. A
// meeting has no project record, so unlike the project summary this
// workflow takes notes directly; the notes travel as the
// untrusted-data block of the prompt, never as instructions, and the
// summary is labelled aiGenerated in the response. Organization
// membership is enforced by startAiExecution (non-members are
// rejected before any provider call); the execution record is
// started before the call and completed after it.
export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!hasSameOrigin(request)) {
    return jsonError(request, 403, "FORBIDDEN_ORIGIN", "Request origin is not allowed.");
  }
  const parsed = await parseJson(request, aiMeetingSummarizeSchema);
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
    const executionId = await startAiExecution(
      principal.userId,
      organizationId,
      null,
      "summarization",
      provider.name,
      provider.model,
    );
    const prompt = buildAiPrompt(
      "summarization",
      "Summarize these meeting notes: the decisions made, the follow-ups agreed, and any risks or open questions. Keep it concise.",
      redactSecrets(parsed.value.notes),
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
        logRouteFailure(request, "ai.summarize-meeting.record", recordError);
      }
      logRouteFailure(request, "ai.summarize-meeting", error);
      return jsonError(request, 503, "AI_FAILED", "The AI summary could not be produced. Please try again later.");
    }
  } catch (error) {
    return jsonServerFailure(request, "ai.summarize-meeting", error);
  }
}
