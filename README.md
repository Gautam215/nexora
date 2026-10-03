# Nexora

Nexora is a new application built against `../uploads/nexora_prd_download.pdf` as its product contract. The existing `../reelscape` project is unrelated and is intentionally untouched.

## Current State

Nexora has real account and organization workflows plus PostgreSQL-backed projects, milestones, tasks, Kanban, task activity, append-only comments, mentions, notifications, private task attachments, permission-aware workspace Search, and a project analytics dashboard. Owners/admins can invite verified-email-bound workspace members, revoke invitations, change roles, and disable or restore membership; project managers can manage project details and access without changing workspace membership. Project/work-item workflows use PostgreSQL, RLS, optimistic versions, transactions, audit events, and idempotent creation. Search covers visible projects, active tasks, comments, active members and active file names; its full-text indexes are in `0013_authorized_search.sql`. Project analytics are calculated from authorized task, milestone, membership, and audit data without a schema migration. Migrations `0011`–`0016`, runtime grants, and database-backed collaboration/Search/analytics checks have been verified locally against PostgreSQL 16; the full test suite, typecheck, and production build pass. This is local verification only, not production-readiness evidence. AI, realtime, and production operational controls remain future work.

See:

- `docs/prd-traceability.md` for status against every PRD section and the next phases.
- `docs/architecture.md` for current choices and boundaries.
- `docs/threat-model.md` for threats, controls, verification, and residual risk.

## Local Requirements

- Node.js 22 or newer.
- PostgreSQL 16 or newer.
- Separate PostgreSQL roles for migrations and runtime. The runtime role must not own tables and must not have `SUPERUSER`, `BYPASSRLS`, or `CREATEROLE`.

Install the pinned dependencies, provision the two roles, and apply `db/runtime-grants.sql` as the migration owner. `MIGRATOR_DATABASE_URL` must use the migration role; `DATABASE_URL` must use the restricted runtime role. Copy `.env.example` to a local-only environment file and replace its placeholders. Never use a production credential in local development.

Set `APP_ORIGIN`, a random `AUTH_RATE_LIMIT_HMAC_KEY` (at least 32 bytes), and working SMTP values before using account flows. Email delivery requires TLS by default. In production, also set `NEXORA_TRUSTED_CLIENT_IP_HEADER` to a single-IP header overwritten by the trusted ingress; the application deliberately fails closed if it is missing or invalid. Do not trust a client-supplied `X-Forwarded-For` chain.

Private task attachments use a server-only filesystem directory (`NEXORA_PRIVATE_FILE_DIR`, default `.private-files`) and a separate signing key (`NEXORA_FILE_SIGNING_KEY`, at least 32 random bytes). Keep the directory outside `public/`, persist and encrypt it at rest in deployments, and mount the same directory for the app and cleanup process. Signed download links expire after five minutes. Uploads accept PDF, plain text, Markdown, CSV, JSON, PNG, JPEG, GIF, and WebP after extension, declared MIME, and content checks; each file is limited to 10 MB, with at most 20 active attachments and 100 MB per task. Files are downloaded as attachments, never rendered inline. Deleted files become inaccessible immediately and are physically purged after 30 days.

Commands:

```sh
npm install
npm run db:migrate
npm test
npm run typecheck
npm run dev
```

Schedule `npm run files:cleanup` at least daily using the runtime database role and the same private storage mount. It permanently deletes files past the 30-day retention window and removes unreferenced storage objects older than 24 hours. The filesystem backend is private to this deployment; production must provide durable encrypted storage, and multiple app instances must share that storage. Malware scanning is optional in the PRD and is not configured; do not process uploaded documents as trusted input.

To run PostgreSQL integration tests, apply all migrations to a disposable test database and set `NEXORA_TEST_DATABASE_URL` to that database using the restricted runtime role. Keep it separate from `DATABASE_URL`; tests create records and may leave them behind. Never point it at production or other persistent data.

```sh
MIGRATOR_DATABASE_URL="postgresql://nexora_migrator:...@localhost:5432/nexora_test" npm run db:migrate
NEXORA_TEST_DATABASE_URL="postgresql://nexora_app:...@localhost:5432/nexora_test" npm test
```

The migration runner serializes concurrent runs with a PostgreSQL advisory lock, applies each migration transactionally, records a SHA-256 checksum, and refuses edits to an applied migration. Add a new numbered migration for every schema change. The lockfile and a clean dependency audit are present, but must be checked again before deployment.

## Tenant Access Rule

Tenant-aware server code must derive `userId` from a verified server-side session, then use `withOrganizationContext(userId, organizationId, callback, minimumRole)`. That function starts a transaction, sets transaction-local identity, reads only the caller's own membership, rejects missing/inactive/insufficient membership, and only then sets the organization context and invokes the callback. Do not accept a user ID or role from request data. Use parameterized SQL only.

The database runtime role is a separate principal from the migration owner. RLS is a defense-in-depth boundary, not a substitute for authorization in application services. Tenant-aware server code must derive identity only from a verified session. Initial owner membership and the `organization.created` audit event share the organization-creation transaction.

Authentication cookies are host-only, `HttpOnly`, `SameSite=Strict`, and `Secure` in production; only SHA-256 token hashes are stored for sessions and email links. Invitation acceptance requires the verified address matching the invited address; the one-time token is removed from the URL and kept in tab-scoped storage during sign-in. Mutation APIs require the canonical origin and reject cross-site Fetch Metadata. Apply the same sequence to every new tenant feature: schema and RLS first, then authorization-aware APIs, integration tests, and user-facing UI. The current project API is covered by its project schema, project-level RLS, and live PostgreSQL tests.
