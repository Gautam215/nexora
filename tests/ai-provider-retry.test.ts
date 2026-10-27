import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { resolveAiProvider } from "../src/server/ai/provider.ts";

test("http AI provider retries a transient 503 once, and gives up after the retry", async () => {
  let calls = 0;
  let mode: "flaky" | "always-down" = "flaky";
  const server = createServer((_request, response) => {
    calls += 1;
    if (mode === "always-down" || (mode === "flaky" && calls === 1)) {
      response.writeHead(503, { "retry-after": "0" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        choices: [{ message: { content: "retried summary" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = {
    provider: process.env.AI_PROVIDER,
    baseUrl: process.env.AI_PROVIDER_BASE_URL,
    apiKey: process.env.AI_PROVIDER_API_KEY,
    model: process.env.AI_PROVIDER_MODEL,
  };
  try {
    process.env.AI_PROVIDER = "http";
    process.env.AI_PROVIDER_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AI_PROVIDER_API_KEY = "test-key";
    process.env.AI_PROVIDER_MODEL = "test-model";
    const provider = resolveAiProvider();
    assert.ok(provider);
    const output = await provider.generate({ system: "sys", user: "user", maxOutputTokens: 100 });
    assert.equal(output.text, "retried summary");
    assert.equal(calls, 2);

    mode = "always-down";
    calls = 0;
    // Flaky server now answers 503 on every call (mode switch
    // makes the first call 503 and the retry 503 as well).
    await assert.rejects(() =>
      provider.generate({ system: "sys", user: "user", maxOutputTokens: 100 }),
    );
    assert.equal(calls, 2, "exactly one retry, not an unbounded loop");
  } finally {
    if (previous.provider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous.provider;
    if (previous.baseUrl === undefined) delete process.env.AI_PROVIDER_BASE_URL;
    else process.env.AI_PROVIDER_BASE_URL = previous.baseUrl;
    if (previous.apiKey === undefined) delete process.env.AI_PROVIDER_API_KEY;
    else process.env.AI_PROVIDER_API_KEY = previous.apiKey;
    if (previous.model === undefined) delete process.env.AI_PROVIDER_MODEL;
    else process.env.AI_PROVIDER_MODEL = previous.model;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
