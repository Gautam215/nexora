# Nexora — API

This document defines how Nexora communicates internally and with external
services. It covers the shipped API routes (33 route files), the conventions
every route follows, and the external integrations that exist today. It does
not invent endpoints that do not exist, and it does not describe AI or
realtime endpoints, which are future work.

## 1. Conventions

### 1.1 Base and origin

- All API routes are same-origin, under `/api/`. No `Access-Control-Allow-Origin`
  header is emitted, and cross-origin browser access is not supported.
- The canonical origin is `APP_ORIGIN` (`https:` in production). Email links
  use it. Post-login return paths must be safe same-origin URLs.
- Mutating requests (POST, PUT, PATCH, DELETE) require the same-origin check:
  a configured `APP_ORIGIN`, an `Origin` header, and a `same-origin` Fetch
  Metadata value. GET requests do not require an origin header.

### 1.2 Envelope and headers

- Success: `{data, requestId}`. Error: `{error: {code, message}, requestId}`.
- Every response carries `cache-control: no-store` and `x-request-id`.
  A client-supplied `x-request-id` is accepted only if it matches a safe
  pattern (letters, digits, `.`, `_`, `:`, `-`, at most 80 characters);
  otherwise a fresh UUID is generated.
- JSON request bodies are capped at 16 KB, must declare
  `application/json`, and are validated by a Zod schema before any
  business logic runs. A body that fails validation returns 400 with a
  generic message, not a field-by-field schema dump.
- File uploads do not use the JSON envelope for their bytes; they use the
  dedicated file routes in section 3, with their own headers.

### 1.3 Authentication and authorization

- Authentication is an opaque session cookie (host-only, `HttpOnly`,
  `SameSite=Strict`, `Secure` in production). There is no bearer token,
  no API key, and no client-side token storage.
- Authorization is server-side only, through `withOrganizationContext`
  (tenant operations) or `withUserContext` (personal data), backed by
  row-level security. A route never trusts a role, user ID, or
  organization ID from the request body or query string.
- Unauthenticated requests return 401 `AUTHENTICATION_REQUIRED`.
  Authenticated but unauthorized requests return 403
  `ORGANIZATION_ACCESS_DENIED` (or the route's equivalent). A resource
  that does not exist and a resource the caller cannot see are not
  distinguished where that distinction would leak existence.

### 1.4 Error conventions

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED`, `INVALID_REQUEST` | Input fails validation or is malformed. |
| 401 | `AUTHENTICATION_REQUIRED` | No valid session. |
| 403 | `ORGANIZATION_ACCESS_DENIED` (and route equivalents) | Session is valid, access is denied. |
| 404 | — | Resource not found or not visible to the caller. |
| 409 | `CONCURRENT_UPDATE` | A serialization conflict (`40001`) or an idempotency-key reuse with different content, or a stale version on file replacement. The client should refresh and retry. |
| 413 | `REQUEST_TOO_LARGE` | JSON body over 16 KB, or a file over its size limit. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | JSON endpoint called with a non-JSON content type. |
| 429 | — | Rate limit exceeded (per-user and per-IP scopes). |
| 500 | `INTERNAL_ERROR` | Generic server failure, with no database detail. |
| 503 | `SERVICE_UNAVAILABLE` | A required service (email, rate-limit configuration, database) is not configured or is unavailable. |

Serialization conflicts, email-configuration failures, and rate-limit
configuration failures are the only mapped server errors; everything else
is a generic 500 with a structured server-side log (operation, request ID,
error name, validated database code).

### 1.5 Pagination, filtering, and sorting

- Pagination is server-side and bounded everywhere it exists. The
  workspace search uses `limit` (1–50, default 20) and `offset` (0–10,000,
  default 0). The task list uses the same discipline: filters, sorting,
  and pagination on the server, never a full-table fetch to the client.
- Filters are an allowlist, never free-form SQL. The search route accepts
  only its documented `type` values and a UUID `projectId`; anything else
  is rejected by validation, and the accepted values select only fixed,
  server-owned SQL fragments.
- Sorting is by a fixed set of server-owned keys. A client-supplied sort
  key that is not on the allowlist is rejected, not interpolated.

### 1.6 Idempotency and safe retry

Every mutation falls in exactly one of the retry classes below.
A retry is "safe" when it cannot create a duplicate resource or
apply an effect twice; only the key class replays the original
response, the others fail or converge instead.

- **Idempotency-key creation (replay).** Organization, project,
  task, milestone, comment, and file-upload creation accept an
  `Idempotency-Key` header. A retry with the same key and the
  same payload replays the original result. The same key with
  different content returns 409 `IDEMPOTENCY_KEY_REUSED`. Keys
  expire after 7 days (an expired row is deleted
  so a later retry can create afresh), and must match
  `/^[A-Za-z0-9._:-]{8,128}$/` (invalid → 400
  `IDEMPOTENCY_KEY_REQUIRED`). Organization keys live in
  `organization_creation_idempotency` (migration 0049) and are
  per-actor; project keys live in
  `project_creation_idempotency` (migration 0050) and are
  per-actor per-organization, so the same key and body in a
  different organization creates a second project instead of
  replaying the first; task, milestone, comment, and file keys
  live in `project_mutation_idempotency` and are per-actor
  per-project. Project PATCH also accepts an
  opt-in key (operation `project.update`, migration 0037, fixed
  by 0038); its replay returns the stored project without
  re-auditing, re-notifying, or re-publishing. The key is
  optional on every route above: without it, a retry creates a
  second resource, by design.
- **Version-guarded updates and deletes (conflict, no replay).**
  Task PATCH, milestone PATCH, task delete, and milestone delete
  require `expectedVersion`; bulk task priority updates require a
  per-task `expectedVersion` for every task in the batch; a stale
  version returns 409 and
  nothing is applied. Project delete requires its version plus
  a not-yet-deleted row, so a second delete with the same
  version finds nothing to delete. File replacement uses
  `If-Match` with the current file version instead of a key; a
  stale version returns 409 and the replacement does not happen.
  File delete requires the row to be not-yet-deleted, so a
  second delete fails instead of deleting twice. Comment delete
  requires the row to be not-yet-deleted, so a second delete
  returns 404. Organization
  delete requires status `active` and invitation revoke
  requires a pending invitation, so a second call returns 404
  instead of deleting twice.
- **Conflict-safe creation (no duplicate, no replay).**
  Organization invitation creation is guarded by the pending
  invitation constraint: a retry after success returns 409
  `INVITATION_PENDING` and creates no second invitation and
  sends no second email; it does not return the original
  invitation — list invitations to recover it. Project member
  addition uses `ON CONFLICT DO NOTHING`: a retry returns 409
  `PROJECT_MEMBER_EXISTS` with no duplicate row and no
  duplicate notification.
- **Final-state idempotent (converges, no replay).**
  Organization settings PATCH writes an audit event only when
  a field actually changed, so an identical retry changes no
  state and audits nothing new. Member role PATCH, notification
  read/unread PATCH, and notification preferences PATCH
  converge to the same end state on retry. Workflow PUT is a
  full replacement of the status set: a retry with the same
  payload converges to the same set.
- **Single-use token (second use fails, no duplicate).**
  Invitation accept consumes its token: a second accept returns
  400 `INVALID_INVITATION` and creates no second membership.
  Session revoke of an already-revoked session returns 404
  `SESSION_NOT_FOUND`; logout and revoke-others converge
  (repeating them revokes nothing new). Password change
  verifies the current password, so a retry after success
  fails 401 because the old password no longer matches.
  Register with an already-registered
  email returns the same generic 202 and creates no second
  account (anti-enumeration). Password-reset and verification
  resend issue a fresh single-use token per request; a retry
  creates no duplicate account or session, but it may issue an
  additional token, which is by design for delivery retries.
  Account deletion requires the account email as typed
  confirmation plus the current password (2026-10-28 security
  round); after success the session is revoked, so a
  retry returns 401 and deletes nothing twice.
- **Generate-only AI routes (no resource, no key).** AI
  planning/extraction/summarize/meeting-summary/risk/assistant generation
  creates no user-visible resource — only an execution record —
  so there is nothing to replay; a retry runs the provider
  again and records a second execution. The confirm endpoints
  that do create milestones or tasks from a draft are
  key-covered above.
- **Background jobs (daily claim, not a key).** Scheduled jobs
  are idempotent by a different mechanism: one claimed row per
  job per day in `nexora.scheduled_job_runs` (see §2.8). A
  repeated call the same day replays the first run's result.
- **No key and no guard — none remaining.** Every mutation
  route in §2 is covered by one of the classes above; a route
  added later must state its class in this section in the same
  change, or it ships without a retry story.

### 1.7 API evolution

- Changes to this API are backward-compatible by default: additive
  fields, new optional query parameters, and new routes do not break
  existing clients. A change that removes or renames a field, changes
  a response shape, or tightens validation so previously accepted
  requests fail is a breaking change.
- A breaking change is never shipped silently. It requires a new
  versioned route (the old route keeps serving), a dated deprecation
  notice in this document naming the old route and its removal date,
  and a removal only after that date has passed. No client is broken
  without a documented migration path.
- This policy is a documentation commitment, not a versioning
  implementation: no versioned routes exist yet, because no breaking
  change has been made. When the first one is needed, the versioned
  route and its deprecation notice ship in the same change.

## 2. Endpoints

Methods and purposes are listed; request and response shapes follow the
conventions above and the Zod schemas in `src/security/`, which are
authoritative for field-level detail. A route not listed here does not
exist.

### 2.1 Health (new in this change)

| Method and path | Purpose | Auth |
| --- | --- | --- |
| GET `/api/health` | Liveness check. Returns the process status and the database state (`up`, `unavailable`, or `unconfigured`) without secrets, versions, or database detail. Always returns 200 for a live process; the `database` field, not the status code, reports database state, so that a Neon scale-to-zero wake-up does not flap a liveness probe. | None. A health probe cannot authenticate. |
| GET `/api/ready` | Readiness check. Returns 200 with `{ ready: true }` only when the database probe succeeds, 503 otherwise, so a load balancer can hold traffic until the process can actually serve. No detail beyond the boolean. | None. A readiness probe cannot authenticate. |
| GET `/api/metrics` | Operator metrics: uptime, request counts by status class and normalized path, failures by operation, timed database probe latency, pool counters, realtime counters (live/total stream connections, events published, events enqueued to streams), and AI circuit-breaker openings (`ai.circuitOpens`). Paths are normalized (UUID/numeric segments become `:id`) and query strings are never recorded; no user data or credential is ever reported. Counters are process-local. "Delivered" means enqueued to a stream controller, not client-acknowledged (SSE has no acknowledgements). Fails closed with 503 when `NEXORA_METRICS_TOKEN` is unset. Every call consumes the DB-backed per-IP rate limit (scope `operator-metrics`, 120/hour, migration 0063); beyond it → 429, and a missing/invalid trusted-IP header in production → 503. Failed authentications are logged as `operator.auth_failed` events (endpoint only, never the token). Since migration 0066 the app role can no longer execute the aggregate functions directly: `queryOperatorAggregates()` runs them through a separate operator pool (`NEXORA_OPERATOR_DATABASE_URL`; when unset the `operator` block is null, the same degrade as before 0061). Five failed tokens from one IP lock that IP out for 15 minutes (scope `operator-metrics-lockout`, migration 0066; even the correct token returns 429 while locked), and ten failed tokens in an hour across all IPs send exactly one alert email to `NEXORA_ALERT_EMAIL` via the existing alert state and mailer, suppressed for an hour afterwards (2026-10-29 operator-controls round, live since push 16). The `operator` block adds database-backed aggregates (migration 0061; null until that migration is applied): AI execution counts by status, prompt/completion token totals all-time and trailing 30 days, average AI latency, per-workflow counts, email-outbox rows by status (queue depth), and scheduled-job failures plus the last run per job over the trailing 7 days. | Shared token in the `x-nexora-metrics-token` header, compared in constant time. Not a user session. |

### 2.1a AI (new in this change)

| Method and path | Purpose | Auth |
| --- | --- | --- |
| POST `/api/organizations/{organizationId}/ai/summarize` | Authorized summary of one project, from tasks, milestones, activity, and comments the caller can access. Read-only. Optional `scope` selects the focus: `project` (default, all sections), `tasks`, `comments`, `activity`, or `milestones`; the context is always the same authorized project context, so a scope is a focus instruction, not a context filter. Returns `{ summary, aiGenerated: true, executionId, scope }`. Fails closed with 503 `AI_UNAVAILABLE` when no provider is configured, and 503 `AI_FAILED` on provider/timeout/invalid-output failure. Rate limits: 60/hour per user, 120/hour per organization. | Signed-in active organization member; project must be visible to the caller (`can_access_current_project`), else 404 `PROJECT_NOT_FOUND`. |
| POST `/api/organizations/{organizationId}/ai/summarize-meeting` | Authorized free-text summary of meeting notes supplied by the caller (a meeting has no project record, so notes travel as the untrusted-data block of the prompt, never as instructions). Read-only. Returns `{ summary, aiGenerated: true, executionId }`. Fails closed with 503 `AI_UNAVAILABLE` when no provider is configured, and 503 `AI_FAILED` on provider/timeout/invalid-output failure. Rate limits: 60/hour per user, 120/hour per organization. | Signed-in active organization member; non-members → 403 `ORGANIZATION_ACCESS_DENIED`. |
| GET `/api/organizations/{organizationId}/ai/executions` | The caller's own AI execution records in this organization, newest first, at most 50. Metadata only (workflow, provider, model, status, tokens, latency, error); prompts and responses are never stored. | Signed-in active organization member; RLS restricts rows to the caller. |
| POST `/api/organizations/{organizationId}/ai/planning/generate` | Generates a structured plan draft from a goal (milestones, tasks, subtasks, dependencies by task title). Creates NOTHING; the draft is returned for review. Fails closed with 503 `AI_UNAVAILABLE` when no provider is configured, 503 `AI_FAILED` on provider/invalid-output failure. Rate limits: 60/hour per user, 120/hour per organization. | Signed-in active organization member. |
| POST `/api/organizations/{organizationId}/ai/planning/confirm` | Creates the project, milestones, tasks, subtasks, and dependency edges from a reviewed draft, in ONE transaction. Dependency titles must match exactly one task title (unknown → 400 `PLANNING_DEPENDENCY_UNKNOWN`, ambiguous → 400 `PLANNING_DEPENDENCY_AMBIGUOUS`, cycle → 409 `TASK_DEPENDENCY_CYCLE`), and every dependency is validated BEFORE any insert, so a rejected plan creates nothing. Requires an `idempotency-key` header (8–128 chars, `[A-Za-z0-9._:-]`); a replay with the same key and body returns the original project (201), a reused key with a different body → 409 `IDEMPOTENCY_KEY_REUSED`. Keys are organization-level (the project does not exist yet at confirm time) and expire after 7 days. Rate limit: 40/hour per user (`project-management-user`). | Signed-in active organization member; project owner is the caller, who becomes its manager. |
| POST `/api/organizations/{organizationId}/ai/extraction/generate` | Generates a structured extraction draft from meeting notes (tasks with owner/deadline as TEXT, decisions, follow-ups, risks). Creates NOTHING. Notes travel as the untrusted-data block of the prompt, never as instructions. Fails closed with 503 `AI_UNAVAILABLE` when no provider is configured, 503 `AI_FAILED` on provider/invalid-output failure. Rate limits: 60/hour per user, 120/hour per organization. | Signed-in active organization member. |
| POST `/api/organizations/{organizationId}/projects/{projectId}/ai/extraction/confirm` | Creates the reviewed draft's tasks in the existing project, in ONE transaction. Extracted owners are names, never resolved to user ids (recorded as "Suggested owner" lines); a deadline becomes a `due_date` only when it is a real ISO calendar date, otherwise it stays a "Suggested deadline" line — no date or assignee is invented. Decisions, follow-ups, and risks are informational: echoed in the response and shown in the UI, but not persisted as separate records (there is no project-level record type for them). Requires an `idempotency-key` header; the project id is part of the request hash, so the same key for a different project conflicts (409 `IDEMPOTENCY_KEY_REUSED`) instead of replaying the wrong project. Keys expire after 7 days. Rate limit: 40/hour per user (`project-management-user`). | Signed-in active organization member who can work in the project (viewers → 403); invisible/foreign project → 404 `PROJECT_NOT_FOUND`; closed project → 409 `PROJECT_CLOSED`. |
| POST `/api/organizations/{organizationId}/ai/risk` | Read-only risk analysis of one project (delays, blockers, dependency risks, overdue work, workload/schedule pressure). Returns `{ risks: [{ title, detail, severity }], aiGenerated: true, executionId }`. Every finding is a possibility, never a confirmed fact. Fails closed with 503 `AI_UNAVAILABLE` when no provider is configured, 503 `AI_FAILED` on provider/invalid-output failure. Rate limits: 60/hour per user, 120/hour per organization. | Signed-in active organization member; project must be visible to the caller (`can_access_current_project`), else 404 `PROJECT_NOT_FOUND`. |
| POST `/api/organizations/{organizationId}/ai/assistant` | Read-only question answering over one project. Authorization runs BEFORE retrieval: an invisible project returns 404 and the provider never sees its data, and the whole tenant is never retrieved for the model to filter. Returns `{ answer, aiGenerated: true, executionId }`. Fails closed with 503 `AI_UNAVAILABLE` / 503 `AI_FAILED` as above. Rate limits: 60/hour per user, 120/hour per organization. | Signed-in active organization member; project must be visible to the caller, else 404 `PROJECT_NOT_FOUND`. |

### 2.1b Realtime (new in this change)

| Method and path | Purpose | Auth |
| --- | --- | --- |
| GET `/api/organizations/{organizationId}/projects/{projectId}/realtime/stream` | Server-Sent Events stream for one project. First sends `hello` (`{ projectId, latestVersion }`), then replays missed events (up to 200) for a returning client, or one `resync` event (`{ projectId, latestVersion }`) when the client is further behind. Events carry `id` (UUID, used by EventSource for reconnection), `event` (one of `task.created`, `task.updated`, `task.deleted`, `comment.created`, `project.updated`), and JSON `data` (ids/titles/names plus `version` and `projectId`; never secrets, bodies, or emails). `task.deleted` fires when a task is archived. Reconnection: EventSource resends the last event id automatically; `?since=` is also accepted. A fresh client (no last seen version) receives live events only. Heartbeat comments every 15 seconds; the log is polled every 2 seconds. The server ends the stream cleanly at 270 seconds (below the platform 300-second limit); the client reconnects automatically and replays from its last event id. The same stream also sends `presence.changed` (`{ projectId, online: [{ userId, displayName }] }`, no `id` — ephemeral roster state, not a log event) after `hello` and whenever the roster changes; the roster is per-process, so members connected to another instance are absent, and a dead socket lingers until the runtime closes the stream. Rate limit: 120/hour per user (`realtime-connect-user`). | Session cookie (EventSource sends cookies same-origin; no CORS headers are emitted). Project must be visible to the caller (`can_access_current_project`), else 404 `PROJECT_NOT_FOUND`; non-members → 403; anonymous → 401. |

### 2.2 Authentication

| Method and path | Purpose | Auth |
| --- | --- | --- |
| POST `/api/auth/register` | Create an account, hash the password with scrypt, and start email verification. Non-enumerating response. | None |
| POST `/api/auth/login` | Verify credentials, apply rate limits, and issue an opaque session cookie. Generic `INVALID_CREDENTIALS` on failure. | None |
| POST `/api/auth/logout` | Revoke the current session. | Session |
| GET `/api/auth/session` | Return the authenticated user's id, email, display name, verification time, and creation time. | Session |
| POST `/api/auth/password-change` | Change the logged-in user's password: verify the current password (existing scrypt), set the new password (12–128 policy), rate-limit 5/hour per email and 30/hour per IP, and revoke all other sessions in the same transaction, keeping the current session. | Session |
| GET `/api/auth/sessions` | List the authenticated user's active sessions (id, created, last seen, expiry, `current` flag only; never a token or token hash). Expired and revoked sessions are excluded. | Session |
| POST `/api/auth/sessions/revoke` | Revoke one own session by id. Not-found, already-revoked, expired, and another user's session all return the same 404. Revoking the current session clears its cookie. | Session |
| POST `/api/auth/sessions/revoke-others` | Revoke all of the authenticated user's sessions except the current one, returning the count. | Session |
| GET `/api/account/export` | Export the caller's own data across all workspaces as one JSON document: profile, workspace memberships, projects, tasks created and assigned, comments authored, file metadata (no storage key, no download link), AI execution metadata (prompts and responses are never stored), and notification counts. Rate-limited (40 per user per hour, 80 per IP per hour, scope `account-export-user`). | Session |
| DELETE `/api/account` | Delete the caller's own account (PRD 27/28). Body `{ confirmation, password }` must repeat the account's email as typed confirmation AND carry the current password (destructive-action re-entry, 2026-10-28 security round); a password mismatch returns 401 `INVALID_CREDENTIALS`, an email mismatch returns 409 `ACCOUNT_EMAIL_MISMATCH`. The account is scrubbed, not hard-deleted: the user row is anonymized (email replaced by a unique `deleted-` address, display name neutralized, password replaced by a random value, status suspended, `deleted_at` stamped), every workspace membership is disabled, sessions and auth tokens are deleted, tasks assigned to the user are unassigned, and one `account.deleted` audit row is written per active workspace. A sole-owner active workspace blocks deletion with 409 `ACCOUNT_SOLE_OWNER` naming the workspace slugs; the app has no ownership-transfer route, so such a workspace must be deleted first. After success the session cookie is cleared. Rate-limited (5 per user per hour, 30 per IP per hour, scope `account-deletion-user`). When the caller has a verified authenticator, the body must also carry `totpCode` (6 digits); a missing or wrong code returns 401 `INVALID_CREDENTIALS`, and unenrolled callers proceed on password alone (2026-10-29 authenticator round, live since push 16). | Session |
| POST `/api/account/totp/setup` | Start authenticator enrollment: generate a fresh secret, store only its AES-256-GCM ciphertext (key from `NEXORA_TOTP_ENCRYPTION_KEY`, 64 hex chars; unset or malformed key → 503), and return the manual setup key plus the otpauth:// URL once, plus a server-rendered QR SVG (`qrSvg`) of the same URL (if QR rendering fails, the response omits `qrSvg` and enrollment still proceeds via the manual key). The account page first asks which app the user will use (Google or Microsoft Authenticator), then shows the QR first with the manual key as fallback; the choice only changes the on-screen instructions, since both apps read the same standard otpauth URL. The row stays pending (`verified_at` NULL) until proven, so an abandoned setup never gates deletion. When the caller already has a verified authenticator, the body must carry the current code (`{ code }`); a missing code is rejected (400, or 415 with no JSON body) and a wrong code is a 401, so re-enrollment cannot silently strip the second factor — enrolled callers who lost the authenticator re-enroll via disable followed by a fresh setup. Rate-limited (10 per user per hour, 30 per IP per hour, scope `totp-verify-user`). | Session |
| POST `/api/account/totp/verify` | Prove authenticator possession: body `{ code }` (6 digits) must match the pending secret within ±1 time step (30 s steps, SHA-1). Success sets `verified_at` and returns `{ enabled: true }`; a second verify returns 409 `TOTP_NOT_PENDING`, a wrong code 401. Same rate limit as setup. | Session |
| POST `/api/account/totp/disable` | Remove the caller's authenticator: body `{ password, code }` — the current password plus a current code; a wrong code returns 401, an unenrolled caller 409 `TOTP_NOT_ENABLED`. Same rate limit as setup. | Session |
| GET `/api/account/totp/status` | Return `{ enrolled }` for the caller (true only for a verified row). Read-only; the UI uses it to decide whether deletion dialogs ask for a code. | Session |

**Session rotation on privilege change (approved default, 2026-10-26, migration 0039).** No periodic rotation. PATCH on an organization member revokes all of that member's sessions (count in `sessionsRevoked`, also in the `membership.updated` audit details) when the new status is not active or the new role ranks below the previous role (owner > admin > member > guest); promotion and re-enable do not revoke. PATCH on a project member revokes only when the new status is not active; a project role-only change does not revoke, because project authorization is re-checked on every request. Password change revokes all other sessions and keeps the current session; password reset revokes all sessions.
| POST `/api/auth/verification/consume` | Consume a single-use verification token. | None (token) |
| POST `/api/auth/verification/resend` (resend-verification page route) | Re-issue a verification link. Non-enumerating response. | None |
| POST `/api/auth/password-reset/request` | Issue a single-use reset token. Non-enumerating response. | None |
| POST `/api/auth/password-reset/complete` | Consume a reset token and set a new password (12–128 policy); revokes all sessions. | None (token) |

Authentication is email + password only (see 2.2a for the removed
Google OAuth). Logged-in password change, active-session listing,
and revoke-all are implemented (see the table above).

### 2.2a OAuth — REMOVED 2026-10-26 (email + password only)

Google OAuth (`POST /api/auth/oauth/google/start`, `POST
/api/auth/oauth/google/link/start`, `GET
/api/auth/oauth/google/callback`) was implemented in migration
0032 and removed by user decision on 2026-10-26: email + password
is now the only sign-in path. Append-only migration 0047 drops
the `oauth_identities` table and the `lookup_oauth_identity`
function and removes the `oauth-start` / `oauth-callback`
rate-limit scopes. The routes, provider code, sign-in button,
and account-link section were deleted with the removal. No
OAuth endpoints exist anymore; requests to the old paths 404.

### 2.3 Organizations and invitations

| Method and path | Purpose | Auth and role |
| --- | --- | --- |
| GET `/api/organizations` | List the caller's organizations. | Session, active membership |
| POST `/api/organizations` | Create an organization; the creator becomes its owner member transactionally, with an audit record. Accepts `Idempotency-Key` (see §1.6). | Session |
| GET `/api/organizations/{organizationId}` | Organization detail. | Session, active membership |
| PATCH `/api/organizations/{organizationId}` | Update organization name and/or slug, with the same validation as creation, and optionally `storageQuotaBytes` (positive integer up to 1 TiB, or `null` to clear the quota). Slug conflicts return 409 `SLUG_TAKEN`; a change writes an `organization.updated` audit record with previous and new values. A save with no changes succeeds and writes no audit row. Rate-limited (40 per user per hour, 80 per IP per hour, scope `organization-settings-user`). The response includes `storage_quota_bytes` and `storage_usage_bytes` (active file bytes across the workspace); GET returns the same two fields. NULL quota means no organization cap — per-task caps (20 files, 100 MB) still apply. Uploads and replacements over the quota return 409 `ORGANIZATION_STORAGE_LIMIT`. | Session, owner or admin |
| DELETE `/api/organizations/{organizationId}` | Soft-delete the organization (see below). Body `{ slug, password }` must repeat the workspace's current slug as explicit confirmation AND carry the owner's current password (destructive-action re-entry, 2026-10-28 security round); a password mismatch returns 401 `INVALID_CREDENTIALS`, a slug mismatch returns 409 `ORGANIZATION_SLUG_MISMATCH`. Writes an `organization.deleted` audit record. Rate-limited (40 per user per hour, 80 per IP per hour, scope `organization-deletion-user`). When the owner has a verified authenticator, the body must also carry `totpCode` (6 digits); a missing or wrong code returns 401 `INVALID_CREDENTIALS` (2026-10-29 authenticator round, live since push 16). | Session, owner only |
| GET `/api/organizations/{organizationId}/usage` | Organization usage and cost tracking (PRD 40): storage bytes, active file count, and storage quota, plus per-workflow AI token usage (executions, prompt tokens, completion tokens) over succeeded executions, for all time and for the last 30 days. Read-only. | Session, owner or admin only (other members → 403 `ORGANIZATION_MANAGEMENT_REQUIRED`; non-members → 403 via the organization context). |
| GET/POST `/api/organizations/{organizationId}/invitations` (and accept/revoke routes under `/api/invitations/`) | Create, accept, and revoke invitations. Acceptance requires an active, email-verified account matching the invited address, is single-use, and records membership and audit data transactionally. Replay is rejected. | Session; manager roles for create/revoke; invited user for accept |
| GET `/api/organizations/{organizationId}/members`, PATCH `/api/organizations/{organizationId}/members/{userId}` | List organization members; change a member's role or status (see session rotation in 2.2). | Session, active membership; manager roles for PATCH |
| DELETE `/api/organizations/{organizationId}/members/{userId}` | Remove a member (PRD 6), or leave on your own. Removal is not a hard delete: the membership row is disabled (history anchors to it with RESTRICT keys), the member's tasks in the workspace become unassigned, their notification preferences and pending invitations are deleted, and their sessions are revoked when someone else removes them (a voluntary leave keeps the leaver's sessions; the disabled membership denies org access alone). Owners cannot be removed by anyone else; a sole owner leaving returns 409 `LAST_OWNER`. Re-removal is an idempotent 200. Writes a `membership.removed` audit record. Rate-limited (50 per user per hour, 80 per IP per hour, scope `organization-invite-user`). | Session, active membership; owner/admin for others, self for leave |
| POST `/api/organizations/{organizationId}/projects/{projectId}/members`, PATCH `…/members/{userId}` | Add a project member; change a project member's role or status (status change revokes sessions; role-only change does not). | Session, project-management authority |
| DELETE `/api/organizations/{organizationId}/invitations/{invitationId}` | Revoke a pending invitation. | Session, manager roles |
| PATCH `/api/organizations/{organizationId}/notifications/{notificationId}` | Mark one notification read or unread (recipient only). | Session, recipient |
| PATCH `/api/organizations/{organizationId}/projects/{projectId}/tasks/bulk` | Safe bulk priority update for versioned tasks. | Session, work authority |
| PUT `/api/organizations/{organizationId}/projects/{projectId}/tasks/workflow` | Replace the project's configurable task workflow (requires one completion column and unique names). | Session, project-management authority |
| POST `/api/invitations/accept` | Accept an organization invitation with its single-use token; creates the membership. A second accept returns 400 `INVALID_INVITATION` and creates no second membership. | Session (any signed-in user) + valid invitation token |
| GET `/api/organizations/{organizationId}/notifications` | List the caller's own notifications in the organization, newest first. | Session, organization member (recipient-scoped) |
| GET `/api/organizations/{organizationId}/projects` | List the projects visible to the caller in the organization. | Session, organization member |
| POST `/api/organizations/{organizationId}/projects` | Create a project; the caller becomes its manager. | Session, organization member |
| GET `/api/organizations/{organizationId}/projects/{projectId}` | Get one project. | Session, project visible to caller else 404 `PROJECT_NOT_FOUND` |
| PATCH `/api/organizations/{organizationId}/projects/{projectId}` | Update project attributes; opt-in idempotency key supported. | Session, project-management authority |
| DELETE `/api/organizations/{organizationId}/projects/{projectId}` | Soft-delete a project (version-guarded; immediate invisibility, purge after 30 days). | Session, project-management authority |
| GET `/api/organizations/{organizationId}/projects/{projectId}/activity` | Project activity feed (audit-backed). | Session, project visible to caller else 404 `PROJECT_NOT_FOUND` |
| GET `/api/organizations/{organizationId}/projects/{projectId}/analytics` | Calculated project analytics (progress, overdue work, workload, milestone progress, health). | Session, project visible to caller else 404 `PROJECT_NOT_FOUND` |
| PATCH `/api/organizations/{organizationId}/projects/{projectId}/members/{userId}` | Change a project member's role or status (status change revokes sessions; the project owner cannot be changed here). | Session, project-management authority |
| GET `/api/organizations/{organizationId}/projects/{projectId}/milestones` | List the project's milestones. | Session, project visible to caller else 404 `PROJECT_NOT_FOUND` |
| POST `/api/organizations/{organizationId}/projects/{projectId}/milestones` | Create a milestone. | Session, project-management authority |
| GET `/api/organizations/{organizationId}/projects/{projectId}/milestones/{milestoneId}` | Get one milestone. | Session, project visible to caller else 404 `MILESTONE_NOT_FOUND` |
| PATCH `/api/organizations/{organizationId}/projects/{projectId}/milestones/{milestoneId}` | Update a milestone (version-guarded). | Session, project-management authority |
| DELETE `/api/organizations/{organizationId}/projects/{projectId}/milestones/{milestoneId}` | Delete a milestone (version-guarded). | Session, project-management authority |
| GET `/api/organizations/{organizationId}/projects/{projectId}/tasks` | List the project's tasks. | Session, project visible to caller else 404 `PROJECT_NOT_FOUND` |
| POST `/api/organizations/{organizationId}/projects/{projectId}/tasks` | Create a task. | Session, work authority |
| GET `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}` | Get one task. | Session, project visible to caller else 404 `TASK_NOT_FOUND` |
| PATCH `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}` | Update a task (version-guarded). | Session, work authority |
| DELETE `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}` | Delete a task (version-guarded). | Session, work authority |
| GET `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}/comments` | List a task's comments. | Session, project visible to caller else 404 `TASK_NOT_FOUND` |
| POST `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}/comments` | Add a comment to a task. | Session, work authority |
| GET `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}/files` | List a task's active files (metadata only, never content or storage keys). | Session, project visible to caller else 404 `TASK_NOT_FOUND` |
| POST `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}/files` | Upload a file to a task (bounded size/type/content checks, quota-enforced, idempotency key supported). | Session, work authority |

### 2.4 Projects, milestones, tasks, comments

All routes below are nested under
`/api/organizations/{organizationId}/projects/{projectId}/…` and require
an active organization membership plus project visibility, enforced by
`withOrganizationContext` and RLS. Project roles are `manager`, `member`,
`viewer`; organization managers retain project-management authority.

| Resource | Operations |
| --- | --- |
| Projects | Create, read, update (with optimistic `version`), delete (soft delete, see below), lifecycle transitions (Planned, Active, On Hold, Completed, Archived), membership management, activity feed. |
| Milestones | Create, list, update, status transitions, task association and progress, dependency creation with cycle checks, delete (soft delete with optimistic `expectedVersion`, `milestone.deleted` audit, immediate invisibility across lists, detail, dependencies, task reads, analytics, and activity; 30-day purge detaches tasks and deletes dependency rows, audit retained). Deletion requires project-management authority and is rejected with 409 `PROJECT_CLOSED` in completed or archived projects. |
| Tasks | Create, read, update, archive, assign/reassign, status change through the project's configurable workflow, priority change (including safe bulk priority updates), labels, effort, subtasks, dependencies with cycle checks, and activity. |
| Comments | Append-only creation on a task, with mention extraction, plus soft-delete: the comment's author or a project manager may delete it (DELETE on one comment), which stamps `deleted_at` and hides it from the list and workspace search while the row, its mentions, and its `comment.created` event history stay as the audit trail; a `comment.deleted` audit record is written. There is no comment edit endpoint. |
| Activity | Project activity feed, backed by audit events, most recent first. |
| Analytics | GET `…/projects/{projectId}/analytics` — calculated progress, completion, overdue work, workload (including unassigned), milestone progress, recent activity (trailing seven days, at most five events), upcoming deadlines (at most eight), and rule-based health with its reason. No AI insight, no capacity percentage. |

Route methods, verified against the route files: projects `GET / POST` (collection) and `GET / PATCH / DELETE` (one); milestones `GET / POST` and `GET / PATCH / DELETE`; tasks `GET / POST` and `GET / PATCH / DELETE` (DELETE archives); comments `GET / POST` and `DELETE` (one, soft-delete); activity `GET`; analytics `GET`; realtime stream `GET`; files `GET / POST` and `GET / PUT / DELETE`. There is no task, milestone, or comment edit-after-create beyond PATCH, and no comment edit endpoint.

**Project update idempotency (opt-in).** PATCH `…/projects/{projectId}`
accepts an optional `idempotency-key` header (same 8–128 character
pattern as the creation routes). With a key, the update records its
result in `project_mutation_idempotency` (operation `project.update`,
migrations 0037–0038): a retry with the same key and body replays the stored
project instead of failing on the now-stale `expectedVersion`, and the
same key with a different body returns 409 `IDEMPOTENCY_KEY_REUSED`.
A replay does not re-audit, re-notify, or re-publish the realtime
event. Without a key, PATCH behaves exactly as before; a present but
malformed key returns 400 `IDEMPOTENCY_KEY_REQUIRED`.

**Project deletion.** DELETE `…/projects/{projectId}` with body `{ expectedVersion }`
(the project's current optimistic version, same bounds as update) soft-deletes
the project: it sets `deleted_at` and `deleted_by_user_id` and writes a
`project.deleted` audit event. Only project managers, the project owner, and
organization owners/admins may delete, following the existing authorization
model (organization admins inherit manager authority exactly as with PATCH);
viewers and non-members are denied, and non-project-members and cross-tenant
callers receive 404 `PROJECT_NOT_FOUND` rather than 403, so the endpoint
never leaks a project's existence. A stale `expectedVersion` returns 409
`VERSION_CONFLICT`; a second delete returns 404. The delete runs under the
project lifecycle lock, shares PATCH's rate limit (`project-management-user`),
and sends no project-member notification. A deleted project is immediately
invisible to everyone: it disappears from the project list, search (all
entity types), analytics, activity, milestones, tasks, comments, files
(including previously issued signed download links, which return 404), and
notification lists and unread counts. There is no recovery UI. After 30 days
the retention cleanup (see `DATABASE.md`) permanently purges the project and
its tasks, milestones, comments, files, notifications, and memberships, in
foreign-key order; audit events are retained indefinitely. The UI confirms
deletion in a danger zone on the project page (see `DESIGN.md`) and returns
to the organization page, where the project is absent from the list.

**Organization deletion.** DELETE `/api/organizations/{organizationId}`
with body `{ slug }` soft-deletes the organization: it sets
`status = 'deletion_pending'`, `deleted_at`, and `deleted_by_user_id` and
writes an `organization.deleted` audit event. Only the organization owner
may delete — admins are denied with 403
`ORGANIZATION_MANAGEMENT_REQUIRED`, and non-members with 403
`ORGANIZATION_ACCESS_DENIED`. The slug confirmation must match exactly;
a mismatch returns 409 `ORGANIZATION_SLUG_MISMATCH`, and a second delete
returns 404. A deleted organization is immediately invisible to everyone:
`withOrganizationContext` rejects non-active organizations, so project
lists, search, notifications, activity, members, tasks, and files under
it all return 404 `ORGANIZATION_NOT_FOUND`, and the organization list
excludes it. There is no recovery UI. After 30 days the retention
cleanup (see `DATABASE.md`) permanently purges the organization's
projects, tasks, comments, files, invitations, notification preferences,
and memberships, in foreign-key order, and removes purged files from
disk; notifications cascade from their projects. Audit events are
retained indefinitely, so the organization row itself is never
hard-deleted: it remains as a tombstone (id, slug, deletion metadata,
`purged_at`), which also keeps its slug reserved against re-registration.
The UI confirms deletion in a danger zone on the organization page that
requires typing the workspace address, and returns to the workspaces
list.

### 2.5 Search

| Method and path | Purpose |
| --- | --- |
| GET `/api/organizations/{organizationId}/search` | Authorized, tenant-aware, permission-aware search over visible projects, active tasks, comments, active organization members, and active file names. Query `q` (2–120 characters), `type` (`all`, `project`, `task`, `comment`, `member`, `file`), optional UUID `projectId`, `limit`, `offset`. Rate-limited (60 per user per hour, 120 per IP per hour). Results contain only a display title, a short preview, and an in-app destination. Member results never include email addresses; file results never include file content or storage keys. Archived tasks, archived-task comments, and deleted files are excluded. |

### 2.6 Notifications

| Method and path | Purpose |
| --- | --- |
| GET (notification list) and update (read/unread) under the organization/project routes | Recipient-scoped in-app notifications, with preferences. Emitters cover mentions, task assignment, and task/project/milestone changes and membership. Due-date and AI events do not exist yet as emitters. |
| GET/PATCH `/api/organizations/{organizationId}/notifications/preferences` | Per-event in-app preference (`inAppEnabled`, default true) and email preference (`emailEnabled`, default false, optional in PATCH — omitting it leaves the stored email preference unchanged). Email only takes effect when the operator also configured the event type (see below). |
| GET `/api/organizations/{organizationId}/notifications/stream` | Per-organization, per-recipient SSE stream for `notification.created` only. Session cookie, no CORS; active organization membership required (non-member 403, deleted organization 404). Every row is filtered by the notifications table's FORCE RLS policy (recipient = caller, organization = current, project still accessible), so another user's notifications are never visible, even by guessing an id. First sends `hello` (`{ organizationId, latestCreatedAt }`), then replays missed notifications up to 200 for a returning client (last-event-id, `?since_id=`, or `?since=` ISO timestamp), or one `resync` event when further behind; a fresh client goes live-only. Heartbeat every 15 seconds, poll every 2 seconds. Event data is the recipient's own notification (`id`, `organizationId`, `projectId`, `eventType`, `title`, `body`, `href`, `createdAt`). Rate limit shares the realtime connection scope (120/hour per user). |
| Notification email worker (no HTTP route) | Transactional outbox (migrations 0040–0043) + worker `npm run notifications:email-worker` (run every minute, `--limit` 1–100, default 20). The outbox row is written in the same transaction as the in-app notification; the worker claims (FOR UPDATE SKIP LOCKED), sends via SMTP, and marks sent/failed (backoff 5 minutes per attempt, failed after 5 attempts, stuck `processing` rows reset after 30 minutes). Policy is off by default: operator lists event types in `NEXORA_NOTIFICATION_EMAIL_TYPES`, and the recipient must enable email for that type. The worker fails closed when SMTP is unconfigured and leaves rows pending; it never marks a row sent without sending. |

### 2.7 Private task files

Base path:
`/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}/files`.

| Method and path | Purpose |
| --- | --- |
| GET (collection) | Active file metadata to a project reader: file ID, safe filename, MIME type, byte size, uploader display name, scan status (`pending`, `clean`, `quarantined`), version, timestamps. Never a storage key or credential. |
| POST (collection) | Upload raw file bytes. Requires work authorization, same origin, canonical `Content-Type`, percent-encoded `X-File-Name`, and an `Idempotency-Key`. Streams at most 10 MiB, then validates extension, declared MIME, and file signature/content before storing. At most 20 active files and 100 MiB per task. When a malware scanner is configured, the upload is scanned synchronously and recorded as `clean` or `quarantined` (infected, or scanner unavailable — fail closed); with no scanner configured it is recorded as `pending` (not scanned, never clean). In async mode (`NEXORA_MALWARE_SCANNER=github-actions`) the upload is recorded as `pending` and a scan job is dispatched to GitHub Actions after the transaction commits; the verdict arrives later via the scan-result callback (§4) and moves the row to `clean` or `quarantined`. An idempotency replay never re-dispatches. In relay mode (`NEXORA_MALWARE_SCANNER=clamav-relay`) the upload is scanned synchronously through the HTTPS relay and recorded `clean` or `quarantined` exactly like the TCP clamd mode. |
| GET `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}/files/{fileId}` (no token) | Issues a five-minute relative signed URL to a project reader. Refused with 409 `FILE_QUARANTINED` for a quarantined file, 409 `FILE_SCAN_PENDING` for a pending (unscanned) file. |
| GET (signed URL) | Returns the file as a download attachment. The HMAC claim binds organization, project, task, file, version, and original user; download rechecks membership, project access, file version and state, and SHA-256 integrity. Rate-limited. Refused with 409 `FILE_QUARANTINED` for a quarantined file, 409 `FILE_SCAN_PENDING` for a pending file. |
| PUT `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}/files/{fileId}` | Replaces content and metadata. Requires work authorization, same origin, and `If-Match` with the current version. Stale version returns 409; success increments the version and invalidates older signed links. |
| DELETE `/api/organizations/{organizationId}/projects/{projectId}/tasks/{taskId}/files/{fileId}` | Soft-deletes immediately, revokes links. Purge after 30 days is by the operator-run cleanup command, not by this route. |

### 2.8 Scheduled jobs (cron)

| Method and path | Purpose | Auth |
| --- | --- | --- |
| GET `/api/cron/{job}` | Run one scheduled job: `due-date` (reminders for tasks due tomorrow), `cleanup` (expired-record purge + file-object removal), `email-outbox` (one notification-email worker batch), `alerts` (metrics alerting on the SMTP path), `healing` (bounded auto-healing: purge expired sessions; disabled entirely by `NEXORA_HEALING_DISABLED=1`), `scan-retry` (re-dispatch async scan jobs for active pending files older than 1 hour and younger than 7 days, capped at 50 per run; migration 0064). A second call the same day replays the first run's result; a failed run can be retried the same day. | `x-nexora-cron-token` header OR `Authorization: Bearer` with the same token (the form Vercel Cron sends when `CRON_SECRET` equals `NEXORA_CRON_TOKEN`); `NEXORA_CRON_TOKEN` env; unset token → 503, wrong token → 401, unknown job → 404. Authentication runs before routing (2026-10-29 operator-controls round): an unknown job with a wrong token is a 401, not a 404, so job names are not enumerable; an unknown job with a valid token is still a 404. There is deliberately no lockout on cron: token spam must never deny scheduled jobs. Every call consumes the DB-backed per-IP rate limit (scope `operator-cron`, 120/hour, migration 0063); beyond it → 429, and a missing/invalid trusted-IP header in production → 503. Failed authentications are logged as `operator.auth_failed` events (endpoint only, never the token). The origin check does not apply (cron callers are not browsers). Schedule lives in `vercel.json` (daily on Hobby; see `docs/deployment.md` §6a). |

Alerts: server-error total crossing a new multiple of
`NEXORA_ALERT_SERVER_ERROR_THRESHOLD` (default 10) since the last
alert, and database-down (at most once an hour), each mailed to
`NEXORA_ALERT_EMAIL`. Blank `NEXORA_ALERT_EMAIL` means alerts are
disabled. Storage quota: an explicit per-organization quota always
wins; otherwise `NEXORA_DEFAULT_STORAGE_QUOTA_BYTES` (opt-in,
positive integer bytes, recommended 1073741824 = 1 GiB) applies;
blank means no cap, as before.

## 3. External APIs and integrations

| Integration | How it is called | Failure behaviour |
| --- | --- | --- |
| PostgreSQL | `pg` pool, parameterized SQL, transaction-local context, RLS. | Safe 500/503 to the client, structured log server-side, serialization conflicts as 409. Never a database detail to the client. |
| SMTP (Nodemailer) | Verification, reset, and invitation links, TLS by default, canonical `APP_ORIGIN`. | Non-enumerating responses to the caller. Registration, password-reset, and verification-resend verify SMTP delivery before any account or token work, and a delivery failure returns 503 `EMAIL_DELIVERY_UNAVAILABLE` with a generic message, logged server-side as `EmailDeliveryError` with no SMTP detail. Missing configuration returns 503 `SERVICE_UNAVAILABLE`. Invitation delivery returns an honest `emailAccepted` flag. |
| Private filesystem | Server-only directory, opaque UUID names, restrictive permissions, signed download links. | Upload failure does not corrupt task/project state; a staged file whose commit outcome is unknown is preserved, not silently orphaned. |
| Future: AI provider, realtime service, object storage, Redis | Not integrated. No keys, no endpoints, no client-side calls. | When built, each must follow `ARCHITECTURE.md` section 9 and the failure rules in section 5 below. |

## 4. Webhooks

One inbound webhook exists: the scan-result callback for async
malware scanning (design:
`docs/async-scan-github-actions-design.md`). It follows the
rules this section used to state for a future webhook:
authentication is a shared secret (`x-nexora-scan-secret`
header, timing-safe compare) verified before any business
logic; the payload is validated with a Zod schema
(`scanCallbackSchema`: file ID, positive version, outcome
`clean` | `infected` | `error`, run ID); redelivery is safe
because the SECURITY DEFINER function (migration 0064)
applies a verdict only while the row is still `pending` at
the dispatched version, so a duplicate or stale delivery is a
no-op; only safe metadata is logged; a missing secret fails
closed with 503 and a wrong secret with 401; and no
caller-supplied tenant, role, or user ID is trusted (the
callback carries no tenant claim at all — the function looks
the row up by file ID and version). There is no IP rate limit
on this endpoint in v1 (GitHub egress IPs vary); the secret
plus the pending-only transition are the controls. The
endpoint always answers 200 after authentication, whether
applied or ignored; a 500 means the verdict could not be
recorded at all.

| Method and path | Purpose | Auth |
| --- | --- | --- |
| POST `/api/internal/scan-result` | Apply one async scan verdict: `clean` → `clean`, `infected` or `error` → `quarantined` (fail closed), only for an active row still `pending` at the dispatched version. The origin check does not apply (the caller is a GitHub Actions runner, not a browser). | `x-nexora-scan-secret` header with `NEXORA_SCAN_WEBHOOK_SECRET`; unset secret → 503, wrong secret → 401, invalid payload → 400. |

## 5. Rate limiting

- Auth: login and recovery, per-user and per-IP fixed-window limits in
  PostgreSQL, with HMAC-derived subjects and a saturating attempt bound.
- Search: 60 per user per hour, 120 per IP per hour.
- Task files: dedicated rate-limit scopes (migrations `0014` and `0017`),
  including signed-download limits.
- Production IP trust: a trusted ingress header containing exactly one
  client IP, configured by `NEXORA_TRUSTED_CLIENT_IP_HEADER`. A missing or
  malformed production configuration fails closed; a client-supplied
  forwarding chain is never trusted.
- A rate-limited request returns 429 and does not reveal the limit
  configuration or the remaining quota in a way that aids abuse.

## 6. Required environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Restricted runtime database role. Never committed, never client-side. |
| `MIGRATOR_DATABASE_URL` | Schema-owner migration role, direct endpoint only, `sslmode=require` for Neon. |
| `NEXORA_TEST_DATABASE_URL`, `NEXORA_TEST_MIGRATOR_DATABASE_URL` | Disposable test databases only. Never production. |
| `APP_ORIGIN` | Canonical browser origin and email-link origin. `https:` in production. |
| `AUTH_RATE_LIMIT_HMAC_KEY` | At least 32 random bytes, server-only. |
| `NEXORA_PRIVATE_FILE_DIR` | Absolute, private, persistent directory, never under `public/`. |
| `NEXORA_FILE_SIGNING_KEY` | At least 32 bytes, server-only, for five-minute signed download links. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Outbound email. `SMTP_PASSWORD` is a secret and is never logged. |
| `NEXORA_TRUSTED_CLIENT_IP_HEADER` | Production trusted-ingress IP header. Blank in local development. |
| `NEXORA_CRON_TOKEN` | Long random value for `GET /api/cron/{job}`. Blank means every cron call fails closed with 503. |
| `NEXORA_OPERATOR_DATABASE_URL` | Connection string for the dedicated `nexora_operator` database role (direct endpoint, `sslmode=require`), used only for the two operator aggregate functions. Blank means the metrics `operator` block is null. The role itself is created by the database owner (migration 0066 deliberately does not create or grant it). |
| `NEXORA_TOTP_ENCRYPTION_KEY` | 64 hex characters (32 bytes) for AES-256-GCM encryption of authenticator secrets. Blank or malformed means every TOTP route fails closed with 503 and nobody can enroll. |
| `NEXORA_MALWARE_SCANNER` | Scan mode: `clamav` (synchronous clamd scan), `clamav-relay` (synchronous scan via the HTTPS relay; needs `NEXORA_CLAMAV_RELAY_URL` — `https:` in production — plus `NEXORA_CLAMAV_RELAY_TOKEN`, and optionally `NEXORA_CLAMAV_RELAY_CA` for a pinned private CA), `github-actions` (async GitHub Actions scan; needs `NEXORA_GITHUB_DISPATCH_TOKEN` for dispatch and `NEXORA_SCAN_WEBHOOK_SECRET` for the callback), blank/`none` (no scanning; uploads stay `pending`). Any other value fails uploads with a configuration error. |
| `NEXORA_GITHUB_DISPATCH_TOKEN` | GitHub token able to send repository dispatches for async scanning. Blank means dispatch is skipped (uploads still succeed, rows stay `pending` for the retry cron). Never logged. |
| `NEXORA_SCAN_WEBHOOK_SECRET` | Shared secret for `POST /api/internal/scan-result`, at least 32 random bytes, server-only; the same value is stored as a GitHub Actions secret. Blank means every callback fails closed with 503. |
| `NEXORA_SCAN_REPO` | Repository dispatched to for async scanning (default `Gautam215/nexora`). |
| `CRON_SECRET` | Must equal `NEXORA_CRON_TOKEN`. Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>`; a mismatch makes every Vercel Cron call 401. |
| `NEXORA_ALERT_EMAIL`, `NEXORA_ALERT_SERVER_ERROR_THRESHOLD` | Alert recipient (blank = disabled) and server-error threshold (default 10). |
| `NEXORA_DEFAULT_STORAGE_QUOTA_BYTES` | Opt-in default quota for organizations with no explicit quota. Blank = no cap. |

## 7. Data privacy and failure handling

- **Privacy by design:** data minimization (search never returns member
  emails or file content), purpose limitation (a token is used only for
  its one purpose), access control (server-side, RLS-backed), safe
  logging (no passwords, tokens, keys, or link parameters), and short-lived
  signed links.
- **Third-party disclosure:** SMTP is the only external recipient of user
  data today, and it receives account email addresses and account-link
  tokens. That disclosure is not yet documented to users; documenting it
  is a release task, not an afterthought.
- **Failure handling, by dependency:**
  - Database unavailable: safe service-unavailable behaviour; never a
    false success for a write. The health endpoint reports `unavailable`
    without changing its liveness status.
  - Email unavailable: registration, password-reset, and
    verification-resend return 503 `EMAIL_DELIVERY_UNAVAILABLE` and
    never claim a link "will arrive" when delivery failed. A failed
    registration creates no account during an outage, because SMTP
    verification runs before account creation; a transient failure
    after verification leaves a valid, unverified account whose owner
    can resend once SMTP recovers.
  - File storage unavailable: upload failure without corrupting
    task/project state.
  - AI provider unavailable (future): the application remains usable;
    the AI feature shows a controlled failure with a retry option.
  - WebSocket unavailable (future): fallback to refresh/polling.
  - Queue unavailable (future): do not silently lose important jobs;
    persist and retry where the architecture supports it.
  - Client disconnect during a mutation: idempotency and reconciliation
    prevent duplicate side effects.
