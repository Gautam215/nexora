# Nexora — Architecture

This document defines exactly how Nexora is built, and how it must be built
next. It is grounded in the shipped code, not in a generic template. Where it
describes a future capability (realtime, AI, object storage), it says so
explicitly and separates it from what exists today.

Product source of truth: the Nexora PRD and `DESIGN.md`. Database detail is in
`DATABASE.md`; endpoint detail is in `API.md`; day-to-day rules are in the
project `AGENTS.md` (this repository's root `AGENTS.md`, not the assistant's
own operating manual).

## 1. Recommended tech stack, with reasoning

| Layer | Choice (shipped) | Why this, and why not something else |
| --- | --- | --- |
| Web framework | Next.js 16.3.6, App Router, React 19.1, TypeScript 5.7, strict | One framework for pages and API routes, same-origin by design, server components for server authority. No separate backend service: the product is not large enough to justify one, and a split would duplicate the authorization boundary. |
| Language | TypeScript, strict, `tsc --noEmit` | The authorization and tenant rules are too important to leave to untyped code. Strict mode is a gate, not a preference. |
| Database | PostgreSQL 16, via `pg` 8.16.3 | Relational integrity, transactions, RLS, full-text search, and advisory locks are all load-bearing in this product. No ORM: migrations are hand-written SQL, and queries are parameterized SQL, so the schema is visible and reviewable. |
| Validation | Zod 4.6.5 | Every API input is validated by a schema in `src/security/` before any business logic runs. |
| Email | Nodemailer 10, SMTP with TLS by default | Verification, reset, and invitation links are emailed once. No email provider SDK is introduced until email delivery itself is verified in production. |
| Lint/format | Biome 2.5.15, `biome lint src tests scripts` | One tool for linting, run on source, tests, and scripts alike. |
| Tests | Node's built-in test runner, `--experimental-strip-types` | No test framework dependency. Integration tests run only against a disposable database and skip by design when none is configured. |
| Files | Server-only private filesystem directory, opaque UUID names | The product has no object-storage dependency yet. This is a deliberate, documented limitation: a single instance works; horizontally scaled instances must share storage (see section 8). |
| Not used | Redis, queues, WebSockets, AI providers, object storage, a separate API server | Each is a PRD capability with a future design, not a current dependency. Adding any of them before its authorization and failure design exists would create a second, unchecked data path. See section 10 for the MVP/future split. |

## 2. Frontend architecture

- **Routing:** Next.js App Router. Pages live under `src/app/`; API routes
  under `src/app/api/`. There are 18 page routes and 33 API route files.
- **Server/client boundary:** Server components and route handlers are
  authoritative. Client components exist only for interactivity (forms,
  boards, dialogs, notification centre). A client component never decides
  authorization, and never receives a secret, a token, or a storage key.
- **Data fetching:** Pages and route handlers read from PostgreSQL through
  `src/server/`. There is no client-side data layer, no SWR-style cache,
  and no client state store. Pagination is server-side and bounded.
- **Caching and revalidation (PRD 35, decided 2026-10-28):** there
  is no application cache to invalidate, by design. Authenticated
  pages are dynamic: every data fetch uses `cache: "no-store"`,
  so the server is authoritative on every request and a role
  change, removal, or disable takes effect on the next load
  without a revalidation protocol. API responses set
  `cache-control: no-store` in the shared JSON helpers, so no
  browser or proxy may serve a stale authorized response. The
  only caching in the system is Next.js's own static-asset
  handling: hashed `_next/static` chunks are immutable and
  long-lived, which is safe because their content is addressed
  by hash, not by URL. There is no CDN page cache, no
  server-side rendered-page cache, and no manual invalidation
  list — adding any of them would need a per-route
  authorization review first, because a cached authorized page
  is a privilege leak waiting for a stale entry.
- **Components:** One component per screen or panel, in
  `src/app/components/`, following `DESIGN.md`. Components are reused across
  screens; a new screen reuses an existing component before creating one.
- **Styling:** A single global stylesheet, `src/app/globals.css`, driven by
  the tokens in `DESIGN.md`. No CSS-in-JS, no component library, no
  Tailwind. Inline styles are not used for progress bars (semantic
  `<progress>` instead), which also keeps the CSP strict.
- **Security headers and CSP:** `src/proxy.ts` (Next.js middleware, called
  "proxy" in this codebase) generates a per-request nonce CSP for page
  responses. The matcher excludes `api/`, `_next/static`, `_next/image`,
  and `favicon.ico`. API routes set their own headers through the shared
  JSON helpers. Frame denial, MIME-sniffing protection, `no-referrer`, and a
  restrictive permissions policy are enabled.
- **Error boundaries and loading states:** Every data screen defines loading,
  empty, error, and permission-denied states (see `DESIGN.md` section 6).
  A screen that only handles the happy path is unfinished.

## 3. Backend architecture

- **Route handlers:** Each API route is a small handler that (1) authenticates
  the opaque session, (2) resolves the user, (3) validates input with a Zod
  schema, (4) runs business logic inside a tenant transaction, and (5)
  returns the shared JSON envelope. No handler trusts the request body for
  identity, role, or tenant.
- **Shared helpers:** `src/server/api.ts` owns the JSON envelope
  (`{data, requestId}` / `{error, requestId}`), `no-store` responses,
  request IDs, the 16 KB JSON cap, origin checks, and safe failure mapping
  (including serialization conflicts as 409). Every route uses these
  helpers; no route builds its own response shape.
- **Business logic:** `src/server/` holds auth, organizations, projects,
  milestones, tasks, comments, mentions, notifications, analytics, search,
  and private files. `src/security/` holds the validation schemas, password
  and token handling, rate limits, and organization-access rules.
- **Scheduled jobs (migration 0049, 2026-10-27):** The token-gated
  cron route `GET /api/cron/<job>` (`src/server/scheduled.ts`)
  runs four jobs — `due-date` (daily reminders for tasks due
  tomorrow), `cleanup` (expired-record purge + file-object
  removal), `email-outbox` (one worker batch), and `alerts`
  (metrics alerting, see §12). Each job claims one row per day in
  `nexora.scheduled_job_runs`, so a repeated call replays instead
  of repeating work. The repository still schedules nothing by
  itself: the operator adds the schedule deliberately (see
  `docs/deployment.md` §6). Operator hardening (2026-10-28
  security round): every cron call consumes the DB-backed
  per-IP rate limit (scope operator-cron, 120/hour, migration
  0063) and every failed authentication is logged as a
  structured operator.auth_failed event (endpoint only, never
  the token); the metrics endpoint has the same protection
  under scope operator-metrics. Operator hardening
  (2026-10-29 controls round, local only until pushed):
  the metrics route now authenticates before answering but
  after its rate limit, locks an IP out for 15 minutes after
  five failed tokens (peek-only scope
  operator-metrics-lockout, migration 0066, corrected by
  0068), alerts once per hour at ten global failures through
  the existing alert state and mailer, and authenticates
  cron calls before routing to a job (no lockout on cron, by
  design). The two operator aggregate functions no longer
  execute on the app pool at all: migration 0066 revoked
  EXECUTE from `nexora_app`, and the metrics route runs
  them through a separate operator pool
  (`NEXORA_OPERATOR_DATABASE_URL`); the dedicated role is
  created and granted by the database owner, not by any
  migration. Authenticator second factor (2026-10-29,
  migration 0067, local only until pushed): TOTP secrets
  (RFC 6238, SHA-1, 30 s steps, 6 digits, ±1 step window)
  are generated with the platform RNG, stored only as
  AES-256-GCM ciphertext under `NEXORA_TOTP_ENCRYPTION_KEY`
  in `nexora.user_totp_credentials` (RLS self policies),
  and, once verified, gate account and workspace deletion
  alongside the current password; enrollment shows the
  manual key plus the otpauth:// URL (no QR library, no new
  dependency), and unenrolled users proceed on password
  alone by approved design. The file-retention/orphan cleanup
  script (`scripts/cleanup-task-files.mjs`) remains the
  operator-run fallback for object orphans. Backup remains an
  operator script: a serverless route cannot `pg_dump` as a
  superuser/BYPASSRLS role, so no cron job pretends to back up.

## 4. Data flow

A typical tenant request flows like this:

1. The browser calls a same-origin API route. No CORS header is emitted;
   cross-origin access is not supported by design.
2. A mutating request must pass the same-origin check (`hasSameOrigin`:
   configured `APP_ORIGIN`, an `Origin` header, and a `same-origin`
   Fetch Metadata value, with `https:` required in production except
   for loopback origins (`localhost`, `127.0.0.1`, `::1`), which are
   potentially trustworthy origins and may run a production build
   over HTTP locally; a non-loopback HTTP origin is still rejected,
   and the request origin must still equal the configured origin). A
   GET does not require an origin header.
3. The handler authenticates the opaque session cookie and resolves the
   user from the database (never from the cookie value alone).
4. For personal data, `withUserContext` runs the work in a transaction with
   the user context set. For organization/project data,
   `withOrganizationContext` first verifies active membership, then sets
   the organization context, and only then calls tenant business logic.
   Callers pass a minimum role requirement, never a trusted role.
5. Inside the transaction, `set_config('nexora.user_id', …, true)` and
   `set_config('nexora.organization_id', …, true)` are set
   transaction-locally, so a pooled connection cannot retain another
   request's context. RLS policies read those values.
6. The business logic runs parameterized SQL, writes audit records where
   required, and commits. PostgreSQL is authoritative; any future realtime
   message will only signal a committed change, never carry the change
   itself.
7. The handler returns the shared envelope with `no-store` and a request
   ID. Failures are logged server-side as structured JSON
   (timestamp, severity, service, `api.request_failed`, operation,
   request ID, error name, and a validated database code where present)
   and returned to the client as a generic message with no database detail.

## 5. Folder structure (shipped)

- `src/app/` — pages, layouts, and the global stylesheet.
- `src/app/components/` — screen and panel components.
- `src/app/api/` — API route handlers, grouped by resource
  (`auth/`, `invitations/`, `organizations/`).
- `src/server/` — server-only business logic and database access.
- `src/security/` — validation schemas, passwords, tokens, rate limits,
  organization access, CSP, and file-access rules.
- `src/proxy.ts` — per-request nonce CSP for page responses.
- `db/migrations/` — numbered, immutable SQL migrations `0001`–`0022`.
- `db/runtime-grants.sql` — the runtime role's grants, applied after
  migrations by the migrator (never by hand in production, and never
  skipped — see the PostgreSQL diagnosis in the project history).
- `scripts/` — the migrator, the environment loader, the cleanup command,
  and migration utilities.
- `tests/` — unit, schema, guard, and integration tests. Integration tests
  are named `*.integration.test.ts` and skip when no disposable test
  database is configured.
- `docs/` — the existing architecture baseline, PRD traceability, and
  threat model. This document and its companions (`DESIGN.md`,
  `DATABASE.md`, `API.md`, project `AGENTS.md`, `IMPLEMENTATION_PLAN.md`)
  live at the repository root and are the current source of truth;
  `docs/architecture.md` is retained as history and must not be edited to
  contradict them.

## 6. Database interaction

- **Pool:** `pg` Pool, at most 12 connections, 5 s connection timeout
  (15 s for `.neon.tech` hosts, to absorb Neon scale-to-zero wake-up),
  30 s idle timeout, 10 s statement timeout, 12 s query timeout, and an
  `error` listener so a dead idle client is logged and discarded instead
  of crashing the process. `application_name` is `nexora-web`.
  Before the pool is created, `sslmode=require` in the connection
  string is rewritten to `sslmode=verify-full` (query part only,
  credentials untouched): the same behaviour pg already applies,
  stated explicitly, so pg's deprecation warning never reaches
  stderr where Vercel counts it as an error.
- **Roles:** Two database roles, never one. `MIGRATOR_DATABASE_URL` is the
  schema owner/migration role; `DATABASE_URL` is the restricted runtime
  role, which owns no tables and has no `BYPASSRLS`, `CREATEROLE`, or
  `CREATEDB` privilege. The migrator applies migrations, then applies
  `db/runtime-grants.sql` in the same run (this is now automatic; the
  earlier failure mode was a manual grants step that could be skipped).
- **Migrations:** Numbered, immutable, applied in order by
  `scripts/migrate.mjs` under a session advisory lock. The migrator refuses
  a pooled (`-pooler`) endpoint — the session lock is unsupported in
  PgBouncer transaction pooling — and refuses a Neon URL without
  `sslmode`. Every migration records itself in `nexora.schema_migrations`
  with a checksum; a mismatch fails the run rather than silently
  re-applying.
- **Transactions:** Multi-write operations share one transaction where
  required (membership + audit, comment + mentions + notifications,
  task + activity). Known serialization failures (`40001`) return a
  generic 409. A commit whose outcome is unknown is surfaced as such, not
  reported as success.
- **RLS:** Every tenant table has RLS, and the runtime role is forced
  through it. Policies are listed in `DATABASE.md`. A small number of
  `SECURITY DEFINER` functions exist only where RLS would otherwise be
  recursive (organization-creator bootstrap) or where a narrow, checked
  operation needs it (member listing, file-download locking, rate-limit
  consumption, auth lookups); each has a fixed `search_path` and checks
  the current project/organization authority before acting.

## 7. Authentication and authorization

- **Passwords:** Node scrypt (N=32768) with random salts. No other password
  scheme is accepted, and no password is ever logged or returned.
- **Sessions:** Opaque session tokens, stored only as SHA-256 hashes, with
  host-only, `HttpOnly`, `SameSite=Strict` cookies (`Secure` in
  production), 14-day lifetime. Verification and reset tokens are
  single-use and also stored only as hashes. Invalid hashes still do dummy
  scrypt work so timing does not leak validity.
- **Session rotation (approved default, 2026-10-26):** No periodic
  rotation. A session token alone never grants a role, and every
  request re-checks membership, so a role downgrade takes effect
  immediately. Revocation is defense-in-depth on privilege change:
  organization membership downgrade or disable revokes all of the
  target user's sessions in the same transaction (migration 0039,
  `SECURITY DEFINER` functions that refuse owner targets and require
  an admin/manager caller); project membership disable revokes in
  the same transaction, while a project role-only change does not
  revoke. Password change revokes all other sessions and keeps the
  current trusted session; unauthenticated password reset revokes
  all sessions. The revoked count is recorded in the membership
  audit details as `sessionsRevoked`.
- **Rate limits and abuse protection:** Login and recovery use bounded
  JSON, Zod validation, same-origin/Fetch Metadata checks, and fixed-window
  PostgreSQL rate limits with HMAC-derived subjects (per-user and per-IP
  scopes, with a production trusted-ingress IP header that must contain
  exactly one client IP). Missing security configuration fails closed.
- **Roles:** Organization roles are `owner`, `admin`, `member`, `guest`.
  Project roles are `manager`, `member`, `viewer`; project ownership is
  tracked separately. Organization managers retain project-management
  authority; project roles never grant workspace-wide authority. Unknown
  roles fail closed.
- **Authorization boundary:** Server-side only. Frontend visibility is not
  a security boundary, and a client-supplied role is never trusted.
  `withOrganizationContext` is the single gate for tenant operations;
  RLS is the second, independent gate at the database.
- **Authentication scope:** Email + password only. Google OAuth was
  implemented (migration 0032) and removed by user decision
  2026-10-26 (migration 0047, see section 7.1); no OAuth provider
  is in scope unless the user asks for one again. Logged-in
  password change, active session list, and revoke-all are built
  (API and `/account` UI).

## 7.1 OAuth — REMOVED 2026-10-26 (email + password only)

Google OAuth was implemented in migration 0032 and removed by user
decision on 2026-10-26 ("Sirf email/password rakho"): the only
sign-in path is now email + password (registration, email
verification, login, password reset, logged-in password change, and
active-session management). The removal is append-only migration
0047: it drops `nexora.oauth_identities` and
`nexora.lookup_oauth_identity`, deletes leftover `oauth-start` /
`oauth-callback` rate-limit buckets, and removes those two scopes
from both the `auth_rate_limits` CHECK and the
`consume_auth_rate_limit` allowlist. Migration 0032 is kept
untouched as history. The OAuth routes, provider code, sign-in
button, and account-link section were deleted with the removal;
`users.password_hash` stays nullable (0032 made it so) because
restoring NOT NULL would fail on any database that already has an
OAuth-only user — login by password already treats a NULL hash as
a failed verification, and a former OAuth-only user can recover
through the password-reset flow, which sets a hash. No Google
client credentials are needed anymore, and no OAuth provider is
planned unless the user asks for one again.

## 8. External services

| Service | Purpose | Notes |
| --- | --- | --- |
| PostgreSQL (Neon in the user's deployment, any PostgreSQL 16 locally) | Authoritative data | Direct endpoint for the migrator; pooled endpoint only for the app, never for migrations. `sslmode=require` is mandatory for Neon. |
| SMTP | Verification, reset, invitation links | TLS by default, canonical `APP_ORIGIN` in links, non-enumerating responses. Production delivery is unverified and is a release gate. |
| Private filesystem | Task-file bytes | Server-only directory outside `public/`, opaque UUID names, restrictive permissions. Durable encrypted shared storage is a deployment follow-up; without it, multi-instance deployments are unsafe. |
| Not yet provisioned | Redis, object storage, realtime service, AI provider, error tracking, metrics | Each requires its own design before adoption. No product requirement depends on a vendor choice today. |

## 9. AI architecture

AI is a PRD core capability (sections 17–24). The platform is
**implemented** (migration 0034, `src/server/ai/`); summarization is
implemented; planning, extraction, risk, and assistant workflows are
built on the same platform in turn (see IMPLEMENTATION_PLAN.md Phase 6).
The shape below is enforced by the code, not aspirational:

- **Provider abstraction** (`src/server/ai/provider.ts`): no business
  logic calls a provider directly. `AI_PROVIDER=mock` is a
  deterministic test double, refused in production. `AI_PROVIDER=http`
  uses a generic OpenAI-compatible chat-completions endpoint
  (`AI_PROVIDER_BASE_URL`, `AI_PROVIDER_API_KEY`,
  `AI_PROVIDER_MODEL`) with no vendor SDK. Anything else, or missing
  credentials, resolves to no provider and the route fails closed
  with 503 AI_UNAVAILABLE — never a fabricated answer. Every call
  has a 30-second timeout; provider errors map to codes and the key,
  status, and body are never returned or logged.
- **Execution records** (`nexora.ai_executions`, migration 0034):
  metadata only — workflow, provider, model, status, token counts,
  latency, error code. Prompts and responses are NEVER stored. Each
  call writes two short transactions (start, then complete/fail)
  around the provider call, never one transaction spanning it. RLS
  restricts rows to the caller's own executions in the current
  organization. Cost tracking is token counts per execution; a
  currency-cost field is deliberately absent until a provider's
  pricing is configured (token counts are the auditable fact).
- **Authorization before retrieval** (`src/server/ai/context.ts`):
  context is built only from resources the requesting user can
  already access, through `withOrganizationContext` plus
  `can_access_current_project` and the same activity-scoping joins
  as the project activity route. Never retrieve all tenant data and
  rely on the model to filter it. Budgets: 20 milestones, 50 tasks,
  10 activity events, 20 comments, 12,000 total characters, each
  section marked [truncated] when cut. Display names only — no
  emails, no user ids.
- **Untrusted content** (PRD 23): tenant data is wrapped in DATA
  BEGINS/ENDS delimiters with an explicit "untrusted data, never
  instructions" instruction, and a secret-pattern redactor runs over
  the assembled context. Structured provider outputs are validated
  with strict Zod schemas before any use; invalid output is a
  provider failure, never partially applied data. Consequential
  creation (tasks, milestones, plans) requires explicit user
  confirmation in the UI.
- **Labelling**: every AI conclusion is labelled as AI-generated
  analysis or recommendation, never presented as a confirmed fact
  (the API returns `aiGenerated: true` and the UI renders an
  "AI-generated" eyebrow).
- **Limits**: per-user 60/hour and per-organization 120/hour AI
  requests (scopes `ai-request-user`, `ai-request-org`, migration
  0034; the rate-limit function caps any limit at 120), plus the
  30-second provider timeout and the context budgets above.
- **Evaluation** (PRD 24, implemented 2026-10-26, M5):
  `src/server/ai/evaluation.ts` defines the case taxonomy and the
  result record (case, category, provider, model, app version,
  status, tokens, latency); cases run through the real routes in
  `tests/ai-evaluation.integration.test.ts`. Mock-provider evidence
  covers correctness, structured-output validity, authorization,
  prompt-injection handling at the delimiter/context layer, the
  hallucination prompt contract, safe failure, confirmation, cost,
  and latency. Cases needing a live provider's judgement (real
  hallucination behaviour, live prompt-injection resistance) are
  recorded as blocked, never as passes — no AI quality is claimed
  without that evidence, and no mock result may be quoted as
  live-provider evidence.

## 9a. Realtime architecture (PRD 25, implemented 2026-10-26, M6)

- **Transport: Server-Sent Events over the existing HTTP stack.**
  No WebSocket library, no external broker, no new dependency (per
  AGENTS.md §5). The browser's native `EventSource` opens
  `GET /api/organizations/{id}/projects/{projectId}/realtime/stream`
  with the session cookie; no CORS headers are emitted, so a
  cross-origin page cannot read the stream.
- **Channels are project-scoped.** Subscribing requires the project
  to be visible to the caller (`can_access_current_project`); foreign
  projects are 404, non-members are 403, anonymous connections are
  401 — all before the first event byte.
- **The event log is the transport.** Events are rows in
  `nexora.realtime_events` (migration 0036), published only AFTER the
  mutation transaction commits, with per-project versions assigned
  under the project task-graph lock. The stream polls the log every 2
  seconds and sends heartbeats every 15 seconds; aborting the request
  clears both timers. Because delivery reads the shared database, not
  process memory, every server instance sees the same log and a
  restart loses no events — at polling cost, which is the documented
  trade-off of this design.
- **Reconnection and resynchronization.** EventSource resends the
  last event id automatically; `?since=` is accepted explicitly. A
  fresh client goes live-only; a returning client replays missed
  events up to a 200-event window; a client further behind gets one
  `resync` event and refetches state instead of a flood. The client
  never rewrites page state from events: it shows a refresh notice,
  so no silent overwrite of newer authoritative data is possible.
  The server ends each stream cleanly at 270 s (below Vercel's
  300 s function limit) so the platform never logs a timeout
  error for a healthy stream; the client reconnects on its own
  and replays from its last event id. `NEXORA_REALTIME_STREAM_MAX_MS`
  overrides the limit for tests only.
- **Event set (v1):** `task.created`, `task.updated`,
  `task.deleted` (fired when a task is archived — archiving is this
  codebase's task deletion), `comment.created`, `project.updated`.
  Event data is minimal (ids, titles, names) and never contains
  secrets, bodies, or emails. Connection attempts are rate-limited
  (scope `realtime-connect-user`, 120/hour/user).
- **Notification stream (implemented 2026-10-26, approved
  default):** `notification.created` over SSE on a
  per-organization, per-recipient channel
  (`GET /api/organizations/{id}/notifications/stream`, see
  `src/server/notifications/user-stream.ts`). It is deliberately
  NOT a global per-user stream and NOT on project streams, for
  the recipient-isolation reason in the deployment runbook: the
  notifications table's FORCE RLS policy filters every row to
  recipient + organization + project still accessible. Reconnect
  via last-event-id, `?since_id=`, or `?since=` (ISO timestamp);
  replay up to 200, then one `resync`. Rate limit shares the
  realtime connection scope (120/hour per user).
- **Explicitly NOT built:** production WebSocket connectivity
  (SSE over HTTP is the transport) and
  `presence.changed` is implemented as ephemeral roster state, not
  a log event: an in-process registry
  (`src/server/realtime/presence.ts`) tracks which members hold a
  stream open per project, and the stream's poll loop sends the
  current roster (display names only) whenever it changes. Presence
  events carry no event id, so they never move the client's
  last-event-id cursor. Honest limits: the registry is per-process,
  so on a multi-instance deployment a member connected to another
  instance is absent from this instance's roster; and a dead socket
  lingers until the runtime closes the stream (SSE is
  server-to-client only, so there is no client heartbeat to age
  entries out). Presence is best-effort and never authoritative.
  Multi-instance shared presence is NOT implemented: it would need
  a shared roster store (Redis or a database-backed roster with
  heartbeats), which the current stack deliberately does not add
  (see §3 dependency rule). Until such a store is designed and
  approved, multi-instance deployments must accept per-instance
  rosters, and the event log (already database-shared) remains the
  only cross-instance realtime surface.
  Production WebSocket connectivity is not claimed: this is SSE
  over HTTP. User decision 2026-10-28: SSE is the FINAL realtime
  transport for this product — the PRD's "WebSocket" wording is
  closed as the SSE implementation, not as a future migration;
  a future transport change would need a new decision, not a
  reinterpretation of this section.
- **Observability:** stream connections (live/total), events
  published, and events enqueued to streams are counted in
  `src/server/metrics.ts` and reported by `GET /api/metrics`
  ("delivered" means enqueued, not client-acknowledged — SSE has no
  acknowledgements). Per-request latency histograms and alerting
  remain future work (see §7).

## 9a. File storage abstraction

All file bytes go through `src/server/storage.ts`, never through
the filesystem directly from a route. The provider is chosen by
`NEXORA_STORAGE_PROVIDER` (`local` by default; `s3` for an
S3-compatible store). The local provider is the existing private
directory (`NEXORA_PRIVATE_FILE_DIR`, 0700 directory, 0600 files,
UUID `.blob` keys, O_NOFOLLOW reads, integrity size checks). The
S3 provider is implemented with plain fetch and SigV4 signing
(no object-storage SDK, per §5 of the project rules); object keys
are the same `<uuid>.blob` names, so a migration can copy objects
by key and verify byte counts and hashes before switching the
provider. Presigned download URLs are short-lived (300 seconds,
matching the signed-link TTL) and are issued only after
authorization; the primary download path remains the Nexora route,
which re-checks project/task authorization, file version, and
integrity before reading from any provider. Authorization is never
delegated to the provider or to a presigned URL. S3 is implemented
and unit-tested against a fake HTTP server only — it is NOT
live-verified against a real S3 endpoint, and selecting `s3`
without a complete configuration fails closed instead of silently
falling back to local storage (a silent fallback would split files
across two stores). Switching providers in production is a
copy-then-verify migration (see `docs/deployment.md`), not a flag
flip, because `task_files.storage_key` alone does not record which
provider holds the bytes.

## 9b. Malware scanning

File uploads are scanned synchronously through
`src/server/malware.ts` before their database row is committed.
The default candidate is ClamAV, spoken to over the clamd
INSTREAM protocol with plain `node:net` (no SDK). A configured
scanner reporting clean records `scan_status = 'clean'`; a
signature match records `'quarantined'`; a scanner that cannot be
reached, times out, or answers unparsably is treated exactly like
a signature match — quarantined, never clean. With no scanner
configured, uploads record `'pending'`, which means "not scanned"
and must never be presented as clean. Quarantined bytes and rows
are kept (so an operator can inspect or delete them), but every
download path, including signed links, refuses them with 409
FILE_QUARANTINED. `scripts/rescan-task-files.mjs` (migrator role)
rescans pending and quarantined files once a scanner exists; it
leaves a file unchanged when the scanner is unavailable, and exits
non-zero, rather than rewriting state it did not verify. Live
ClamAV is not verified; the adapter is tested against a fake
clamd only.

Asynchronous mode (implemented locally 2026-10-28, not live):
`NEXORA_MALWARE_SCANNER=github-actions` records uploads as
`pending` and dispatches a scan job to GitHub Actions after the
transaction commits (`src/server/scan-dispatch.ts`); the
workflow downloads the file from a short-lived S3 presigned URL,
scans it with `clamscan`, and reports back to
`POST /api/internal/scan-result`, where a SECURITY DEFINER
function (migration 0064) applies the verdict only while the row
is still `pending` at the dispatched version — clean becomes
clean, infected or error becomes quarantined (fail closed).
Dispatch failure never fails the upload; the daily `scan-retry`
cron re-dispatches pending files older than 1 hour and younger
than 7 days. Async dispatch requires S3 storage (the local
provider has no presigned URLs, so its files stay pending).
Design: `docs/async-scan-github-actions-design.md`. Live
verification (clean + EICAR) is still open; until it passes,
malware protection must not be claimed as operational.

Relay mode (implemented locally 2026-10-28, not live):
`NEXORA_MALWARE_SCANNER=clamav-relay` scans synchronously, like
the TCP `clamav` mode, but through a small HTTPS relay
(`relay/server.mjs`) fronting a clamd on a VPS — the app never
speaks plain TCP to clamd over the internet, and clamd stays on
loopback. The relay authenticates with a bearer token, caps
bodies at 10 MiB, and returns only a verdict; the app requires
`https:` in production, a non-empty token, and (when set) a
base64 PEM CA pin (`NEXORA_CLAMAV_RELAY_CA`) for self-signed
relay certificates. Relay failure is quarantined, never clean;
relay misconfiguration throws and fails the upload loudly.
Setup, firewall rules, and the verification order live in
`relay/README.md`. No migration is involved: relay mode reuses
`scan_status` and the download gate unchanged.

## 9c. Deployment scale decision — stay single-instance (recorded default, 2026-10-28 round 4)

Recorded default decision, reversible by the user at any time:
the deployment stays single-instance. Rationale: the live
deployment is one Vercel project on the Hobby plan serving an
early-production workload; the codebase already documents three
per-process limits that a second instance would break silently
— presence rosters are per-process (§9a), metrics counters are
process-local (§7 of the deployment runbook), and task-file
bytes live in a server-only directory, not shared storage
(§9a file storage). Adding a second instance before fixing
those three would split rosters, split metrics, and strand file
bytes, while adding Redis or shared storage would add cost and
a dependency the current scale does not justify (AGENTS.md §5).
This decision is a default, not a permanent architecture fact:
it does not change any code, and it does not claim the system
scales — it records that multi-instance operation is
deliberately NOT supported until the reversal path below is
done. Reversal path, in order: (1) move task-file bytes to
durable shared storage with the documented copy-then-verify
migration; (2) replace the in-process presence roster with a
database-backed roster with heartbeats (or a Redis design in
this document, approved first); (3) aggregate `/api/metrics`
externally instead of reading one process; (4) only then run
two instances and verify rosters, metrics, and file downloads
across both. Until then, horizontal scaling means a larger
single instance, not more instances.

## 9c-2. Queue and durable-storage decisions (PRD 34, decided 2026-10-28)

- **The queue is PostgreSQL.** There is no separate queue
  store (no Redis, no SQS, no in-process job list). The
  notification-email outbox (`notification_email_outbox`,
  migrations 0040–0043) is the queue: rows are claimed by a
  SECURITY DEFINER function, attempted with backoff, and
  marked failed after 5 attempts. Scheduled jobs are claimed
  the same way in `scheduled_job_runs`. This is consistent
  with the single-instance decision above: one writer, one
  claim function, no distributed coordination to get wrong.
  A separate queue becomes justified only if the reversal
  path in §9c is taken.
- **Durable storage migration is N/A for production.**
  Production never stored file bytes locally: the first
  production files went directly to Backblaze B2 (2026-10-28,
  verified upload/download). There is no local-to-S3 copy to
  run for the deployed app, and no migration is claimed. For
  a self-hosted instance that did store files locally, the
  migration is manual and un-automated: copy each object to
  the new provider, verify bytes, then flip
  `NEXORA_STORAGE_PROVIDER` — the app has no copy command,
  and `scripts/cleanup-task-files.mjs` only reports orphans,
  it does not move them.
- **Provider switch strands objects.** File rows record the
  storage key, not the provider; switching
  `NEXORA_STORAGE_PROVIDER` (or the bucket/endpoint) on a
  live instance without copying the objects first breaks
  every existing download (the new provider has no such
  key). Do not switch providers on an instance with files
  unless the objects have been copied and a download
  re-verified first. This is a documented manual procedure,
  not an automated migration, and the runbook says so.

## 9d. Operational auto-healing (PRD 31, implemented 2026-10-28)

Bounded auto-healing only. The forbidden list is honored by
construction: no healing action modifies source code, database
schema, permissions, security policies, or secrets, and no
self-modifying AI exists. What exists, and where:

- **Healing cron job** (`GET /api/cron/healing`, daily 06:00 UTC
  in `vercel.json`, migration 0051): purges expired sessions
  via `nexora.purge_expired_sessions()`. Expired sessions
  cannot authenticate, so the purge changes no live session.
  One `scheduled_job_runs` row per day (replay on second call,
  retry after failure), token-gated like the other jobs.
  `NEXORA_HEALING_DISABLED=1` records "disabled by operator"
  and purges nothing; any token holder can also trigger the
  job on demand outside the schedule.
- **Transient retries** (pre-existing): the AI provider retries
  once on 429/502/503/504; the notification-email outbox
  retries with backoff and marks a row permanently failed
  after 5 attempts.
- **Queue-job recovery** (pre-existing): a crashed scheduled
  job leaves its claim row `failed`/`in progress`, and the
  next call replaces that claim and reruns instead of
  blocking the day.
- **AI circuit breaker** (`src/server/ai/circuit-breaker.ts`):
  after 5 consecutive HTTP-provider failures the breaker
  opens and AI calls fail fast with 503 `AI_FAILED` for a
  60-second cooldown, then admits one probe (success closes,
  failure reopens). Per-process state, like presence: one
  instance's open breaker does not stop another instance's
  requests, and every instance still fails closed. Openings
  are counted in `GET /api/metrics` (`ai.circuitOpens`) and
  logged as JSON events. `NEXORA_AI_CIRCUIT_BREAKER_DISABLED=1`
  disables it. The mock provider is never wrapped.
- **Graceful degradation** (pre-existing): unconfigured or
  failing AI answers 503 with a controlled UI failure, never
  a fabricated result; the application stays usable without
  AI (PRD 41).
- **Deliberately not built here:** presence cleanup needs no
  job — presence is per-process memory, cleared on stream
  close, and any process (and its roster) dies with Vercel's
  300s stream limit at the latest, so a stale roster entry
  cannot outlive 300 seconds. Storage-object recovery stays
  with `scripts/cleanup-task-files.mjs`, which reports
  orphans; the healing job cannot invent the keys of objects
  whose database rows were already purged. Process restart
  and instance replacement are the platform's job on
  serverless, not application code.

A failed healing run finishes as `failed` in
`scheduled_job_runs` AND rethrows, so the cron route answers
500, metrics count a server error, and the alerts job can
fire on its threshold — that is the alerting-aware property.
Live verification of the healing job needs a deployed run
(manual token-gated trigger works the same day; the
scheduled run follows at 06:00 UTC).

## 10. Environment configuration

All configuration is by environment variable, never by a hardcoded value
or a committed file. The shipped example is `.env.example`; a real
`.env.local` is gitignored and must never be committed.

Required variables (see `API.md` for the full list and `DATABASE.md` for
the two database roles): `DATABASE_URL`, `MIGRATOR_DATABASE_URL`,
`APP_ORIGIN`, `AUTH_RATE_LIMIT_HMAC_KEY` (at least 32 random bytes),
`NEXORA_PRIVATE_FILE_DIR`, `NEXORA_FILE_SIGNING_KEY` (at least 32 bytes),
SMTP settings, and, in production, `NEXORA_TRUSTED_CLIENT_IP_HEADER`.
The deploy procedure, recurring jobs, and pre-launch checklist live in
`docs/deployment.md`.
Missing security configuration fails closed: the app must not start in a
mode that silently disables rate limiting, origin checks, or file signing.

## 11. Error handling

- Client errors: 400 for validation, 401 for authentication required,
  403 for authorization denied, 404 for a resource that does not exist
  or is not visible to the caller (never distinguishing the two where
  that would leak existence), 409 for concurrent updates and idempotency
  conflicts, 413 for oversize payloads, 415 for wrong media type,
  429 for rate limits, 503 for a service that is not configured or is
  unavailable.
- Server errors: a generic 500 with no database detail, and a structured
  server-side log with operation, request ID, and a validated database
  code. Serialization conflicts are the one mapped exception (409).
- Email endpoints return non-enumerating responses: a verification,
  reset, or resend request never reveals whether an account exists.
- File operations distinguish authentication, authorization, invalid
  identifiers or content, size limits, rate limits, stale versions, and
  unavailable storage, without exposing paths or raw content. A staged
  file whose commit outcome is unknown is preserved rather than orphaned
  silently; a known commit rejection rolls back and cleans the staged
  object.

## 12. Security boundaries

- Browser → API: same-origin only, no CORS. Mutations require origin and
  Fetch Metadata checks. JSON is size-bounded.
- API → database: runtime role only, through RLS, with transaction-local
  context. The runtime role cannot own tables, bypass RLS, or hard-delete
  file rows.
- Cron → database: the cron route's only authentication is
  NEXORA_CRON_TOKEN (cron callers are not browsers, so the origin
  check cannot apply). Due-date reminders use one narrow
  exception to the notifications insert policy (migration 0049):
  a self-addressed `due_date` insert is permitted only when the
  transaction flag `nexora.system_job` is exactly `'due-date'`,
  set transaction-locally by the cron route and by nothing else,
  and only for recipients who can work on the project and have
  not disabled `due_date` notifications. No other event, actor,
  or code path can use that policy, and the original policy is
  unchanged for every user-driven insert.
- Migrator → database: schema-owner role only, direct endpoint only,
  advisory-locked, checksum-checked, grants applied in the same run.
- Server → email: SMTP only, with tokens sent once and stored hashed.
- Server → filesystem: private directory only, opaque names, signed
  five-minute download links bound to user, tenant, task, file, and
  version, with membership and integrity rechecked on download.
- Server → future AI provider: provider abstraction only, authorized
  context only, validated structured output only, labelled results only.
- Logs: structured, with request IDs and safe metadata. Never passwords,
  tokens, API keys, secrets, file-link query parameters, or storage keys.

## 13. Testing and deployment approach

- **Tests:** `npm run check` runs lint, typecheck, and tests. Unit and
  schema tests always run. Integration tests (auth, organizations,
  projects, milestones, tasks, comments, files, RLS, search, analytics)
  run only when a disposable test database is configured
  (`NEXORA_TEST_DATABASE_URL` / `NEXORA_TEST_MIGRATOR_DATABASE_URL`) and
  skip otherwise — a skip is an environment fact, not a pass. Database
  tests must never point at a production database.
- **Build:** `npm run build` must pass before any deployment claim. The
  production build is 22 pages plus the API routes and the proxy.
- **Deployment (current, single instance):** `next build` + `next start`,
  with the production database migrated by the migrator (direct endpoint,
  `sslmode=require`), the private file directory on a persistent volume,
  `APP_ORIGIN` set to the production `https:` origin, and the cron
  jobs in `docs/deployment.md` §6 scheduled by the operator.
  Multi-instance, Redis, object storage, and a realtime service
  are future work, not current options.
- **Release gates (met 2026-10-27):** production SMTP verification
  (Nexora mailbox sender, register 202) and trusted ingress
  configuration (`x-vercel-forwarded-for`). **Still open:**
  durable shared storage, backup and recovery verification,
  accessibility acceptance, performance measurement, and
  monitoring (metrics endpoint exists; production alerting needs
  `NEXORA_ALERT_EMAIL` set, and the production cron schedule is
  not yet added). None of these may be claimed from a local check.
