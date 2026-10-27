import "server-only";

// AI provider abstraction (PRD 17, 23). No business logic calls a
// provider directly: routes call resolveAiProvider() and then
// generate(), and every call is recorded by src/server/ai/execution.ts.
//
// Provider selection is configuration, not code:
// - AI_PROVIDER=mock: deterministic test provider. It is refused in
//   production even if configured, so a test double can never serve
//   real users. It answers from the workflow tag in the system prompt,
//   which keeps routes provider-agnostic.
// - AI_PROVIDER=http: a generic OpenAI-compatible chat-completions
//   endpoint (AI_PROVIDER_BASE_URL, AI_PROVIDER_API_KEY,
//   AI_PROVIDER_MODEL). Any vendor with a compatible endpoint works;
//   no vendor SDK is added, so no new dependency is introduced.
// - Anything else, or missing credentials: resolveAiProvider()
//   returns null and the route fails closed with 503 AI_UNAVAILABLE,
//   mirroring the email configuration pattern. Missing
//   credentials never prevent the rest of the app from running, and
//   no route fabricates an AI answer when no provider is configured.
//
// Safety rules enforced here, not left to callers:
// - 30-second timeout on every provider call (PRD 23 cost/latency
//   control); a timeout is a provider failure, not a partial answer.
// - Provider errors are mapped to AiProviderError codes. The client
//   gets a generic message; provider status, body, and key are never
//   returned or logged.
// - The API key is read from the environment at call time and never
//   stored, logged, or placed in a URL.

export type AiWorkflow = "planning" | "extraction" | "summarization" | "risk" | "assistant";

export interface AiGenerateInput {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface AiGenerateOutput {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export interface AiProvider {
  name: string;
  model: string;
  generate(input: AiGenerateInput): Promise<AiGenerateOutput>;
}

export class AiProviderError extends Error {
  readonly code: "PROVIDER_UNAVAILABLE" | "PROVIDER_TIMEOUT" | "PROVIDER_REJECTED" | "INVALID_OUTPUT";

  constructor(code: AiProviderError["code"]) {
    super(`AI provider failed: ${code}`);
    this.name = "AiProviderError";
    this.code = code;
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const PROVIDER_TIMEOUT_MS = 30_000;

class MockAiProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "mock-1";

  async generate(input: AiGenerateInput): Promise<AiGenerateOutput> {
    const system = input.system;
    if (system.includes("[workflow:planning]")) {
      return {
        text: JSON.stringify({
          milestones: [
            {
              name: "Mock milestone",
              description: "Deterministic mock plan.",
              tasks: [{ title: "Mock task", description: "Deterministic mock task." }],
            },
          ],
          dependencies: [],
        }),
        promptTokens: estimateTokens(input.system + input.user),
        completionTokens: 60,
      };
    }
    if (system.includes("[workflow:extraction]")) {
      return {
        text: JSON.stringify({
          tasks: [{ title: "Mock extracted task", owner: null, deadline: null }],
          decisions: ["Mock decision"],
          followUps: [],
          risks: [],
        }),
        promptTokens: estimateTokens(input.system + input.user),
        completionTokens: 60,
      };
    }
    if (system.includes("[workflow:risk]")) {
      return {
        text: JSON.stringify({
          risks: [{ title: "Mock risk", detail: "Deterministic mock risk.", severity: "medium" }],
        }),
        promptTokens: estimateTokens(input.system + input.user),
        completionTokens: 60,
      };
    }
    // Summarization and assistant are free-text workflows.
    return {
      text: "AI-generated summary (test provider): the project context was received and summarized.",
      promptTokens: estimateTokens(input.system + input.user),
      completionTokens: 24,
    };
  }
}

class HttpAiProvider implements AiProvider {
  readonly name = "http";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(model: string, baseUrl: string, apiKey: string) {
    this.model = model;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async generate(input: AiGenerateInput): Promise<AiGenerateOutput> {
    // Bounded retry for transient provider failures only (429 and
    // 502/503/504): one retry, with a short backoff honouring
    // Retry-After up to 5 seconds. Generation is effect-free in
    // Nexora (no state is written until a successful result
    // returns), so a retry cannot duplicate a Nexora record; it
    // can only spend provider tokens twice, which the one-retry
    // bound keeps small. Timeouts and network errors are NOT
    // retried: a generation that timed out may still be running
    // provider-side, and retrying it would stack two long
    // generations. No circuit breaker is added: with one retry
    // and a 30-second timeout, a failing provider already fails
    // closed fast, and a breaker would need shared state across
    // processes that this codebase does not have.
    const RETRYABLE = new Set([429, 502, 503, 504]);
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          temperature: 0,
          max_tokens: input.maxOutputTokens,
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new AiProviderError("PROVIDER_TIMEOUT");
      }
      throw new AiProviderError("PROVIDER_REJECTED");
    }
      if (response.ok) break;
      if (!RETRYABLE.has(response.status) || attempt === 1) {
        throw new AiProviderError("PROVIDER_REJECTED");
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 500;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    if (!response || !response.ok) {
      throw new AiProviderError("PROVIDER_REJECTED");
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new AiProviderError("INVALID_OUTPUT");
    }
    const promptTokens =
      typeof body.usage?.prompt_tokens === "number"
        ? body.usage.prompt_tokens
        : estimateTokens(input.system + input.user);
    const completionTokens =
      typeof body.usage?.completion_tokens === "number"
        ? body.usage.completion_tokens
        : estimateTokens(content);
    return { text: content, promptTokens, completionTokens };
  }
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

export function resolveAiProvider(): AiProvider | null {
  const kind = process.env.AI_PROVIDER;
  if (kind === "mock") {
    // Test double only. Refused in production even if configured.
    if (process.env.NODE_ENV === "production") return null;
    return new MockAiProvider();
  }
  if (kind !== "http") return null;
  const baseUrlRaw = process.env.AI_PROVIDER_BASE_URL ?? "";
  const apiKey = process.env.AI_PROVIDER_API_KEY ?? "";
  const model = process.env.AI_PROVIDER_MODEL ?? "";
  if (!baseUrlRaw || !apiKey || !model) return null;
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    return null;
  }
  // HTTPS in production; loopback HTTP only for local development,
  // mirroring the APP_ORIGIN rule.
  if (baseUrl.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && isLoopback(baseUrl))) {
    return null;
  }
  return new HttpAiProvider(model, baseUrl.href.replace(/\/$/, ""), apiKey);
}
