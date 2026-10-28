import { Pool } from "pg";

// Local query benchmark (approved default D7, 2026-10-26).
// Measures the hot read paths against DATABASE_URL (use a
// disposable test database, never production) and reports
// mean/p50/p95 in milliseconds over 20 iterations each.
// These numbers are for local regression comparison on a small
// dataset only; they are NOT production performance acceptance,
// which needs a deployed environment and a realistic dataset
// (see docs/performance.md). Row counts are printed alongside
// the timings so a future run can tell whether the dataset
// changed. No data is written.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString,
  application_name: "nexora-benchmark",
  // 12 so the concurrent phase (10 workers) measures database
  // contention, not pool queueing; the sequential phase never
  // holds more than one connection.
  max: 12,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  query_timeout: 17000,
});

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { mean_ms: Number(mean.toFixed(2)), p50_ms: Number(percentile(50).toFixed(2)), p95_ms: Number(percentile(95).toFixed(2)) };
}

async function measure(name, sql, params, iterations = 20) {
  // Warm-up, then timed runs.
  await pool.query(sql, params);
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await pool.query(sql, params);
    samples.push(performance.now() - start);
  }
  console.log(JSON.stringify({ query: name, ...summarize(samples) }));
}

// Concurrent phase (2026-10-28, PRD 39): the same query shapes,
// but with several workers issuing them at once, so the numbers
// reflect contention, not just single-query cost. Each worker runs
// its own sequential chain; latencies from all workers are pooled.
async function measureConcurrent(name, sql, params, workers = 10, iterations = 20) {
  await pool.query(sql, params);
  const runWorker = async () => {
    const samples = [];
    for (let i = 0; i < iterations; i += 1) {
      const start = performance.now();
      await pool.query(sql, params);
      samples.push(performance.now() - start);
    }
    return samples;
  };
  const all = (await Promise.all(Array.from({ length: workers }, runWorker))).flat();
  const sorted = [...all].sort((a, b) => a - b);
  console.log(JSON.stringify({
    query: `${name}_concurrent_${workers}x${iterations}`,
    ...summarize(all),
    max_ms: Number(sorted[sorted.length - 1].toFixed(2)),
  }));
}

try {
  const counts = await pool.query(
    `SELECT (SELECT count(*) FROM nexora.organizations) AS organizations,
            (SELECT count(*) FROM nexora.projects) AS projects,
            (SELECT count(*) FROM nexora.tasks) AS tasks,
            (SELECT count(*) FROM nexora.task_files) AS task_files,
            (SELECT count(*) FROM nexora.notifications) AS notifications`,
  );
  console.log(JSON.stringify({ row_counts: counts.rows[0] }));
  // Hot paths, in tenant context they would run under RLS; the
  // benchmark uses the runtime role without a tenant session, so
  // these timings are query-shape timings, not tenant-filtered
  // timings, and are labelled as such in docs/performance.md.
  await measure("list_projects", "SELECT id, name, status FROM nexora.projects ORDER BY created_at DESC LIMIT 50", []);
  await measure("list_tasks", "SELECT id, title, workflow_status_id FROM nexora.tasks ORDER BY created_at DESC LIMIT 50", []);
  await measure("search_files_by_name", "SELECT id, original_filename FROM nexora.task_files WHERE original_filename ILIKE $1 LIMIT 50", ["%release%"]);
  await measure("list_notifications", "SELECT id, title, created_at FROM nexora.notifications ORDER BY created_at DESC LIMIT 50", []);
  await measure("org_storage_usage", "SELECT COALESCE(sum(byte_size), 0) FROM nexora.task_files WHERE deleted_at IS NULL", []);
  await measureConcurrent("list_projects", "SELECT id, name, status FROM nexora.projects ORDER BY created_at DESC LIMIT 50", []);
  await measureConcurrent("list_tasks", "SELECT id, title, workflow_status_id FROM nexora.tasks ORDER BY created_at DESC LIMIT 50", []);
  await measureConcurrent("search_files_by_name", "SELECT id, original_filename FROM nexora.task_files WHERE original_filename ILIKE $1 LIMIT 50", ["%release%"]);
  await measureConcurrent("list_notifications", "SELECT id, title, created_at FROM nexora.notifications ORDER BY created_at DESC LIMIT 50", []);
  await measureConcurrent("org_storage_usage", "SELECT COALESCE(sum(byte_size), 0) FROM nexora.task_files WHERE deleted_at IS NULL", []);
} finally {
  await pool.end();
}
