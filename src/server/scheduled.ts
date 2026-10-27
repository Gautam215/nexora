import "server-only";
import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { checkDatabaseConnection, withOrganizationContext } from "./db.ts";
import { sendNotificationEmail } from "./email.ts";
import { snapshotMetrics } from "./metrics.ts";
import { processNotificationEmailBatch } from "./notifications/email-outbox.ts";
import { removeObject } from "./storage.ts";
import {
  evaluateDatabaseDownAlert,
  evaluateServerErrorAlert,
  parseAlertThreshold,
} from "./alerts.ts";

// Scheduled jobs, run through the token-gated cron route
// (src/app/api/cron/[job]/route.ts). No in-app scheduler exists:
// the operator's scheduler (Vercel Cron, or any cron caller) calls
// the route, and the route runs one job. See docs/deployment.md
// for the exact production steps; nothing here schedules itself.
//
// Authentication is the shared bearer token alone: a cron caller
// is not a browser session and sends no Origin, so the origin
// check does not apply here. If NEXORA_CRON_TOKEN is unset, every
// job fails closed with 503 instead of running unauthenticated.
// The comparison is constant-time when the lengths match, as in
// the metrics route.
//
// Idempotency: each job claims one row per day in
// nexora.scheduled_job_runs. A second call on the same day replays
// the first run's result instead of sending a second round of
// reminders or purging twice. A failed run does NOT block a retry:
// the claim is replaced, so an operator can rerun a failed day.

export const SCHEDULED_JOBS = ["due-date", "cleanup", "email-outbox", "alerts"] as const;
export type ScheduledJob = (typeof SCHEDULED_JOBS)[number];

export class CronConfigurationError extends Error {
  constructor() {
    super("Scheduled jobs are not configured");
    this.name = "CronConfigurationError";
  }
}

export class CronAuthenticationError extends Error {
  constructor() {
    super("Scheduled job authentication failed");
    this.name = "CronAuthenticationError";
  }
}

const globalForScheduled = globalThis as typeof globalThis & {
  nexoraScheduledPool?: Pool;
};

function getScheduledPool(): Pool {
  if (globalForScheduled.nexoraScheduledPool) return globalForScheduled.nexoraScheduledPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new CronConfigurationError();
  const pool = new Pool({
    connectionString,
    application_name: "nexora-scheduled-jobs",
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 32_000,
  });
  pool.on("error", (error) => {
    console.error(JSON.stringify({ event: "scheduled.pool_error", errorName: error.name }));
  });
  globalForScheduled.nexoraScheduledPool = pool;
  return pool;
}

export async function closeScheduledPool(): Promise<void> {
  const pool = globalForScheduled.nexoraScheduledPool;
  if (!pool) return;
  delete globalForScheduled.nexoraScheduledPool;
  await pool.end();
}

export function cronTokenMatches(presented: string | null): boolean {
  const configured = process.env.NEXORA_CRON_TOKEN;
  if (!configured) throw new CronConfigurationError();
  if (presented === null) return false;
  const configuredBuffer = Buffer.from(configured, "utf8");
  const presentedBuffer = Buffer.from(presented, "utf8");
  if (presentedBuffer.length !== configuredBuffer.length) return false;
  return timingSafeEqual(configuredBuffer, presentedBuffer);
}

interface JobClaim {
  id: string;
  replay: boolean;
  previousDetail: string;
}

async function claimJobRun(job: ScheduledJob): Promise<JobClaim> {
  const pool = getScheduledPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO nexora.scheduled_job_runs (job, run_date, status, detail)
       VALUES ($1, CURRENT_DATE, 'failed', 'in progress')
       ON CONFLICT (job, run_date) DO NOTHING
       RETURNING id`,
      [job],
    );
    if (inserted.rows[0]) {
      await client.query("COMMIT");
      return { id: inserted.rows[0].id, replay: false, previousDetail: "" };
    }
    const existing = await client.query<{ id: string; status: string; detail: string }>(
      `SELECT id, status, detail FROM nexora.scheduled_job_runs
       WHERE job = $1 AND run_date = CURRENT_DATE`,
      [job],
    );
    const row = existing.rows[0];
    if (row && row.status === "ok") {
      await client.query("COMMIT");
      return { id: row.id, replay: true, previousDetail: row.detail };
    }
    if (row) {
      await client.query(`DELETE FROM nexora.scheduled_job_runs WHERE id = $1`, [row.id]);
      const retried = await client.query<{ id: string }>(
        `INSERT INTO nexora.scheduled_job_runs (job, run_date, status, detail)
         VALUES ($1, CURRENT_DATE, 'failed', 'in progress')
         RETURNING id`,
        [job],
      );
      await client.query("COMMIT");
      return { id: retried.rows[0]?.id ?? "", replay: false, previousDetail: "" };
    }
    await client.query("ROLLBACK");
    throw new Error("Scheduled job claim returned no row");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function finishJobRun(id: string, status: "ok" | "failed", detail: string): Promise<void> {
  const pool = getScheduledPool();
  await pool.query(
    `UPDATE nexora.scheduled_job_runs SET status = $2, detail = $3 WHERE id = $1`,
    [id, status, detail.slice(0, 1000)],
  );
}

interface DueDateTask {
  organization_id: string;
  project_id: string;
  task_id: string;
  assignee_user_id: string;
  task_title: string;
  due_date: string;
}

async function runDueDateJob(): Promise<string> {
  const pool = getScheduledPool();
  const listed = await pool.query<DueDateTask>(
    `SELECT organization_id, project_id, task_id, assignee_user_id, task_title, due_date
     FROM nexora.list_due_date_tasks()`,
  );
  const groups = new Map<string, DueDateTask[]>();
  for (const task of listed.rows) {
    const key = `${task.organization_id}:${task.assignee_user_id}`;
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }
  let created = 0;
  let skippedGroups = 0;
  for (const [key, tasks] of groups) {
    const [organizationId, assigneeUserId] = key.split(":");
    try {
      const inserted = await withOrganizationContext(
        assigneeUserId,
        organizationId,
        async (transaction) => {
          await transaction.query(
            `SELECT pg_catalog.set_config('nexora.system_job', 'due-date', true)`,
          );
          let count = 0;
          for (const task of tasks) {
            const title = `Task due tomorrow: ${task.task_title}`.slice(0, 120);
            const body = `Task "${task.task_title}" is due on ${task.due_date}.`.slice(0, 500);
            const result = await transaction.query(
              `INSERT INTO nexora.notifications
                 (id, organization_id, project_id, recipient_user_id, actor_user_id,
                  event_type, target_type, target_id, dedupe_key, title, body, href)
               VALUES (pg_catalog.gen_random_uuid(), $1, $2, $3, $3,
                       'due_date', 'task', $4, $5, $6, $7, $8)
               ON CONFLICT (organization_id, recipient_user_id, dedupe_key) DO NOTHING`,
              [
                organizationId,
                task.project_id,
                assigneeUserId,
                task.task_id,
                `due-date:${task.task_id}:${task.due_date}`,
                title,
                body,
                `/organizations/${organizationId}/projects/${task.project_id}/tasks`,
              ],
            );
            count += result.rowCount ?? 0;
          }
          return count;
        },
      );
      created += inserted;
    } catch {
      // One group failing (for example, the assignee's organization
      // membership is no longer active) must not lose every other
      // group's reminders; the skip is recorded in the run detail.
      skippedGroups += 1;
    }
  }
  return `due-date reminders created: ${created}, groups skipped: ${skippedGroups}, tasks listed: ${listed.rows.length}`;
}

async function runCleanupJob(): Promise<string> {
  const pool = getScheduledPool();
  const organizations = await pool.query<{ storage_key?: string }>(
    `SELECT * FROM nexora.purge_expired_organizations()`,
  );
  const projects = await pool.query<{ storage_key?: string }>(
    `SELECT * FROM nexora.purge_expired_projects()`,
  );
  const milestones = await pool.query(`SELECT * FROM nexora.purge_expired_milestones()`);
  const files = await pool.query<{ storage_key?: string }>(
    `SELECT * FROM nexora.purge_expired_task_files()`,
  );
  // Purge functions return the storage keys of the files they
  // deleted, so the same run can remove the objects too; keys are
  // de-duplicated because one file object can appear in more than
  // one purge result set.
  const objectKeys = new Set<string>();
  for (const row of [...organizations.rows, ...projects.rows, ...files.rows]) {
    if (row.storage_key) objectKeys.add(row.storage_key);
  }
  let objectsRemoved = 0;
  let objectsFailed = 0;
  for (const key of objectKeys) {
    try {
      await removeObject(key);
      objectsRemoved += 1;
    } catch {
      // A failed object removal leaves an orphan for
      // scripts/cleanup-task-files.mjs to report; it must not fail
      // the database purge that already happened.
      objectsFailed += 1;
    }
  }
  return `purged organization rows: ${organizations.rowCount ?? 0}, project rows: ${projects.rowCount ?? 0}, milestones: ${milestones.rowCount ?? 0}, task files: ${files.rowCount ?? 0}, file objects removed: ${objectsRemoved}, object removals failed: ${objectsFailed}`;
}

async function runAlertsJob(): Promise<string> {
  const recipient = process.env.NEXORA_ALERT_EMAIL?.trim() ?? "";
  if (!recipient) return "alerts disabled: NEXORA_ALERT_EMAIL is not set";
  const pool = getScheduledPool();
  const snapshot = snapshotMetrics();
  const databaseUp = await checkDatabaseConnection();
  const threshold = parseAlertThreshold(process.env.NEXORA_ALERT_SERVER_ERROR_THRESHOLD);
  const now = new Date();
  const sent: string[] = [];
  const serverErrorState = await pool.query<{ last_value: string; last_sent_at: Date | null }>(
    `SELECT last_value, last_sent_at FROM nexora.alert_state WHERE rule = 'server-errors'`,
  );
  const serverEvaluation = evaluateServerErrorAlert(
    snapshot.requests.serverError,
    threshold,
    Number(serverErrorState.rows[0]?.last_value ?? 0),
  );
  if (serverEvaluation.triggered) {
    await sendNotificationEmail(
      recipient,
      "Nexora alert: server errors",
      serverEvaluation.detail.slice(0, 500),
    );
    await pool.query(
      `INSERT INTO nexora.alert_state (rule, last_value, last_sent_at, updated_at)
       VALUES ('server-errors', $1, pg_catalog.now(), pg_catalog.now())
       ON CONFLICT (rule) DO UPDATE SET last_value = $1, last_sent_at = pg_catalog.now(), updated_at = pg_catalog.now()`,
      [snapshot.requests.serverError],
    );
    sent.push("server-errors");
  }
  const dbState = await pool.query<{ last_sent_at: Date | null }>(
    `SELECT last_sent_at FROM nexora.alert_state WHERE rule = 'database-down'`,
  );
  const dbEvaluation = evaluateDatabaseDownAlert(
    databaseUp,
    dbState.rows[0]?.last_sent_at ?? null,
    now,
  );
  if (dbEvaluation.triggered) {
    await sendNotificationEmail(recipient, "Nexora alert: database down", dbEvaluation.detail);
    await pool.query(
      `INSERT INTO nexora.alert_state (rule, last_value, last_sent_at, updated_at)
       VALUES ('database-down', 0, pg_catalog.now(), pg_catalog.now())
       ON CONFLICT (rule) DO UPDATE SET last_sent_at = pg_catalog.now(), updated_at = pg_catalog.now()`,
    );
    sent.push("database-down");
  }
  return sent.length > 0
    ? `alerts sent: ${sent.join(", ")}`
    : `no alerts triggered (server errors ${snapshot.requests.serverError}, database up: ${databaseUp})`;
}

export async function runScheduledJob(job: ScheduledJob): Promise<{ replay: boolean; detail: string }> {
  const claim = await claimJobRun(job);
  if (claim.replay) return { replay: true, detail: claim.previousDetail };
  try {
    let detail: string;
    if (job === "due-date") detail = await runDueDateJob();
    else if (job === "cleanup") detail = await runCleanupJob();
    else if (job === "email-outbox") {
      const result = await processNotificationEmailBatch(20);
      detail = `claimed ${result.claimed}, sent ${result.sent}, failed ${result.failed}, pending retry ${result.pendingRetry}`;
    } else detail = await runAlertsJob();
    await finishJobRun(claim.id, "ok", detail);
    return { replay: false, detail };
  } catch (error) {
    await finishJobRun(
      claim.id,
      "failed",
      error instanceof Error ? error.message.slice(0, 1000) : "scheduled job failed",
    );
    throw error;
  }
}
