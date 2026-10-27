import "server-only";

// Metrics alerting, evaluated by the token-gated cron route
// (src/app/api/cron/[job]/route.ts, job "alerts").
//
// Rules, both fail-closed:
//   * Database down (the /api/ready probe fails): alert at most once
//     an hour, however often the cron job runs.
//   * Server errors: alert when the process's server-error count
//     crosses another multiple of the threshold since the last
//     alert. The threshold defaults to 10 and is set with
//     NEXORA_ALERT_SERVER_ERROR_THRESHOLD; an invalid value falls
//     back to the default rather than disabling alerting silently.
//   * No recipient configured (NEXORA_ALERT_EMAIL unset) means
//     alerts are disabled, not sent to a guessed address. The
//     documented recommended value is the operator mailbox that
//     already sends Nexora mail; see docs/deployment.md.
//
// Alert state lives in nexora.alert_state, so a recurring cron run
// cannot mail the operator in a loop, and a restart cannot resend
// alerts for errors it already reported. Counters themselves are
// process-local (see src/server/metrics.ts): on a multi-instance
// deployment the cron call evaluates whichever instance serves it,
// so external aggregation of /api/metrics remains the recommended
// monitor there; this job is the single-instance safety net, and
// the database-down rule works on every instance.
export interface AlertEvaluation {
  rule: string;
  triggered: boolean;
  detail: string;
}

export function parseAlertThreshold(value: string | undefined): number {
  if (value === undefined) return 10;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return 10;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 10;
}

export function evaluateServerErrorAlert(
  serverErrorTotal: number,
  threshold: number,
  lastValue: number,
): AlertEvaluation {
  const crossed = Math.floor(serverErrorTotal / threshold);
  const previouslyCrossed = Math.floor(lastValue / threshold);
  if (serverErrorTotal < threshold || crossed <= previouslyCrossed) {
    return {
      rule: "server-errors",
      triggered: false,
      detail: `server errors ${serverErrorTotal}, threshold ${threshold}, last alerted at ${lastValue}`,
    };
  }
  return {
    rule: "server-errors",
    triggered: true,
    detail: `server errors reached ${serverErrorTotal} (threshold ${threshold}, last alerted at ${lastValue})`,
  };
}

export function evaluateDatabaseDownAlert(
  databaseUp: boolean,
  lastSentAt: Date | null,
  now: Date,
): AlertEvaluation {
  if (databaseUp) {
    return { rule: "database-down", triggered: false, detail: "database is up" };
  }
  if (lastSentAt !== null && now.getTime() - lastSentAt.getTime() < 60 * 60 * 1000) {
    return {
      rule: "database-down",
      triggered: false,
      detail: "database is down, alerted within the last hour",
    };
  }
  return { rule: "database-down", triggered: true, detail: "database probe failed" };
}
