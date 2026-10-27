import "server-only";
import { Pool } from "pg";
import {
  EmailConfigurationError,
  sendNotificationEmail,
} from "../email.ts";

const globalForOutbox = globalThis as typeof globalThis & {
  nexoraEmailOutboxPool?: Pool;
};

function getOutboxPool(): Pool {
  if (globalForOutbox.nexoraEmailOutboxPool) return globalForOutbox.nexoraEmailOutboxPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database is not configured");
  const pool = new Pool({
    connectionString,
    application_name: "nexora-notification-email-worker",
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 17_000,
  });
  pool.on("error", (error) => {
    console.error(JSON.stringify({ event: "notification_email.pool_error", errorName: error.name }));
  });
  globalForOutbox.nexoraEmailOutboxPool = pool;
  return pool;
}

export async function closeEmailOutboxPool(): Promise<void> {
  const pool = globalForOutbox.nexoraEmailOutboxPool;
  if (!pool) return;
  delete globalForOutbox.nexoraEmailOutboxPool;
  await pool.end();
}

export interface NotificationEmailBatchResult {
  claimed: number;
  sent: number;
  failed: number;
  pendingRetry: number;
}

// Process one worker batch. Claiming, sending, and marking are
// separate steps on purpose. A crash between claim and mark leaves
// the row in 'processing'; the worker first resets rows claimed
// more than 30 minutes ago to pending, so a crash delays — but
// never loses — an email. A row that was actually sent before the
// crash and then reset could be sent twice; that at-least-once
// trade-off is documented, not hidden.
// A send that fails with a configuration error stops the batch
// immediately and returns the row to pending via mark_failed
// (permanent=false), so a missing-SMTP deployment never marks
// rows sent and never loses them.
export async function processNotificationEmailBatch(
  limit = 20,
): Promise<NotificationEmailBatchResult> {
  const pool = getOutboxPool();
  await pool.query(`SELECT nexora.reset_stuck_notification_email_outbox()`);
  const claimedResult = await pool.query<{
    outbox_id: string;
    notification_id: string;
    organization_id: string;
    recipient_user_id: string;
    recipient_email: string;
    event_type: string;
    title: string;
    body: string;
    href: string;
    attempts: number;
  }>(
    `SELECT * FROM nexora.claim_notification_email_outbox($1)`,
    [Math.max(1, Math.min(limit, 100))],
  );
  const result: NotificationEmailBatchResult = {
    claimed: claimedResult.rows.length,
    sent: 0,
    failed: 0,
    pendingRetry: 0,
  };
  for (const row of claimedResult.rows) {
    try {
      await sendNotificationEmail(
        row.recipient_email,
        `Nexora: ${row.title}`,
        `${row.title}\n\n${row.body}`,
      );
      await pool.query(`SELECT nexora.mark_notification_email_sent($1)`, [row.outbox_id]);
      result.sent += 1;
    } catch (error) {
      if (error instanceof EmailConfigurationError) {
        // SMTP is not configured: fail closed, do not mark sent,
        // do not burn the row. Return it to pending and stop the
        // batch — every later row would fail the same way.
        await pool.query(`SELECT nexora.mark_notification_email_failed($1, false)`, [row.outbox_id]);
        result.pendingRetry += 1;
        throw error;
      }
      const permanent = row.attempts >= 5;
      await pool.query(`SELECT nexora.mark_notification_email_failed($1, $2)`, [
        row.outbox_id,
        permanent,
      ]);
      if (permanent) result.failed += 1;
      else result.pendingRetry += 1;
    }
  }
  return result;
}
