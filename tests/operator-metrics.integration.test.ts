import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "pg";
import { closeDatabasePool, closeOperatorPool, queryOperatorAggregates } from "../src/server/db.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const migratorConnectionString = process.env.NEXORA_TEST_MIGRATOR_DATABASE_URL;
if (connectionString) process.env.DATABASE_URL = connectionString;

after(async () => {
  await closeDatabasePool();
  await closeOperatorPool();
});

test(
  "operator metrics aggregates: AI tokens, outbox depth, and job failures",
  { skip: !connectionString || !migratorConnectionString },
  async () => {
    // One failed job run, seeded as the migrator, so the jobs query
    // has a real failure to count. The run_date is yesterday, which
    // is inside the trailing-7-day window but never collides with
    // the cron claim for today: seeding today would race the
    // scheduled-jobs test's same-day claim for the alerts job.
    // The (job, run_date) unique key means a rerun against a
    // non-reset database updates the same row instead of failing.
    const migrator = new Client({ connectionString: migratorConnectionString });
    await migrator.connect();
    try {
      await migrator.query(
        `INSERT INTO nexora.scheduled_job_runs (job, run_date, status, detail)
         VALUES ('alerts', CURRENT_DATE - 1, 'failed', 'operator metrics test')
         ON CONFLICT (job, run_date) DO UPDATE SET status = 'failed'`,
      );
    } finally {
      await migrator.end();
    }

    // Since migration 0066 the app role no longer executes the
    // operator functions directly; queryOperatorAggregates runs them
    // through the operator pool. The migrator connection stands in
    // for the operator role here: it owns the functions, so EXECUTE
    // holds regardless of the 0066 app-role revoke.
    process.env.NEXORA_OPERATOR_DATABASE_URL = migratorConnectionString;
    const operator = await queryOperatorAggregates();
    const ai = operator.ai as {
      executionsTotal: number;
      executionsSucceeded: number;
      executionsFailed: number;
      promptTokensTotal: number;
      completionTokensTotal: number;
      promptTokensLast30d: number;
      completionTokensLast30d: number;
      avgLatencyMs: number | null;
      byWorkflow: Array<{ workflow: string; count: number }>;
    };
    assert.equal(typeof ai.executionsTotal, "number");
    assert.ok(ai.executionsTotal >= 0);
    assert.equal(typeof ai.promptTokensTotal, "number");
    assert.equal(typeof ai.completionTokensTotal, "number");
    assert.ok(Array.isArray(ai.byWorkflow));

    const outbox = operator.outbox as {
      pending: number;
      processing: number;
      sent: number;
      failed: number;
    };
    for (const value of [outbox.pending, outbox.processing, outbox.sent, outbox.failed]) {
      assert.equal(typeof value, "number");
      assert.ok(value >= 0);
    }

    assert.ok(operator.jobs.failedLast7d >= 1);
    assert.ok(operator.jobs.totalLast7d >= 1);
    // The seeded yesterday row guarantees an alerts entry; its
    // status may be 'ok' instead if the cron test already claimed
    // and completed today's alerts run, so only the job's presence
    // is asserted here, not its status.
    assert.ok(operator.jobs.lastRuns.some((run) => run.job === "alerts"));
  },
);

test(
  "operator metrics aggregates: app role cannot call the operator functions directly",
  { skip: !connectionString },
  async () => {
    // Migration 0066 revoked EXECUTE from nexora_app. The app-role
    // connection must get 42501, proving the operator functions are
    // reachable only through the operator pool, not from any route
    // that runs on the app pool.
    const app = new Client({ connectionString });
    await app.connect();
    try {
      await assert.rejects(
        app.query("SELECT nexora.ai_operator_aggregate()"),
        (error: { code?: string }) => error.code === "42501",
      );
      await assert.rejects(
        app.query("SELECT nexora.outbox_queue_depth()"),
        (error: { code?: string }) => error.code === "42501",
      );
    } finally {
      await app.end();
    }
  },
);
