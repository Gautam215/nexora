# Nexora deployment runbook

Status: **not deployed anywhere.** This document is the
production-integration configuration and the deploy procedure, prepared
from the implemented code. Nothing in it is live-verified: every
live check is listed in §9 and waits on real credentials and access.
Do not describe Nexora as "live" or "in production" until §9 is done.

## 1. What runs where

- One Next.js application (`npm run build`, then `npm run start`).
  `next start` forces `NODE_ENV=production`.
- One PostgreSQL database (Neon or self-hosted). The application
  connects with the restricted runtime role; migrations run with the
  separate migrator role.
- One private file directory on the application host, holding task
  files. It must be persistent and outside any public path.
- Outbound services, all optional except SMTP: an SMTP provider for
  verification and password-recovery email, Google OAuth for sign-in,
  and an OpenAI-compatible chat-completions endpoint for AI features.
- No queue, no broker, no WebSocket provider, no object-storage
  service. Realtime is SSE over HTTP backed by the database event
  log; cleanup and backup are operator-run scripts (§6).

## 2. Environment variables

All configuration is by environment variable (see `.env.example`).
Never commit a real value, and never commit `.env.local`.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Runtime role, pooled endpoint allowed. The runtime role must not own tables and must not have `BYPASSRLS`. |
| `MIGRATOR_DATABASE_URL` | For migrations | Migrator role, **direct endpoint only, never pooled**. For Neon, `sslmode=require`; the migrator refuses otherwise. |
| `APP_ORIGIN` | Yes | Canonical browser origin. Mutation-origin checks and email links use it; it must match the public URL exactly. |
| `AUTH_RATE_LIMIT_HMAC_KEY` | Yes | At least 32 random bytes. Rate-limit subjects are HMAC-hashed with it. |
| `NEXORA_FILE_SIGNING_KEY` | Yes | At least 32 random bytes. Signs the five-minute task-file download links. |
| `NEXORA_PRIVATE_FILE_DIR` | Yes | Absolute, private, persistent directory. Never under `public/`. |
| `NEXORA_TRUSTED_CLIENT_IP_HEADER` | Yes, in production | A header your trusted ingress overwrites with one client IP. Leave blank only in local development with no ingress; never trust a client-supplied forwarding chain. In production, a missing value makes every rate-limited auth route fail closed with 503 `SERVICE_UNAVAILABLE` ("Authentication is not configured yet") — this was the live failure on 2026-10-27, fixed by setting the header. On Vercel the value is `x-vercel-forwarded-for` (the edge's single client IP); `x-forwarded-for` is not used because it can carry a multi-IP chain, which the single-IP check rejects. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Yes | Verification and recovery email. Missing or broken SMTP fails closed with 503 on the routes that need it; it does not silently degrade. |
| Google OAuth | Removed | Removed 2026-10-26 (migration 0047, user decision: email + password only). No OAuth variables are read anymore. |
| `NEXORA_METRICS_TOKEN` | Recommended | Long random value, sent as `x-nexora-metrics-token`. Blank or unset means `GET /api/metrics` fails closed with 503. |
| `NEXORA_CRON_TOKEN` | Yes, for scheduled jobs | Long random value, distinct from the metrics token, sent as `x-nexora-cron-token`. Blank or unset means every cron call fails closed with 503. |
| `NEXORA_ALERT_EMAIL` | Recommended | Operator mailbox for metrics alerts. Blank means alerts are disabled — never sent to a guessed address. Recommended value: the operator mailbox you monitor (for this deployment, the Nexora mailbox that already sends mail). |
| `NEXORA_ALERT_SERVER_ERROR_THRESHOLD` | No | Server-error count threshold for alerts; default 10. Database-down alerts are sent at most once an hour regardless. |
| `NEXORA_DEFAULT_STORAGE_QUOTA_BYTES` | No | Opt-in default quota (bytes) for organizations with no explicit quota. Blank means no cap, as before. Recommended value, if a default is wanted at all: 1073741824 (1 GiB). An explicit per-organization quota always wins. |
| `AI_PROVIDER`, `AI_PROVIDER_BASE_URL`, `AI_PROVIDER_API_KEY`, `AI_PROVIDER_MODEL` | No | Unset (or anything other than `http`/`mock`) means AI endpoints fail closed with 503 `AI_UNAVAILABLE`. `mock` is a deterministic test double and is refused in production. `http` uses a generic OpenAI-compatible chat-completions endpoint; the key is server-only and never logged. |

## 3. Database setup

1. Create the database and two roles: a migrator role that owns the
   schema, and a runtime role with no table ownership and no
   `BYPASSRLS`.
2. Apply migrations from a host that can reach the database:
   `MIGRATOR_DATABASE_URL=<direct-url> npm run db:migrate`.
   The migrator applies `db/runtime-grants.sql` in the same run;
   never run grants as a manual follow-up.
3. Migrations are numbered, immutable, and append-only. A migration
   that has run anywhere is never edited; a correction is a new
   migration. There are no down migrations: a bad deploy is rolled
   back by redeploying the previous code and, if the schema changed,
   shipping a forward-fix migration (§8).
4. Neon notes: use the direct endpoint with `sslmode=require`, never
   the pooled endpoint, for migrations. Direct database TCP from some
   sandboxes is blocked by egress policy; that block is an operator
   setting to change, not something to work around.

## 4. Application start

1. `npm ci` (or the project's install step), `npm run build`.
2. Start with the §2 variables set, e.g.
   `PORT=3000 APP_ORIGIN=https://<public-host> DATABASE_URL=… npm run start`.
3. Verify, in order: `GET /api/health` returns 200 (liveness only,
   always 200 — it proves the process answers, nothing more);
   `GET /api/ready` returns 200 with `database: "up"` (readiness —
   the process can actually serve); then sign in once through the
   browser and open a workspace.

## 5. Multi-instance limits (read before scaling)

- Request counters and the presence roster are process-local. An
  external monitor must aggregate `/api/metrics` across instances,
  and presence on one instance will not list members connected to
  another.
- The private file directory is local disk. Files do not survive a
  move to multi-instance deployment. Shared object storage is a
  deployment decision (§10), not a code change to improvise at
  deploy time.
- The realtime event log is shared through the database, so streams
  work across instances at polling cost.

## 6. Recurring jobs

Two kinds of recurring work exist. The cron route (below) is the
scheduled path for jobs the application itself can run; backup
remains an operator-run script because a serverless route cannot
`pg_dump` as a superuser/BYPASSRLS role.

### 6a. Cron route (due-date, cleanup, email-outbox, alerts)

`GET /api/cron/<job>` with header `x-nexora-cron-token:
<NEXORA_CRON_TOKEN>`, where `<job>` is one of `due-date`,
`cleanup`, `email-outbox`, `alerts` (migration 0049,
`src/server/scheduled.ts`). The token is the only authentication:
cron callers are not browsers, so the origin check does not apply.
If `NEXORA_CRON_TOKEN` is unset, every call fails closed with 503.
Each job claims one row per day in `nexora.scheduled_job_runs`;
a second call the same day replays the first run's result instead
of repeating work, and a failed run can be retried the same day
(the claim is replaced, not kept as a block).

- **due-date (daily, morning):** creates one in-app `due_date`
  reminder per task due tomorrow, addressed to the assignee. The
  reminder uses a narrow system policy (migration 0049) that
  permits a self-addressed `due_date` insert only when the
  transaction flag `nexora.system_job` is exactly `'due-date'`
  (set only by this route), the recipient can work on the
  project, and the recipient has not disabled `due_date` in-app
  notifications. No other event or actor can use that policy.
- **cleanup (daily, off-peak):** purges expired organizations
  (tombstone + audit retained, slug reserved), projects,
  milestones, and task files through the existing purge
  functions, and removes the file objects those purges return.
  A failed object removal leaves an orphan for
  `scripts/cleanup-task-files.mjs` to report; it does not fail
  the database purge.
- **email-outbox (every minute):** runs one worker batch
  (20 rows, same as `npm run notifications:email-worker`).
  Fails closed when SMTP is unconfigured; rows stay pending.
- **alerts (every 5–15 minutes):** evaluates the metrics
  counters (see §6b) and mails the operator when a rule fires.
  Counters are process-local, so on a multi-instance deployment
  this job evaluates whichever instance serves the cron call;
  external aggregation of `/api/metrics` remains the recommended
  monitor there, and the database-down rule works on every
  instance.

Production schedule (shipped in `vercel.json`, UTC):
`due-date` daily 02:00, `cleanup` daily 03:00, `email-outbox`
daily 04:00, `alerts` daily 05:00. All four are daily-only on
purpose: Vercel's Hobby plan rejects any cron expression that
runs more than once per day at deploy time, so the tighter
cadences the jobs were designed for (`email-outbox` every
minute, `alerts` every 10 minutes) are NOT in `vercel.json`.
To run those cadences, either upgrade the project to Pro
(then tighten the two schedules in `vercel.json` and redeploy)
or point a header-capable external scheduler at the same
routes with the `x-nexora-cron-token` header — no code change
needed for the external path. Vercel Cron timing on Hobby is
guaranteed only within the hour, and every schedule change
needs a redeploy.

Production steps:
1. Set `NEXORA_CRON_TOKEN` (long random value, distinct from
   `NEXORA_METRICS_TOKEN`) in Production and redeploy.
2. Set `CRON_SECRET` in Production to the SAME value as
   `NEXORA_CRON_TOKEN` and redeploy. Vercel Cron sends
   `Authorization: Bearer <CRON_SECRET>` with every cron call,
   and the route accepts that Bearer form as the same token
   (the `x-nexora-cron-token` header still works for manual
   and external callers). Never remove the token, and never set
   either variable to a value the other does not share, or
   Vercel Cron calls will 401.
3. Check the first run of each job in `scheduled_job_runs`
   (status `ok` and its detail) before relying on it.

### 6b. Operator-run scripts

Run them from a host that can reach the production database, and
keep each run's stdout as the audit trail.

- **Cleanup, daily (off-peak):**
  `DATABASE_URL=<runtime-role-url> NEXORA_PRIVATE_FILE_DIR=<production dir> node scripts/cleanup-task-files.mjs`
  Purges expired organizations (tombstone + audit retained, slug
  stays reserved), projects, milestones, and files, and reports
  orphan counts plus a shortfall warning when a purge skips rows.
  `--dry-run` reports without deleting. The script itself is covered
  by integration tests; what is NOT yet proven is that the schedule
  runs in production — record where the schedule lives when it is
  installed, and check its first run's output.
- **Backup, daily (off-peak, before cleanup):**
  `scripts/backup-database.sh` (§7). The dump MUST run as a
  superuser or another `BYPASSRLS` role, not as the migrator:
  `notifications` has `FORCE ROW LEVEL SECURITY`, so even its owner
  cannot `COPY` it out and a migrator-role dump fails. The dump
  records the migrator as owner of every object, so a restore keeps
  ownership.

## 7. Backup and restore

`scripts/backup-database.sh` writes a `pg_dump` custom-format dump
plus a tarball of the private file directory, both timestamped, and
verifies the dump file is non-empty. Restore is the reverse: create
a fresh database, restore the dump, restore the file directory, run
migrations (no-op if the dump is current), then verify with
`GET /api/ready` and one signed-download check returning the original
bytes. A full restore rehearsal against disposable infrastructure is
already proven (see `IMPLEMENTATION_PLAN.md` Phase 4 item 5); repeat
it against the production backup before relying on it, and record
the rehearsal date here when it happens.

## 8. Rollback

- Code rollback: redeploy the previous build. It is safe against the
  current schema only if no migration in the newer deploy changed a
  contract the older code depends on; check the migration list
  before rolling back code.
- Schema rollback: there is none. Ship a forward-fix migration.
- Never edit an applied migration, never run a production migration
  without explicit authorization for that database, that migration,
  and that run, and never commit or push from a deploy host without
  the same explicit authorization.

## 9. Pre-launch live-verification checklist

Each item needs real credentials or access and is NOT done:

- [ ] Neon (or production Postgres) migration with the migrator role
      over the direct endpoint, `sslmode=require`.
- [ ] Production SMTP send: registration verification and
      password-recovery email arrive.
- [ ] Google OAuth live sign-in and account linking with real client
      credentials (plus a 32+ byte flow-signing key).
- [ ] Real AI provider call for each workflow (summarize, planning,
      extraction, risk, assistant) and the two blocked evaluation
      cases (live hallucination measurement, live prompt-injection
      resistance).
- [ ] `GET /api/metrics` scraped with the real token from the
      external monitor; alerts configured for 5xx rate and
      `database.up` false.
- [ ] First production cleanup run observed, and its output kept.
- [ ] Backup restore rehearsal against the production backup,
      including a signed download returning original bytes.
- [ ] Presence checked with two real browsers on the deployed host
      (single-instance roster is the expected result until a shared
      presence store exists).

## 10. Open deployment decisions (recommendations, not defaults)

These are recorded in `IMPLEMENTATION_PLAN.md` "Open decisions" and
summarized here so deploy planning does not mistake them for settled
choices:

- **Shared object storage:** use an S3-compatible store with
  presigned downloads when moving past one instance; keep the
  current authorization, signing, and integrity checks, and migrate
  existing files by copy-then-verify, never by move-then-hope.
  Needs a provider choice and credentials.
- **Malware scanning:** scan uploads with a ClamAV sidecar (or an
  equivalent scanning API) before a file becomes downloadable, gated
  so a scanner failure quarantines the file instead of silently
  accepting or silently dropping it. Needs a service choice.
- **Alert channel:** an external monitor scraping `/api/metrics`
  (alert on 5xx rate and `database.up` false) plus the structured
  failure logs. Needs an email address or webhook.
- **Notification email — IMPLEMENTED 2026-10-26 under the
  user-approved default:** the PRD explicitly defers it ("design the
  architecture so email notifications can be added safely later").
  Implemented shape: a database outbox written in the same
  transaction as the notification (migrations 0040–0043), plus a
  worker (`npm run notifications:email-worker`, run every minute)
  that claims, sends, and marks, with 5-minute-per-attempt backoff
  and failure after 5 attempts. Email is off by default and opt-in
  twice over: the operator must list event types in
  `NEXORA_NOTIFICATION_EMAIL_TYPES`, and the recipient must enable
  email for that type in preferences (`email_enabled`, default
  false). The worker fails closed when SMTP is unconfigured and
  leaves rows pending. Two defects found and fixed in this work:
  FORCE RLS on the outbox table blocked SECURITY DEFINER functions
  (0041), and the outbox enqueue's notification SELECT hit the
  notifications table's FORCE-RLS recipient-only select policy, so
  an actor could not verify their own notification (0043: the
  check now uses org membership, and the outbox FK to
  notifications(id) is the existence check).
- **Session rotation — IMPLEMENTED 2026-10-26 under the
  user-approved default:** rotate on privilege change, not on a
  timer — timer rotation costs users sessions without a clear
  security gain. See ARCHITECTURE.md §7 and migration 0039.
- **Notification stream delivery — IMPLEMENTED 2026-10-26 under
  the user-approved default:** `notification.created` over SSE on
  a per-organization, per-recipient channel
  (`GET /api/organizations/{id}/notifications/stream`), not on
  project streams. A global per-user stream was rejected because
  it would need a recipient-only policy that bypasses the
  project-access check and would leak old notifications after a
  project removal; the per-org channel reuses the notifications
  table's FORCE RLS policy (recipient + organization + project
  still accessible), so another user's notifications are never
  visible, even by guessing an id.
- **Shared storage — abstraction IMPLEMENTED 2026-10-26, live S3
  NOT verified:** all file routes and the cleanup script go
  through `src/server/storage.ts` (`NEXORA_STORAGE_PROVIDER`:
  `local` default, `s3` S3-compatible via fetch + SigV4, no SDK).
  Switching providers in production is a copy-then-verify
  migration, not a flag flip: copy every `<uuid>.blob` object to
  the new store, verify byte counts and SHA-256 hashes against
  `task_files`, keep the old store read-only until the new store
  serves a full cleanup + download check, and only then switch
  the provider variable. The `s3` adapter has unit tests against
  a fake HTTP server only; do not claim live S3 integration until
  that migration has actually run against a real endpoint.
- **Malware scanning — abstraction IMPLEMENTED 2026-10-26, live
  ClamAV NOT verified:** `src/server/malware.ts` speaks clamd
  INSTREAM over TCP (no SDK); uploads are scanned synchronously
  and recorded as `clean`, `quarantined` (infected or scanner
  unavailable — fail closed), or `pending` (no scanner
  configured). Quarantined files are never downloadable (409
  FILE_QUARANTINED, including for signed links). Do not claim
  malware protection is operational until a real clamd is
  configured and `scripts/rescan-task-files.mjs` has cleared the
  pending/quarantined backlog; the ClamAV adapter is unit-tested
  against a fake clamd only.
- **Organization storage budgets:** upload caps exist per task
  (10 MB/file, 20 files, 100 MB/task); organization-level budgets and
  usage tracking need budget numbers before implementation.
