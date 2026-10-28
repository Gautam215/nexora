# Per-dependency degradation (PRD 32)

What the app does when each dependency it relies on is down,
slow, or unconfigured. The rule throughout: fail closed and
stay usable for everything that does not need the failed
dependency. Nothing here is a fallback that serves stale or
fabricated data — a failed dependency means an honest error
for the feature that needs it, not a degraded answer.

| Dependency | Failure | User impact | Operator signal | Recovery |
| --- | --- | --- | --- | --- |
| PostgreSQL (Neon) | Unreachable / scale-to-zero wake-up | `/api/ready` 503 (not ready); `/api/health` 200 with `database: "unavailable"` (liveness never flaps); pages and API routes fail with controlled errors, no stack traces | `database.up: false` on `/api/metrics`; alerts job fires `database-down` when configured | Automatic: Neon wakes on next connection; the pool retries on the next request (no restart needed). Verified by the outage test (ready 503 → health 200 → ready 200 after recovery). |
| SMTP (Gmail) | Unreachable / misconfigured | Registration, verification resend, and password-reset fail closed with 503 (`EMAIL_DELIVERY_UNAVAILABLE` or `SERVICE_UNAVAILABLE`) before any account or token work; in-app notifications unaffected; outbox rows stay `pending` with backoff, marked `failed` after 5 attempts | Outbox `pending`/`failed` counts on `/api/metrics` (`operator.outbox`); failed rows visible in the outbox table | Automatic for queued mail (outbox retries); configuration failures need the operator to fix SMTP env and redeploy. Verified by the outage test (row stays pending, attempts 1, next attempt in the future). |
| AI provider (Gemini) | HTTP failure / timeout / unconfigured | AI routes answer 503 `AI_FAILED` with a controlled UI failure, never a fabricated result; the rest of the app is fully usable (PRD 41) | `ai.circuitOpens` on `/api/metrics`; route failures logged per operation | Automatic: one bounded retry on 429/502/503/504; after 5 consecutive failures the circuit breaker opens for 60 s (one probe, then close or reopen); the mock provider is never wrapped. |
| S3 (Backblaze B2) | Unreachable / misconfigured | Uploads fail; downloads of existing files fail; tasks, comments, and projects keep working | Upload/download errors in route logs; `FILE_STORAGE_NOT_CONFIGURED` (503) when the signing key or provider env is missing | Operator fixes provider env/credentials and redeploys; no data loss (rows stay, bytes stay in the bucket). |
| ClamAV | Unset (production today) / unreachable | Unset: uploads are recorded `pending` (unscanned, downloadable — stated, not hidden). Unreachable when configured: uploads are recorded `quarantined` (fail closed); quarantined files cannot be downloaded (409 `FILE_QUARANTINED`) | Upload scan status on the file row; rescan script reports counts | Operator sets a reachable clamd endpoint, then runs `scripts/rescan-task-files.mjs` (migrator role, `--dry-run` first). |
| Vercel platform | Function timeout (300 s stream cap) / cold start | SSE streams end at 300 s; the client reconnects automatically with replay from the durable event log (no events lost) | Stream reconnects visible as new `connectionsTotal` counts | Automatic: reconnect + replay. Not a bug, not a degradation to fix in code. |
| Browser / network | Client offline mid-mutation | Idempotency keys make creation retries safe (same key + body replays, different body 409s); version-guarded updates conflict instead of overwriting | Client-side retry UI (Retry buttons on load errors) | User retries; the server converges instead of duplicating. |

## What is NOT degraded

- Authorization never degrades: a failed dependency never
  turns into an allowed action. RLS denials, missing grants,
  and configuration errors fail closed (503 or 403), never
  open.
- Audit never degrades silently: an audit write happens in
  the same transaction as the action it records. If the
  transaction fails, the action fails with it.
- The AI circuit breaker is per-process (see ARCHITECTURE.md
  §9d): one process's open breaker does not stop another
  process's requests, and every process still fails closed.
