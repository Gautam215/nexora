import { processNotificationEmailBatch, closeEmailOutboxPool } from "../src/server/notifications/email-outbox.ts";
import { EmailConfigurationError } from "../src/server/email.ts";

// Notification-email worker (approved default, 2026-10-26).
// Run on a schedule, e.g. every minute, with --once (the only mode):
//   npm run notifications:email-worker
// Optional: --limit N (default 20, max 100).
// The worker fails closed when SMTP is unconfigured: it marks no
// row sent, returns pending rows for a later run, and exits 1 so
// the operator's scheduler logs the misconfiguration instead of
// silently reporting success. Rows claimed by a crashed worker are
// reset after 30 minutes (see the outbox migration); a row that was
// actually sent before a crash could therefore be sent twice —
// at-least-once delivery, documented in ARCHITECTURE.md, not hidden.

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 20;
if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
  console.error("notification-email-worker: --limit must be an integer between 1 and 100");
  process.exitCode = 2;
} else {
  try {
    const result = await processNotificationEmailBatch(limit);
    console.log(
      `notification-email-worker: claimed ${result.claimed}, sent ${result.sent}, failed ${result.failed}, pending retry ${result.pendingRetry}.`,
    );
  } catch (error) {
    if (error instanceof EmailConfigurationError) {
      console.error("notification-email-worker: SMTP is not configured; no rows were marked sent.");
    } else {
      console.error(JSON.stringify({ event: "notification_email.worker_failed", errorName: error instanceof Error ? error.name : "unknown" }));
    }
    process.exitCode = 1;
  } finally {
    await closeEmailOutboxPool();
  }
}
