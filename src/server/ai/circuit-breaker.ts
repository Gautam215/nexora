import "server-only";
import type { AiGenerateInput, AiGenerateOutput, AiProvider } from "./provider.ts";
import { AiProviderError } from "./provider.ts";
import { recordAiCircuitOpen } from "../metrics.ts";

// AI provider circuit breaker.
// The HTTP provider already retries a transient failure once; the
// breaker covers the longer failure: a provider that keeps failing
// across requests. After FAILURE_THRESHOLD consecutive provider
// failures the breaker opens and generate() fails fast without
// calling the provider, for COOLDOWN_MS. After the cooldown one
// probe request is allowed through: success closes the breaker,
// failure reopens it for another cooldown. Non-provider errors
// (bugs, not provider failures) never count toward the threshold.
//
// Deliberate limits, matching presence: the breaker is
// per-process state. On serverless each instance has its own
// breaker, so one instance's open breaker does not stop another
// instance's requests — that is acceptable for a fail-fast
// optimization, because every instance still fails closed with
// 503 AI_FAILED, and the application stays usable without AI
// The breaker never changes what a successful request
// returns; it only skips calls that would almost certainly fail.
//
// Observable: every open is counted (see recordAiCircuitOpen in
// metrics.ts, surfaced in GET /api/metrics as ai.circuitOpens)
// and logged as a JSON event. Manually overrideable: setting
// NEXORA_AI_CIRCUIT_BREAKER_DISABLED=1 disables the breaker
// entirely (the provider is returned unwrapped); the job-level
// healing kill-switch is separate (NEXORA_HEALING_DISABLED).

export const AI_CIRCUIT_FAILURE_THRESHOLD = 5;
export const AI_CIRCUIT_COOLDOWN_MS = 60_000;

type BreakerState = "closed" | "open" | "half-open";

export class AiCircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private probeInFlight = false;

  getState(): BreakerState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  // Whether a new attempt may go through at nowMs. An open breaker
  // past its cooldown moves to half-open and admits one probe.
  canAttempt(nowMs: number): boolean {
    if (this.state === "closed") return true;
    if (this.state === "half-open") return !this.probeInFlight;
    if (nowMs - this.openedAtMs >= AI_CIRCUIT_COOLDOWN_MS) {
      this.state = "half-open";
      this.probeInFlight = false;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  // Returns true exactly when this failure opened the breaker.
  recordFailure(nowMs: number): boolean {
    this.consecutiveFailures += 1;
    this.probeInFlight = false;
    if (this.state === "half-open" || this.consecutiveFailures >= AI_CIRCUIT_FAILURE_THRESHOLD) {
      if (this.state !== "open") {
        this.state = "open";
        this.openedAtMs = nowMs;
        return true;
      }
      this.openedAtMs = nowMs;
      return false;
    }
    return false;
  }

  markProbeInFlight(): void {
    if (this.state === "half-open") this.probeInFlight = true;
  }
}

// One breaker per process, shared by every request the process
// serves. Tests that need a fresh breaker use resetAiCircuitBreaker.
const sharedBreaker = new AiCircuitBreaker();

export function resetAiCircuitBreaker(): void {
  sharedBreaker.recordSuccess();
}

export function isAiCircuitBreakerDisabled(): boolean {
  return process.env.NEXORA_AI_CIRCUIT_BREAKER_DISABLED === "1";
}

class BreakerAiProvider implements AiProvider {
  private readonly inner: AiProvider;
  private readonly breaker: AiCircuitBreaker;
  private readonly onOpen: () => void;

  constructor(inner: AiProvider, breaker: AiCircuitBreaker, onOpen: () => void) {
    this.inner = inner;
    this.breaker = breaker;
    this.onOpen = onOpen;
  }

  get name(): string {
    return this.inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  async generate(input: AiGenerateInput): Promise<AiGenerateOutput> {
    const now = Date.now();
    if (!this.breaker.canAttempt(now)) {
      throw new AiProviderError("PROVIDER_CIRCUIT_OPEN");
    }
    this.breaker.markProbeInFlight();
    try {
      const output = await this.inner.generate(input);
      this.breaker.recordSuccess();
      return output;
    } catch (error) {
      if (error instanceof AiProviderError && this.breaker.recordFailure(Date.now())) {
        this.onOpen();
      }
      throw error;
    }
  }
}

export function withAiCircuitBreaker(inner: AiProvider): AiProvider {
  return new BreakerAiProvider(inner, sharedBreaker, () => {
    recordAiCircuitOpen();
    console.error(JSON.stringify({ event: "ai.circuit_open", threshold: AI_CIRCUIT_FAILURE_THRESHOLD }));
  });
}
