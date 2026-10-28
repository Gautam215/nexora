import type { NextRequest } from "next/server";
import { aiExtractionGenerateSchema, aiExtractionOutputSchema } from "../../../../../../../security/ai-schemas.ts";
import { hasSameOrigin, jsonError, jsonOk, jsonServerFailure, logRouteFailure, parseJson } from "../../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../server/auth-rate-limit.ts";
import { buildAiPrompt, redactSecrets } from "../../../../../../../server/ai/context.ts";
import { completeAiExecution, failAiExecution, startAiExecution } from "../../../../../../../server/ai/execution.ts";
import { AiProviderError, parseAiJsonOutput, resolveAiProvider } from "../../../../../../../server/ai/provider.ts";

export const runtime = "nodejs";

// AI meeting-notes extraction, step 1 of 2 (PRD 19): generates a
// structured draft and creates NOTHING. The notes travel as the
// untrusted-data block of the prompt, never as instructions, and the
// draft is validated against the output schema before it is returned.
export async function POST(request: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  if (!hasSameOrigin(request)) return jsonError(request, 403, "ORIGIN_REJECTED", "This request was rejected.");
  const parsed = await parseJson(request, aiExtractionGenerateSchema);
  if (!parsed.ok) return jsonError(request, parsed.status, parsed.code, parsed.message);

  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId } = await params;
    if (await isRateLimited(request, "ai-request-user", principal.userId, 60, 3600, 120)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many AI requests. Wait before trying again.", {
        "retry-after": "3600",
      });
    }
    if (await isRateLimited(request, "ai-request-org", organizationId, 120, 3600, 120)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many AI requests for this workspace. Wait before trying again.", {
        "retry-after": "3600",
      });
    }
    const provider = resolveAiProvider();
    if (!provider) {
      return jsonError(request, 503, "AI_UNAVAILABLE", "AI is not configured yet. Contact the workspace administrator.");
    }
    // startAiExecution runs under the organization context and RLS,
    // so a non-member is rejected here before any provider call.
    const executionId = await startAiExecution(
      principal.userId,
      organizationId,
      null,
      "extraction",
      provider.name,
      provider.model,
    );
    const prompt = buildAiPrompt(
      "extraction",
      `Extract tasks, decisions, follow-ups, and risks from the meeting notes. Respond with JSON only, with this exact shape: { "tasks": [{ "title": string, "owner"?: string | null, "deadline"?: string | null }], "decisions": string[], "followUps": string[], "risks": string[] }. Owner and deadline are text exactly as stated in the notes, or null; never invent them. Every actionable follow-up must also appear as a task in tasks[] (with its owner and deadline as text); decisions and risks stay in their own lists and are not tasks.`,
      redactSecrets(parsed.value.notes),
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
      const draft = aiExtractionOutputSchema.safeParse(draftJson);
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
      if (error instanceof AiProviderError) {
        await failAiExecution(principal.userId, organizationId, executionId, error.code);
        // Parity with the other AI routes: without this call the
        // failure never reaches the logs (the 2026-10-28 probe's two
        // extraction failures left no log entries at all).
        logRouteFailure(request, "ai.extraction.generate", error);
        return jsonError(request, 503, "AI_FAILED", "The AI provider could not produce a valid extraction.");
      }
      throw error;
    }
  } catch (error) {
    return jsonServerFailure(request, "ai.extraction.generate", error);
  }
}
