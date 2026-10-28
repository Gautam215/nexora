import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_CIRCUIT_COOLDOWN_MS,
  AI_CIRCUIT_FAILURE_THRESHOLD,
  AiCircuitBreaker,
  resetAiCircuitBreaker,
  withAiCircuitBreaker,
} from "../src/server/ai/circuit-breaker.ts";
import { AiProviderError, type AiProvider } from "../src/server/ai/provider.ts";
import { snapshotMetrics } from "../src/server/metrics.ts";

function failingProvider(calls: { count: number }): AiProvider {
  return {
    name: "failing-test",
    model: "failing-test-1",
    generate: async () => {
      calls.count += 1;
      throw new AiProviderError("PROVIDER_REJECTED");
    },
  };
}

test("circuit breaker stays closed below the threshold and resets on success", () => {
  const breaker = new AiCircuitBreaker();
  const now = 1_000_000;
  for (let i = 0; i < AI_CIRCUIT_FAILURE_THRESHOLD - 1; i += 1) {
    assert.equal(breaker.recordFailure(now), false);
    assert.equal(breaker.canAttempt(now), true);
  }
  breaker.recordSuccess();
  assert.equal(breaker.getConsecutiveFailures(), 0);
  assert.equal(breaker.getState(), "closed");
});

test("circuit breaker opens at the threshold, fails fast during cooldown, and probes after it", () => {
  const breaker = new AiCircuitBreaker();
  const now = 1_000_000;
  for (let i = 0; i < AI_CIRCUIT_FAILURE_THRESHOLD; i += 1) {
    const opened = breaker.recordFailure(now);
    assert.equal(opened, i === AI_CIRCUIT_FAILURE_THRESHOLD - 1);
  }
  assert.equal(breaker.getState(), "open");
  assert.equal(breaker.canAttempt(now + AI_CIRCUIT_COOLDOWN_MS - 1), false);
  assert.equal(breaker.canAttempt(now + AI_CIRCUIT_COOLDOWN_MS), true);
  assert.equal(breaker.getState(), "half-open");
  // A probe failure reopens for another full cooldown.
  assert.equal(breaker.recordFailure(now + AI_CIRCUIT_COOLDOWN_MS), true);
  assert.equal(breaker.getState(), "open");
  assert.equal(breaker.canAttempt(now + AI_CIRCUIT_COOLDOWN_MS * 2), true);
  breaker.recordSuccess();
  assert.equal(breaker.getState(), "closed");
  assert.equal(breaker.getConsecutiveFailures(), 0);
});

test("wrapped provider fails fast once open, counts one open, and passes non-provider errors through", async () => {
  resetAiCircuitBreaker();
  const opensBefore = snapshotMetrics().ai.circuitOpens;
  const calls = { count: 0 };
  const provider = withAiCircuitBreaker(failingProvider(calls));
  for (let i = 0; i < AI_CIRCUIT_FAILURE_THRESHOLD; i += 1) {
    await assert.rejects(() => provider.generate({ system: "s", user: "u", maxOutputTokens: 10 }));
  }
  assert.equal(calls.count, AI_CIRCUIT_FAILURE_THRESHOLD);
  assert.equal(snapshotMetrics().ai.circuitOpens, opensBefore + 1);
  // Open: the inner provider is not called again.
  await assert.rejects(
    () => provider.generate({ system: "s", user: "u", maxOutputTokens: 10 }),
    (error: unknown) => error instanceof AiProviderError && error.code === "PROVIDER_CIRCUIT_OPEN",
  );
  assert.equal(calls.count, AI_CIRCUIT_FAILURE_THRESHOLD);

  // A non-provider error is not a provider failure: it propagates
  // without counting toward the threshold.
  resetAiCircuitBreaker();
  const buggy = withAiCircuitBreaker({
    name: "buggy-test",
    model: "buggy-test-1",
    generate: async () => {
      throw new Error("bug, not a provider failure");
    },
  });
  for (let i = 0; i < AI_CIRCUIT_FAILURE_THRESHOLD; i += 1) {
    await assert.rejects(() => buggy.generate({ system: "s", user: "u", maxOutputTokens: 10 }), /bug/);
  }
  assert.equal(snapshotMetrics().ai.circuitOpens, opensBefore + 1);
  resetAiCircuitBreaker();
});
