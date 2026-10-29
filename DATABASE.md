# Nexora — Database

This document defines the complete data model. The numbered SQL migrations
in `db/migrations/` are authoritative for exact column definitions; this
document summarizes them, explains the relationships and the authorization
model, and must be updated in the same change as any migration that alters
the model. No application code is included here.

## 1. Database technology

- **Primary database:** PostgreSQL 16. All application data lives in the
  `nexora` schema. There is no second primary database.
- **Access:** `pg` connection pool, two roles (see section 8). No ORM.
- **Migrations:** Numbered, immutable SQL files `0001`–`0022`, applied by
  `scripts/migrate.mjs` under a session advisory lock, with a checksum
  recorded in `nexora.schema_migrations`. A checksum mismatch fails the
  run. The migrator applies `db/runtime-grants.sql` in the same run.
- **Exception — migration 0048 (2026-10-27, user-authorized):** 0048 was
  corrected from plain `CREATE FUNCTION` to `CREATE OR REPLACE` for its
  two lifecycle functions so a fresh database can migrate 0001–0048
  (previously it aborted at 0048 because 0012 already created them).
  The bodies are definition-identical, so no database state changes,
  but the file checksum changed from
  `feaa1fc3151f1ccaf5c89d2a9bc6c75b46b0c02265d0c24e4a1abedb3f06a209` to
  `2f91e160da5e61bb1cf9672d5ae8f857e8bf0e1505be4e2ea971773d09425119`.
  Production's recorded 0048 checksum was updated to the new value
  on 2026-10-27 (Neon SQL Editor, verified by re-select), so the
  repo and production agree again.
- **Migration 0049 (2026-10-27):** scheduled jobs and organization
  idempotency. `scheduled_job_runs` (one row per job per day,
  replay on repeat, retry after failure), `alert_state` (last
  alert value/timestamp per rule, for deduplication),
  `organization_creation_idempotency` (per-actor keyed replay,
  7-day expiry, mirroring the project pattern), SECURITY DEFINER
  `list_due_date_tasks()` (tasks due tomorrow, neither completed
  nor archived, project and organization active), and one narrow
  notifications insert policy for system due-date reminders (see
  ARCHITECTURE.md §12). No RLS on the two job tables: they hold
  only operational rows, and the cron route is token-gated.
- **Migration 0050 (2026-10-28 round 4):**
  `project_creation_idempotency`, mirroring
  `organization_creation_idempotency` (7-day expiry, grants in
  `runtime-grants.sql`) but scoped per-actor per-organization
  like `project_mutation_idempotency` (RLS actor + current
  organization, membership foreign key), so the same key and
  body in a different organization creates a second project
  instead of replaying the first.
  Project creation was the one creation path that duplicated on
  retry; it now replays on the same key and body and returns
  409 `IDEMPOTENCY_KEY_REUSED` on key reuse with a different
  body (see API.md §1.6).
- **Migration 0051 (2026-10-28 healing round):**
  the `scheduled_job_runs` job CHECK gains `'healing'`, and
  `purge_expired_sessions()` (SECURITY DEFINER, grant in
  `runtime-grants.sql`) deletes sessions whose `expires_at`
  has passed. Expired sessions cannot authenticate, so the
  purge changes no live session.
- **Migration 0052 (2026-10-28 healing round):**
  `organization_usage_summary(org, user)` (SECURITY DEFINER,
  grant in `runtime-grants.sql`): refuses non-owners/admins
  with a forbidden marker, then returns storage bytes, active
  file count, and quota plus per-workflow AI token usage over
  succeeded executions, for all time and for the last 30 days.
  It exists because `ai_executions` rows are RLS-restricted to
  the caller's own rows, so no plain member query can aggregate
  org-wide.
- **Migration 0053 (2026-10-28 healing round, correction):**
  `CREATE OR REPLACE` of `organization_usage_summary` with
  the identical signature and checks: 0052 schema-qualified
  COALESCE as `pg_catalog.coalesce`, but COALESCE is a
  conditional expression, not a function, so every call failed
  with 42883 and the usage endpoint answered 500. Only the
  COALESCE calls are unqualified here; 0052 itself is not
  edited.
- **Migration 0054 (2026-10-28 member removal):**
  RLS DELETE policies (manager/self split) plus the matching
  DELETE grants in `runtime-grants.sql` for notification
  preferences and organization invitations, the two tables
  removal actually deletes. Membership-row DELETE policies
  were included here first and removed again by 0055.
- **Migration 0055 (2026-10-28 member removal, correction):**
  drops the unused organization/project membership DELETE
  policies from 0054 and revokes their DELETE grants: removal
  disables the membership instead of deleting it, because the
  schema anchors history to memberships with RESTRICT keys.
  0054 itself is not edited.
- **Migration 0056 (2026-10-28 member removal):**
  `apply_organization_member_removal(org, user)` (SECURITY
  DEFINER, grant in `runtime-grants.sql`): unassigns the
  member's tasks in the workspace and disables the membership.
  It exists because there is no update-self RLS policy, so a
  direct UPDATE would silently affect zero rows for a
  voluntary leave, and a viewer could not unassign their own
  tasks. The caller must be an active member and either a
  manager or the member themselves; the route enforces owner
  protection and the last-owner block before calling it.
- **Migration 0057 (2026-10-28 account deletion):**
  `users.deleted_at` (the scrub marker; a scrubbed account has
  status `suspended`, so the existing login check denies it and
  no route can unsuspend it) plus the `account-export-user`
  and `account-deletion-user` rate-limit scopes (CHECK and
  `consume_auth_rate_limit` allowlist, following the
  established pattern).
- **Migration 0058 (2026-10-28 account lifecycle):**
  `delete_user_account(user)` and `export_user_data(user)`
  (SECURITY DEFINER, EXECUTE granted to `nexora_app` only).
  Both guard to the caller and raise 42501 otherwise. Deletion
  scrubs instead of hard-deleting (the users row anchors
  history with RESTRICT keys): one `account.deleted` audit
  row per active workspace, sessions and auth tokens deleted,
  notification preferences deleted, pending invitations for
  the user's email deleted, tasks unassigned everywhere,
  project memberships deleted except mention anchors,
  organization memberships disabled, and the user row
  anonymized. A sole-owner active workspace blocks deletion
  and its slug is returned. (Note: 0058's header comment
  mentions transferring ownership, which is stale — no
  transfer route exists and role updates cannot set owner,
  so a sole owner must delete the workspace first; the
  account route message already says exactly that. 0058
  itself is not edited for a comment.) Export returns the caller's own
  data across workspaces as JSON; files are metadata only,
  AI executions are metadata only, notifications are counts
  only.
- **Migration 0059 (2026-10-28 comment soft-delete):**
  `task_comments.deleted_at` plus `delete_task_comment(org,
  project, task, comment)` (SECURITY DEFINER, EXECUTE granted
  to `nexora_app` only): sets `deleted_at` and nothing else,
  only for the author or a project manager, returning false
  for an already-deleted or nonexistent comment. There is
  deliberately no UPDATE policy on `task_comments`: a broad
  policy would let a future route edit comment bodies, which
  the append-only design forbids. The app role's column-level
  SELECT grant on `task_comments` was extended with
  `deleted_at` in `runtime-grants.sql`, or the list and search
  filters fail with 42501.
- **Migration 0060 (2026-10-28 account deletion,
  correction):** redefines `delete_user_account` identically
  to 0058 except the audit insert now supplies a generated
  `id`: `audit_events.id` has no default, so 0058's insert
  failed every deletion with 23502. 0058 itself is not
  edited.
- **Migration 0065 (2026-10-29 member-removal guards,
  applied to production 2026-10-29, 65 migrations,
  checksum verified):** redefines
  `apply_organization_member_removal()` with the two business
  rules that used to live only in the removal route: an owner
  target is refused for anyone but a leaving owner, and a
  sole owner leaving is refused; a target who was never a
  member is refused too. 0056 itself is not edited. The
  route's checks stay in place on top (defense in depth), so
  its 403/404/409 responses are unchanged; the function is
  now the backstop behind them. Grants are unchanged
  (revoked from PUBLIC, granted to `nexora_app`).
- **Migration 0064 (2026-10-28 async scan functions):**
  two SECURITY DEFINER functions, no new tables (v1 decision:
  the 7-day age cap bounds retries instead of per-file attempt
  counts). `apply_scan_result(file, version, outcome)` moves a
  row only while it is active, still `pending`, and still at
  the dispatched version — `clean` becomes clean, `infected`
  or `error` becomes quarantined (fail closed); every other
  call is a no-op returning false, so duplicate, stale, or
  deleted-file callbacks cannot move a row twice or across
  versions. The version is not bumped (scan completion is not
  a content change). `list_stale_pending_files()` returns
  active pending rows older than 1 hour and younger than 7
  days, capped at 50, oldest first, for the daily scan-retry
  cron. Both functions are granted to `nexora_app`.
- **Migration 0063 (2026-10-28 operator rate-limit
  scopes):** adds `operator-cron` and `operator-metrics` to
  the `auth_rate_limits` scope CHECK and to the
  `consume_auth_rate_limit` allowlist, following the 0057
  pattern exactly (function body otherwise byte-identical).
  These scopes back the per-IP 120/hour limits on the cron
  and metrics token endpoints. Applied to production
  2026-10-28 14:04 IST (63 migrations, checksum verified).
- **Migration 0062 (2026-10-28 milestone trigger,
  correction):** redefines
  `guard_milestone_task_consistency()` identically to 0008.
  Production's copy had diverged: its third EXISTS block
  joined `milestones` to itself under one alias instead of
  joining `milestone_dependencies`, so every milestone status
  UPDATE failed with 42712. 0008 itself is not edited.
  Milestone and project DATE columns are returned with
  `::text` (following the existing task `due_date::text`
  precedent) so edit forms receive YYYY-MM-DD strings
  instead of timestamp strings that date inputs render
  blank.
- **Not used:** Redis, a queue store, or a separate analytics store.
  Rate limits, idempotency, and notifications are PostgreSQL tables.
  Task-file bytes are not in the database; only their metadata is (see
  section 3, `task_files`).

## 2. Tables

All tables live in the `nexora` schema. Identifiers are UUIDs. Timestamps
are recorded with time zone. The table below gives each table's purpose and
its load-bearing columns; the migrations give the full definition.

| Table | Purpose and key columns |
| --- | --- |
| `users` | Account identity. `id`, unique `email`, `display_name`, `password_hash` (scrypt, nullable since migration 0032 for OAuth-only users; OAuth removed in migration 0047, nullability retained for migration safety — see ARCHITECTURE.md 7.1), `email_verified_at`, `created_at`, `updated_at`, `deleted_at` (migration 0057; set when the account is scrubbed by deletion). |
| `oauth_identities` | REMOVED in migration 0047 (was: Google identities, migration 0032). The table and `lookup_oauth_identity` no longer exist; migration 0032 is kept as history only. |
| `scheduled_job_runs` | Cron job audit: `job` (due-date/cleanup/email-outbox/alerts), `run_date`, `status` (ok/failed), `detail`, one row per job per day. No RLS (operational rows only, cron route is token-gated). The app role holds INSERT, SELECT, UPDATE, and DELETE: the same-day retry path deletes a failed claim row before re-inserting it, and without the DELETE grant every same-day retry failed with 42501 (found by the operator-metrics test colliding with the cron claim in the full suite, 2026-10-28). |
| `alert_state` | Alert deduplication: `rule` (server-errors/database-down), `last_value`, `last_sent_at`. No RLS (operational rows only). |
| `organization_creation_idempotency` | Organization-creation replay: per-actor key hash + request hash, response status/body, 7-day expiry. RLS mirrors the project pattern (actor only). |
| `project_creation_idempotency` | Project-creation replay (migration 0050): same shape as the organization table, operation `project.create`, 7-day expiry, but scoped per-actor per-organization (RLS actor + current organization). |
| `user_sessions` | Opaque sessions. `id`, `user_id`, `token_hash` (SHA-256), `created_at`, `expires_at`, `revoked_at`. A session is valid only if unexpired and unrevoked. Privilege-change revocation (migration 0039, approved default 2026-10-26): `revoke_user_sessions_for_org_privilege_change` and `revoke_user_sessions_for_project_privilege_change` (SECURITY DEFINER, owner targets refused, admin/manager caller required) set `revoked_at` on all of the target user's unrevoked sessions. |
| `email_verification_tokens` | Single-use verification tokens, stored as hashes, one live token per user. |
| `password_reset_tokens` | Single-use reset tokens, stored as hashes, one live token per user. |
| `auth_rate_limits` | Fixed-window rate-limit counters by HMAC-derived subject, scope, and window, with an expiry and a saturating attempt bound. |
| `organizations` | Tenants. `id`, `name`, unique `slug`, `creator_id`, `created_at`, `updated_at`. `storage_quota_bytes` (migration 0046, NULL = no organization quota; per-task caps still apply). No production quota value is invented: the value is set explicitly by an owner/admin via PATCH, or left NULL by a product decision. Enforced in the upload and replace transactions alongside the per-task caps; over-quota uploads return 409 `ORGANIZATION_STORAGE_LIMIT`. |
| `organization_memberships` | User ↔ organization, with `role` (`owner`, `admin`, `member`, `guest`) and `status` (active, disabled). Membership is the tenant gate. |
| `organization_invitations` | Invitations, with `email`, `role`, `token_hash`, `status`, and expiry. At most one pending invitation per organization and email. Acceptance is single-use and transactional. |
| `projects` | Projects within an organization. `id`, `organization_id`, `name`, `description`, `owner_user_id`, `status` (Planned, Active, On Hold, Completed, Archived), `start_date`, `target_date`, `version` (optimistic concurrency), timestamps, `deleted_at` (nullable; non-null means soft-deleted), `deleted_by_user_id` (nullable; paired with `deleted_at` by a CHECK, referencing the deleter's organization membership with `ON DELETE RESTRICT`). |
| `project_memberships` | User ↔ project, with project `role` (`manager`, `member`, `viewer`). Project ownership is tracked separately from membership. |
| `project_task_statuses` | Configurable workflow statuses per project, with `name`, `position`, and `is_done`. Exactly one done status per project. |
| `milestones` | Milestones within a project. `id`, `project_id`, `name`, `description`, `start_date`, `end_date`, `status`, `version`, timestamps, `deleted_at` (nullable; non-null means soft-deleted), `deleted_by_user_id` (nullable; paired with `deleted_at` by a CHECK, referencing the deleter's organization membership with `ON DELETE RESTRICT`). |
| `milestone_dependencies` | Milestone → milestone dependency edges, checked for cycles under a per-project graph lock. |
| `tasks` | Tasks within a project. `id`, `project_id`, `milestone_id` (nullable), `parent_task_id` (nullable, subtasks), `title`, `description`, `status_id`, `priority`, `assignee_id` (nullable), `creator_id`, `labels` (array), `due_date`, `estimated_effort`, `version`, `archived_at` (nullable), timestamps. |
| `task_dependencies` | Task → task dependency edges, cycle-checked under the same per-project graph lock. |
| `task_comments` | Append-only comments on tasks. `id`, `task_id`, `author_id`, `body`, `created_at`, `deleted_at` (migration 0059; soft-delete hides the comment from lists and search, the row stays). No edit path. |
| `task_comment_mentions` | Mentions extracted from comments, linking a comment to a mentioned project member, driving mention notifications. |
| `task_files` | Private file metadata. `id`, `task_id`, `uploader_id`, `safe_filename`, `mime_type`, `byte_size`, `storage_key` (opaque, server-only), `sha256`, `version`, `deleted_at` (nullable, soft delete). Bytes live in the private filesystem, never in this table. `scan_status` (migration 0044, grants corrected in 0045): `pending` (not scanned — never a claim of clean), `clean` (a configured scanner reported clean), `quarantined` (scanner reported infected, or was unavailable at scan time; bytes and row are kept, downloads blocked with 409 FILE_QUARANTINED). |
| `notifications` | In-app notifications. `id`, `recipient_id`, `organization_id`, `project_id` (nullable), `type`, `payload` (display data only), `read_at` (nullable), `created_at`. Deduplicated at insert. |
| `notification_preferences` | Per-recipient notification preferences, by notification type. `in_app_enabled` (default true), `email_enabled` (default false, migration 0040). |
| `notification_email_outbox` | Transactional notification-email outbox (migrations 0040–0043, RLS fix 0041, actor-check fix 0043). `notification_id` UNIQUE with FK to `notifications(id)` ON DELETE CASCADE, `organization_id` + `recipient_user_id` FK to organization memberships, `event_type`, `title`, `body`, `href`, `status` (pending/processing/sent/failed), `attempts`, `next_attempt_at` (backoff), `sent_at`. RLS enabled, no policies: direct app-role access is denied, and all access goes through SECURITY DEFINER claim/mark/enqueue functions. |
| `audit_events` | Append-only audit trail. `id`, `organization_id`, `project_id` (nullable), `actor_id`, `event_type`, `entity_type`, `entity_id`, `metadata` (safe data only), `created_at`. Audit records are never edited in place. |
| `project_mutation_idempotency` | Idempotency keys for project mutations, with a payload hash and the original result, expiring after use. Key reuse with different content is a conflict, not a replay. Operations admitted by the CHECK (0038, correcting a 0037 regression that dropped two operations): `milestone.create`, `task.create`, `comment.create`, `file.upload`, `project.update` (the PATCH route's key is opt-in; creation routes require a key). |
| `project_dependency_graph_locks` | One internal row per project, used to serialize dependency-graph writes under `READ COMMITTED` and to reject stale `REPEATABLE READ` snapshots with `40001` rather than permitting a cycle. Not directly granted to the runtime role. |
| `schema_migrations` | Migration ledger: `name`, `checksum`, `applied_at`. |
| `ai_executions` | AI execution metadata only (migration 0034). `id`, `organization_id`, `project_id` (nullable; `ON DELETE CASCADE` for project purge), `user_id`, `workflow` (`planning`, `extraction`, `summarization`, `risk`, `assistant`), `provider`, `model`, `status` (`started`, `succeeded`, `failed`), `prompt_tokens`, `completion_tokens`, `latency_ms`, `error_code`, `created_at`, `completed_at`. Prompts and responses are NEVER stored. RLS restricts rows to the caller's own executions in the current organization. The organization purge deletes these rows (operational records, not audit events). |
| `ai_creation_idempotency` | Organization-level idempotency for AI confirmations that create resources (migration 0035). `organization_id`, `actor_user_id`, `operation` (`planning.confirm`, `extraction.confirm`), `key_hash`, `request_hash`, `response_status`, `response_body`, `created_at`, `expires_at` (default +7 days). PK is `(organization_id, actor_user_id, operation, key_hash)`; deliberately NOT project-scoped, because the project does not exist yet at confirm time. RLS restricts rows to the actor in the current organization. The organization purge deletes these rows. |
| `realtime_events` | Durable realtime event log (migration 0036). `id`, `organization_id` (RESTRICT), `project_id` (ON DELETE CASCADE), `type` (`task.created`, `task.updated`, `task.deleted`, `comment.created`, `project.updated`), `version` (per-project, UNIQUE with organization + project), `data` (minimal: ids/titles/names, never secrets/bodies/emails), `created_at`. RLS restricts reads and inserts to current organization members. Project purge cascades its events; no separate purge step. |

## 3. Relationships and ER diagram (text form)

The tenancy chain is the whole model. Read it top-down; every row below a
tenant belongs to that tenant, and no row is reachable without its tenant.

- One `users` row has many `user_sessions`, many
  `organization_memberships`, many `project_memberships`, and many
  `organization_invitations` (as invitee by email, and as inviter).
- One `organizations` row has many `organization_memberships`, many
  `organization_invitations`, many `projects`, many `audit_events`, and
  many `notifications`.
- One `projects` row belongs to one `organizations` row, and has many
  `project_memberships`, many `project_task_statuses`, many `milestones`,
  many `tasks`, many `audit_events`, and many `notifications`.
- One `milestones` row belongs to one `projects` row, has many `tasks`,
  and participates in many `milestone_dependencies` (as source and as
  target, within the same project).
- One `tasks` row belongs to one `projects` row, optionally to one
  `milestones` row, optionally to a parent `tasks` row (subtasks), and has
  many `task_comments`, many `task_dependencies` (both directions, within
  the same project), and many `task_files`.
- One `task_comments` row belongs to one `tasks` row and has many
  `task_comment_mentions`.
- One `task_files` row belongs to one `tasks` row.
- `notifications` and `audit_events` always carry their organization, and
  a project when they are project-scoped, so that tenant filtering never
  depends on joining through a task or comment.
- `project_mutation_idempotency` and `project_dependency_graph_locks`
  are keyed by project and exist only to make project mutations safe;
  they carry no user-facing content.

In short: user → organization membership → project membership → project
resources (milestones, tasks, comments, files). Search, analytics, and
notifications all read through that chain, never around it.

## 4. Constraints and validation

- **Primary keys:** every table has a UUID primary key, except
  `schema_migrations` (keyed by migration name) and the rate-limit and
  idempotency tables (keyed by their natural subject/window or key).
- **Foreign keys:** every tenant-scoped row references its parent, with
  the parent chain enforced in the database, not only in application code.
  A task cannot reference a milestone from another project; a comment
  cannot reference a task from another project; a dependency edge cannot
  cross projects. Cross-project writes are rejected by the database
  function or trigger that owns the check, not only by the route handler.
- **Uniqueness:** user email (case-insensitive in application handling,
  unique in the database); organization slug; one pending invitation per
  organization and email; one live verification token and one live reset
  token per user; one done workflow status per project; one workflow
  status name per project.
- **Checks:** role values are restricted to the documented sets
  (organization: `owner`, `admin`, `member`, `guest`; project: `manager`,
  `member`, `viewer`); task and milestone status transitions are validated
  against the project's configured workflow; file size and count limits
  (10 MiB per file, 20 active files per task, 100 MiB per task) are
  enforced server-side before storage.
- **Application validation:** Zod schemas in `src/security/` validate
  every API input (lengths, UUID formats, enum values, pagination bounds)
  before any query runs. Database constraints are the second gate, not
  the first, and never the only gate.
- **Soft deletion:** tasks, files, and projects are archived or soft-deleted, not
  hard-deleted, through the application. The runtime role cannot hard-delete
  file or project rows. Audit events are never deleted by application code.
- **Project purge (migrations 0024–0027):** the cleanup command calls
  `purge_expired_projects()`, a `SECURITY DEFINER` function that, under a
  transaction-scoped advisory lock, deletes task files (returning their
  storage keys so the command removes the bytes only after the database
  purge commits), comment mentions, comments, task dependencies, tasks,
  milestone dependencies, milestones, task statuses, mutation idempotency
  rows, notifications, and memberships, then the projects themselves, for
  projects soft-deleted at least 30 days ago. Graph-lock rows cascade with
  the project (`ON DELETE CASCADE`, migration 0021). Notifications are
  removed by the `notifications_project_fk` cascade (migration 0027), not
  by the function's explicit notifications step: notifications use `FORCE`
  row-level security with a recipient-scoped SELECT policy, and DELETE
  additionally requires the SELECT policy to pass, so no session-less
  purge context can ever satisfy it; loosening the SELECT policy or
  granting `BYPASSRLS` was rejected as a privacy/privilege weakening, and
  the runtime role holds no DELETE grant on notifications in any case.
  The command lists expired projects and expired files through the
  read-only `SECURITY DEFINER` functions `list_expired_projects()` and
  `list_expired_task_files()` (migration 0025), because the command runs
  without a tenant session and plain `SELECT`s would return nothing under
  RLS. Partial indexes serve the active list (`WHERE deleted_at IS NULL`)
  and the retention scan (`WHERE deleted_at IS NOT NULL`). Runtime grants
  cover `SELECT`/`UPDATE` on the two new columns and `EXECUTE` on all
  three functions.
- **Milestone purge (migrations 0029–0031):** the cleanup command calls
  `purge_expired_milestones()`, a `SECURITY DEFINER` function that, under
  a transaction-scoped advisory lock, deletes both directions of
  dependency rows for each milestone soft-deleted at least 30 days ago,
  detaches its tasks (`milestone_id` set to NULL — tasks belong to the
  project, so they are never deleted by a milestone purge), then deletes
  the milestone rows. Audit events are untouched (they carry no
  milestone foreign key). The command lists expired milestones through
  the read-only `SECURITY DEFINER` function `list_expired_milestones()`
  (migration 0029) for the same session-less reason as projects.
  Migration 0030 qualifies the purge's column references: 0029's
  `RETURNS TABLE` OUT parameter `milestone_id` shadowed the column in
  the dependency DELETE and task UPDATE, failing with 42702.
  Migration 0031 adopts the deleter's tenant context per milestone for
  the detach step, because the task graph-lock trigger requires
  `can_work_current_project` for the session and the purge has no tenant
  session (the project purge never hit this because DELETE fires
  neither task trigger); the caller's context is restored afterwards.
  Each milestone purges in its own exception block: a milestone that
  cannot purge — e.g. its project was archived after deletion, so the
  task guard refuses the detach, or its deleter lost project access —
  emits a WARNING and is skipped instead of aborting every other
  milestone's purge, stays expired for the next run, and is removed
  with its project if that project is later purged. The cleanup command
  warns when the purge returns fewer milestones than the listing.
- **Organization purge (migration 0033):** the cleanup command calls
  `purge_expired_organizations()` first — before the project purge,
  because it removes whole organizations including their projects — a
  `SECURITY DEFINER` function that, under a transaction-scoped
  advisory lock, purges each organization soft-deleted at least 30
  days ago and not yet purged: task files (storage keys returned for
  post-commit disk removal), comment mentions, comments, task
  dependencies, tasks, milestone dependencies, milestones, task
  statuses, mutation idempotency, project memberships, projects,
  invitations, notification preferences, and organization memberships,
  in foreign-key order, then marks the organization `purged_at`.
  Notifications need no explicit step: they cascade from their
  projects (migration 0027), and an explicit session-less DELETE
  would be a no-op under their FORCE row-level security. Graph locks
  also cascade from projects. Each organization purges in its own
  exception block with a WARNING on skip, mirroring the milestone
  purge, and the function returns one marker row with a NULL storage
  key per purged organization so file-less organizations are still
  counted. The command lists expired organizations through the
  read-only `SECURITY DEFINER` function
  `list_expired_organizations()` (migration 0033). **Audit retention
  decision:** audit events are retained indefinitely, exactly as for
  project deletion, and `audit_events.organization_id` is ON DELETE
  RESTRICT, so the organization row itself is never hard-deleted: it
  remains as a tombstone with its slug reserved. Users, sessions, and
  OAuth identities are never touched by an organization purge: they
  are user-scoped, not organization-scoped. The deleter foreign key
  points at users, not memberships, because the purge deletes
  memberships and a membership key would block the purge itself.

## 5. Indexes, based on real queries

Indexes exist for the queries the product actually runs, not for every
column. The load-bearing ones are:

- `users_email_unique` — login lookup by email.
- `user_sessions_by_user_expiry`, `user_sessions_active_by_user` —
  session resolution and revocation checks.
- `memberships_by_user_status` — "which organizations does this user
  belong to, and are they active?"
- `invitations_by_org_expiry`, `invitations_one_pending_per_org_email` —
  invitation lookup and the pending-invitation rule.
- `audit_events_by_org_time` — project and organization activity feeds.
- `projects_by_org_created`, `project_memberships_by_user` — workspace
  project lists and project visibility.
- `milestones_by_project_status`, `milestone_dependencies_by_target` —
  milestone lists and dependency checks.
- `tasks_by_project_milestone`, `tasks_by_project_parent`,
  `tasks_by_project_assignee`, `tasks_by_project_due_date`,
  `tasks_by_project_status_position`, `tasks_by_project_list_updated` —
  board, list, workload, and deadline queries.
- `tasks_labels_gin` — label filtering on tasks.
- `task_dependencies_by_target`, `task_comments_by_task_time` —
  dependency checks and comment feeds.
- Full-text GIN indexes (migration `0013`) on project names and
  descriptions, active task text and labels, comments, and active file
  names — the workspace search. Member search uses the security-definer
  member listing, not a full-text index on email, and email addresses are
  never indexed or returned by search.
- `project_mutation_idempotency_expiry`, `auth_rate_limits_expiry`,
  verification and reset token expiry indexes — cleanup and expiry
  checks.

A new query that filters or sorts by a new column must add its index in
the same migration, and a new index must name the query it serves.

## 6. Ownership and authorization

- **Schema owner:** the migrator role owns all tables, functions, and
  indexes. The runtime role owns nothing.
- **Runtime role:** `nexora_app`, granted only what
  `db/runtime-grants.sql` grants, after migrations, in the same migrator
  run. It has no `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, or `CREATEDB`
  privilege.
- **Row-level security:** RLS is enabled on every tenant table and forced
  for the runtime role. Policies use the transaction-local
  `nexora.user_id` and `nexora.organization_id` values, set by
  `withOrganizationContext` after active membership is verified.
  Project policies additionally require project ownership, a project
  membership, or organization-manager authority. Notifications are
  recipient-scoped: a recipient can read or update only their own
  project-visible records. Task files require project access to read and
  work permission to upload, replace, or soft-delete. Viewers receive no
  file-table update privilege.
- **Security-definer functions (narrow, audited):** auth lookups, rate-limit
  consumption, the organization member listing for search, the
  organization-creator bootstrap (to avoid a recursive RLS lookup),
  per-project graph-lock updates (with a current-authority check and a
  fixed `search_path`), file-download locking (which checks current
  project context and locks the active row), the project retention purge
  and its read-only expired-project/file listings (which delete only
  projects soft-deleted at least 30 days ago, under an advisory lock).
  Each exists because RLS alone cannot express the operation safely; none
  of them grants a caller broader access than the check inside the function
  allows.
- **Tenant isolation test:** the integration suite asserts cross-tenant
  denial for tasks, files, comments, and search results, and asserts that
  a viewer cannot write and cannot hard-delete. A new tenant table must
  add the same class of test in the same change.

## 7. Sensitive-data handling

- Passwords: scrypt hashes only, in `users.password_hash`. Never a
  plaintext password, never a reversible value.
- Session, verification, reset, and invitation tokens: SHA-256 hashes
  only. Raw tokens are emailed once and never stored.
- File storage keys, signing keys, and SMTP credentials: never in the
  database. The signing key is an environment variable; storage keys in
  `task_files` are opaque UUIDs that reveal no path.
- Audit and notification payloads: display data only. No passwords,
  tokens, secrets, or file bytes.
- Logs: no passwords, tokens, keys, or file-link query parameters, ever.
  A log line that would need one of those values is a bug in the log
  call, not a logging requirement.
- Search: member email addresses and file contents are not indexed, not
  searched, and not returned.

## 8. Migration and seed strategy

- **Migrations:** append-only, numbered, immutable. A migration that has
  run in any environment is never edited; a correction is a new
  migration. Each migration is transactional where PostgreSQL allows it,
  records its checksum, and is applied by the migrator role under an
  advisory lock, on the direct endpoint only (never a pooled endpoint),
  with `sslmode=require` for Neon.
- **Grants:** `db/runtime-grants.sql` is part of the migration run, not a
  manual follow-up. It revokes, then grants, so re-running it is safe.
  Skipping it breaks every runtime query, including security-definer
  functions, because it also grants schema usage — this was the most
  probable root cause of the earlier Neon failure, and the migrator now
  applies it automatically.
- **Seeds:** there is no production seed and no demo data. Development
  data is created through the application's own registration, invitation,
  and creation flows, so that seed data can never diverge from the
  application's validation and authorization. Test fixtures are created
  by the integration tests themselves, against a disposable database
  only, and are dropped with that database.
- **Rollback:** a failed migration fails the run and leaves the ledger
  unchanged for that migration. There is no automatic schema rollback;
  a bad migration is fixed by a new, forward migration, reviewed as a
  schema change.

## 9. Backup and recovery considerations

These are deployment responsibilities, not application code, and they are
currently unverified in production. They are recorded here so that a
deployment cannot claim to be complete while they are missing.

- **Database backups:** scheduled, tested restores of the PostgreSQL
  database, including the `nexora` schema and its RLS policies, functions,
  and grants. A backup that restores tables but not policies or grants is
  not a valid restore. **Verified 2026-10-26 on disposable databases**
  (repeatable script at
  `~/workspace/nexora-restore-test/restore-test.sh`): counts, RLS,
  functions, grants, and FORCE RLS all survived a `pg_dump` /
  `pg_restore` cycle, and the production build passed health, login,
  and a signed download against the restored database. **The dump
  must run as a superuser or another BYPASSRLS role, not as the
  migrator:** `notifications` has FORCE ROW LEVEL SECURITY, so even
  its owner cannot COPY it out and a migrator-role `pg_dump` fails;
  the superuser dump still records the migrator as owner, so the
  restore keeps ownership. A migrator-role backup job silently
  fails and must not be used.
- **File backups:** the private file directory must be backed up with the
  database, and the two must be restorable to a consistent point: a
  `task_files` row without its bytes, or bytes without their row, is a
  data-integrity failure. The 30-day purge and 24-hour orphan cleanup
  must not run against a backup being restored.
- **Recovery order:** restore the database, re-apply the migrator (which
  re-applies grants), restore the file directory, then verify with the
  health endpoint and a signed-download check. Do not restore by hand-editing
  grants or policies.
- **Retention:** audit events are retained for security and compliance
  and are not purged by the file cleanup. Project deletion is designed and
  implemented (soft delete with immediate invisibility, 30-day purge,
  audit retained indefinitely); organization deletion is implemented
  2026-10-26 on the same pattern, with the organization row retained
  as a tombstone because its audit rows forbid hard deletion (see the
  organization purge note above); account deletion, data export, and
  lifecycle policies for other tables remain future work (see
  `IMPLEMENTATION_PLAN.md`).
