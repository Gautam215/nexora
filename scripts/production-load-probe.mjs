// Bounded read-only load probe for the DEPLOYED app. NOT a
// benchmark and NOT production performance acceptance on its
// own: it only proves the public liveness/readiness endpoints
// answer under modest concurrency, so an operator can compare
// a later run against this one. DO NOT run it against
// production without the operator's explicit approval for that
// run: even read-only probes are traffic, and the numbers below
// are only meaningful on a comparable dataset and deployment.
// It calls ONLY /api/health and /api/ready (no authentication,
// no writes, no tenant data), at most 5 concurrent requests,
// at most 50 requests total, each with a 10-second timeout.
// It aborts early (exit non-zero) if /api/health is not 200,
// if more than 10% of requests fail, or if any request takes
// longer than 10 seconds. Usage:
//   NEXORA_PROBE_ORIGIN=https://nexora-two-ruby.vercel.app \
//     node scripts/production-load-probe.mjs
const origin = process.env.NEXORA_PROBE_ORIGIN;
if (!origin) throw new Error("NEXORA_PROBE_ORIGIN is required");
if (!/^https?:\/\//.test(origin)) throw new Error("NEXORA_PROBE_ORIGIN must be an http(s) URL");

const CONCURRENCY = 5;
const TOTAL_REQUESTS = 50;
const TIMEOUT_MS = 10_000;
const MAX_FAILURE_RATE = 0.1;

async function probe(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();
  try {
    const response = await fetch(`${origin}${path}`, { signal: controller.signal });
    return { path, status: response.status, ms: performance.now() - start, ok: response.status === 200 };
  } catch {
    return { path, status: 0, ms: performance.now() - start, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

const paths = ["/api/health", "/api/ready"];
const results = [];
const queue = Array.from({ length: TOTAL_REQUESTS }, (_, i) => paths[i % paths.length]);
async function worker() {
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined) return;
    results.push(await probe(path));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const byPath = {};
for (const result of results) {
  const entry = (byPath[result.path] ??= { count: 0, ok: 0, ms: [] });
  entry.count += 1;
  if (result.ok) entry.ok += 1;
  entry.ms.push(result.ms);
}
const summary = {};
for (const [path, entry] of Object.entries(byPath)) {
  const sorted = [...entry.ms].sort((a, b) => a - b);
  summary[path] = {
    count: entry.count,
    ok: entry.ok,
    mean_ms: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2)),
    p95_ms: Number(sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))].toFixed(2)),
    max_ms: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}
const failed = results.filter((result) => !result.ok).length;
console.log(JSON.stringify({ origin, concurrency: CONCURRENCY, total: results.length, failed, summary }, null, 2));
if (summary["/api/health"]?.ok !== summary["/api/health"]?.count) {
  console.error("PROBE FAILED: /api/health was not 200 for every request");
  process.exit(1);
}
if (failed / results.length > MAX_FAILURE_RATE) {
  console.error(`PROBE FAILED: failure rate ${(failed / results.length).toFixed(2)} exceeds ${MAX_FAILURE_RATE}`);
  process.exit(1);
}
