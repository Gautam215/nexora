// AI evaluation framework (PRD 24). This module is the record format
// and taxonomy for evaluation cases — it does not itself call a
// provider. Cases run through the real routes in
// tests/ai-evaluation.integration.test.ts, against the configured
// provider, and each result records the provider, model, and app
// version it was measured under, so a result is never quoted without
// the conditions that produced it.
//
// Categories are PRD 24's, verbatim in intent: correctness,
// structured-output validity, authorization, prompt-injection
// resistance, hallucination behaviour, safe failure, confirmation,
// cost, and latency. A case that cannot run here (anything requiring
// a live provider's judgement, such as real hallucination behaviour)
// is recorded as "blocked" with its reason — never as a pass.

export const EVALUATION_CATEGORIES = [
  "correctness",
  "structured_output_validity",
  "authorization",
  "prompt_injection_resistance",
  "hallucination_behaviour",
  "safe_failure",
  "confirmation",
  "cost",
  "latency",
] as const;

export type EvaluationCategory = (typeof EVALUATION_CATEGORIES)[number];

export type EvaluationStatus = "passed" | "failed" | "blocked";

export interface EvaluationCaseResult {
  /** Stable case id, e.g. "prompt-injection.comment-does-not-leak". */
  case: string;
  category: EvaluationCategory;
  provider: string;
  model: string;
  appVersion: string;
  status: EvaluationStatus;
  /** Why a blocked case could not run, or what a failed case showed. */
  detail?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
}

export interface EvaluationSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  results: EvaluationCaseResult[];
}

export function summarizeEvaluation(results: EvaluationCaseResult[]): EvaluationSummary {
  return {
    total: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    blocked: results.filter((result) => result.status === "blocked").length,
    results,
  };
}
