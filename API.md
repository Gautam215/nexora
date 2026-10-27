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

### 1.6 Idempotency

- Task, milestone, comment, and file-upload creation accept an
  `Idempotency-Key` header. A retry with the same key and the same
  payload replays the original result. The same key with different
  content returns 409.
- File replacement uses `If-Match` with the current file version instead
  of an idempotency key; a stale version returns 409 and the replacement
  does not happen.
- Invitations, AI-generated resource creation, notifications, and
  background jobs are the other operations that must use idempotency
  when they are built; today, only the four creation paths above are
  covered, and the gap is recorded in the implementation plan.

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
| GET `/api/metrics` | Operator metrics: uptime, request counts by status class and normalized path, failures by operation, timed database probe latency, pool counters, and realtime counters (live/total stream connections, events published, events enqueued to streams). Paths are normalized (UUID/numeric segments become `:id`) and query strings are never recorded; no user data or credential is ever reported. Counters are process-local. "Delivered" means enqueued to a stream controller, not client-acknowledged (SSE has no acknowledgements). Fails closed with 503 when `NEXORA_METRICS_TOKEN` is unset. | Shared token in the `x-nexora-metrics-token` header, compared in constant time. Not a user session. |

### 2.1a AI (new in this change)

| Method and path | Purpose | Auth |
| --- | --- | --- |
| POST `/api/organizations/{organizationId}/ai/summarize` | Authorized summary of one project, from tasks, milestones, activity, and comments the caller can access. Read-only. Returns `{ summary, aiGenerated: true, executionId }`. Fails closed with 503 `AI_UNAVAILABLE` when no provider is configured, and 503 `AI_FAILED` on provider/timeout/invalid-output failure. Rate limits: 60/hour per user, 120/hour per organization. | Signed-in active organization member; project must be visible to the caller (`can_access_current_project`), else 404 `PROJECT_NOT_FOUND`. |
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
| GET `/api/organizations/{organizationId}/projects/{projectId}/realtime/stream` | Server-Sent Events stream for one project. First sends `hello` (`{ projectId, latestVersion }`), then replays missed events (up to 200) for a returning client, or one `resync` event (`{ projectId, latestVersion }`) when the client is further behind. Events carry `id` (UUID, used by EventSource for reconnection), `event` (one of `task.created`, `task.updated`, `task.deleted`, `comment.created`, `project.updated`), and JSON `data` (ids/titles/names plus `version` and `projectId`; never secrets, bodies, or emails). `task.deleted` fires when a task is archived. Reconnection: EventSource resends the last event id automatically; `?since=` is also accepted. A fresh client (no last seen version) receives live events only. Heartbeat comments every 15 seconds; the log is polled every 2 seconds. The same stream also sends `presence.changed` (`{ projectId, online: [{ userId, displayName }] }`, no `id` — ephemeral roster state, not a log event) after `hello` and whenever the roster changes; the roster is per-process, so members connected to another instance are absent, and a dead socket lingers until the runtime closes the stream. Rate limit: 120/hour per user (`realtime-connect-user`). | Session cookie (EventSource sends cookies same-origin; no CORS headers are emitted). Project must be visible to the caller (`can_access_current_project`), else 404 `PROJECT_NOT_FOUND`; non-members → 403; anonymous → 401. |

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
| POST `/api/organizations` | Create an organization; the creator becomes its owner member transactionally, with an audit record. | Session |
| GET `/api/organizations/{organizationId}` | Organization detail. | Session, active membership |
| PATCH `/api/organizations/{organizationId}` | Update organization name and/or slug, with the same validation as creation, and optionally `storageQuotaBytes` (positive integer up to 1 TiB, or `null` to clear the quota). Slug conflicts return 409 `SLUG_TAKEN`; a change writes an `organization.updated` audit record with previous and new values. A save with no changes succeeds and writes no audit row. Rate-limited (40 per user per hour, 80 per IP per hour, scope `organization-settings-user`). The response includes `storage_quota_bytes` and `storage_usage_bytes` (active file bytes across the workspace); GET returns the same two fields. NULL quota means no organization cap — per-task caps (20 files, 100 MB) still apply. Uploads and replacements over the quota return 409 `ORGANIZATION_STORAGE_LIMIT`. | Session, owner or admin |
| DELETE `/api/organizations/{organizationId}` | Soft-delete the organization (see below). Body `{ slug }` must repeat the workspace's current slug as explicit confirmation; a mismatch returns 409 `ORGANIZATION_SLUG_MISMATCH`. Writes an `organization.deleted` audit record. Rate-limited (40 per user per hour, 80 per IP per hour, scope `organization-deletion-user`). | Session, owner only |
| GET/POST `/api/organizations/{organizationId}/invitations` (and accept/revoke routes under `/api/invitations/`) | Create, accept, and revoke invitations. Acceptance requires an active, email-verified account matching the invited address, is single-use, and records membership and audit data transactionally. Replay is rejected. | Session; manager roles for create/revoke; invited user for accept |
| GET `/api/organizations/{organizationId}/members`, PATCH `/api/organizations/{organizationId}/members/{userId}` | List organization members; change a member's role or status (see session rotation in 2.2). | Session, active membership; manager roles for PATCH |
| POST `/api/organizations/{organizationId}/projects/{projectId}/members`, PATCH `…/members/{userId}` | Add a project member; change a project member's role or status (status change revokes sessions; role-only change does not). | Session, project-management authority |
| DELETE `/api/organizations/{organizationId}/invitations/{invitationId}` | Revoke a pending invitation. | Session, manager roles |
| PATCH `/api/organizations/{organizationId}/notifications/{notificationId}` | Mark one notification read or unread (recipient only). | Session, recipient |
| PATCH `/api/organizations/{organizationId}/projects/{projectId}/tasks/bulk` | Safe bulk priority update for versioned tasks. | Session, work authority |
| PUT `/api/organizations/{organizationId}/projects/{projectId}/tasks/workflow` | Replace the project's configurable task workflow (requires one completion column and unique names). | Session, project-management authority |

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
| Comments | Append-only creation on a task, with mention extraction. No edit or delete endpoint exists. |
| Activity | Project activity feed, backed by audit events, most recent first. |
| Analytics | GET `…/projects/{projectId}/analytics` — calculated progress, completion, overdue work, workload (including unassigned), milestone progress, recent activity (trailing seven days, at most five events), upcoming deadlines (at most eight), and rule-based health with its reason. No AI insight, no capacity percentage. |

Route methods, verified against the route files: projects `GET / POST` (collection) and `GET / PATCH / DELETE` (one); milestones `GET / POST` and `GET / PATCH / DELETE`; tasks `GET / POST` and `GET / PATCH / DELETE` (DELETE archives); comments `GET / POST`; activity `GET`; analytics `GET`; realtime stream `GET`; files `GET / POST` and `GET / PUT / DELETE`. There is no task, milestone, or comment edit-after-create beyond PATCH, and no comment edit or delete endpoint.

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
| POST (collection) | Upload raw file bytes. Requires work authorization, same origin, canonical `Content-Type`, percent-encoded `X-File-Name`, and an `Idempotency-Key`. Streams at most 10 MiB, then validates extension, declared MIME, and file signature/content before storing. At most 20 active files and 100 MiB per task. When a malware scanner is configured, the upload is scanned synchronously and recorded as `clean` or `quarantined` (infected, or scanner unavailable — fail closed); with no scanner configured it is recorded as `pending` (not scanned, never clean). |
| GET `/files/{fileId}` (no token) | Issues a five-minute relative signed URL to a project reader. Refused with 409 `FILE_QUARANTINED` for a quarantined file. |
| GET (signed URL) | Returns the file as a download attachment. The HMAC claim binds organization, project, task, file, version, and original user; download rechecks membership, project access, file version and state, and SHA-256 integrity. Rate-limited. Refused with 409 `FILE_QUARANTINED` for a quarantined file. |
| PUT `/files/{fileId}` | Replaces content and metadata. Requires work authorization, same origin, and `If-Match` with the current version. Stale version returns 409; success increments the version and invalidates older signed links. |
| DELETE `/files/{fileId}` | Soft-deletes immediately, revokes links. Purge after 30 days is by the operator-run cleanup command, not by this route. |

## 3. External APIs and integrations

| Integration | How it is called | Failure behaviour |
| --- | --- | --- |
| PostgreSQL | `pg` pool, parameterized SQL, transaction-local context, RLS. | Safe 500/503 to the client, structured log server-side, serialization conflicts as 409. Never a database detail to the client. |
| SMTP (Nodemailer) | Verification, reset, and invitation links, TLS by default, canonical `APP_ORIGIN`. | Non-enumerating responses to the caller. Registration, password-reset, and verification-resend verify SMTP delivery before any account or token work, and a delivery failure returns 503 `EMAIL_DELIVERY_UNAVAILABLE` with a generic message, logged server-side as `EmailDeliveryError` with no SMTP detail. Missing configuration returns 503 `SERVICE_UNAVAILABLE`. Invitation delivery returns an honest `emailAccepted` flag. |
| Private filesystem | Server-only directory, opaque UUID names, restrictive permissions, signed download links. | Upload failure does not corrupt task/project state; a staged file whose commit outcome is unknown is preserved, not silently orphaned. |
| Future: AI provider, realtime service, object storage, Redis | Not integrated. No keys, no endpoints, no client-side calls. | When built, each must follow `ARCHITECTURE.md` section 9 and the failure rules in section 5 below. |

## 4. Webhooks

There are no inbound or outbound webhooks today. When one is added, it
must: verify its signature server-side before any business logic, use an
idempotency key to make redelivery safe, validate its payload with a Zod
schema, log only safe metadata, and fail closed on a missing or invalid
signature. No webhook may trust a caller-supplied tenant, role, or user ID.

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
