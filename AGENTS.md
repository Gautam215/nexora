# Nexora — Coding Rules for Agents

This file is the Nexora project's own `AGENTS.md`. It lives at the
repository root and it governs work on this codebase. It isn't the
assistant's personal operating manual, and it doesn't override the
user's instructions.

Source of truth, in order: the Nexora PRD, `DESIGN.md`, `ARCHITECTURE.md`,
`DATABASE.md`, `API.md`, and this file, then `docs/prd-traceability.md`
and `docs/threat-model.md` as history. If a document and the shipped code
disagree, stop and resolve the disagreement before building on it. Don't
silently follow the document, and don't silently follow the code either.

## 1. Inspect before changing anything

- Read the relevant existing code, its tests, and its migration before
  changing it. An unfinished-looking feature might be fine. Check what it
  actually does first, don't just assume it's broken.
- Check the branch and the working tree first. Preserve uncommitted work.
  Never discard a user's change just to make a diff look cleaner.
- Run the baseline (`npm run check`) before a change, and again after
  each meaningful fix. That way, if something new fails, you can point
  at the change that caused it.

## 2. Code quality and naming

- TypeScript, strict, no `any` where a real type exists. A type error is
  a build failure. It's not a warning you get to suppress.
- Names say what a thing is, not how it is implemented: `withOrganizationContext`,
  not `withTenant`; `task_files`, not `attachments_v2`. A rename is a
  separate, deliberate change. Never smuggle one into a feature diff.
- Functions do one thing. A route handler authenticates, validates,
  calls business logic, and returns. It doesn't also build SQL, send
  email, and format a response from scratch. That stuff lives in
  `src/server/`, `src/security/`, and the shared API helpers.
- No dead code, no commented-out code, no placeholder links, no fake
  forms, no invented metrics. If a value does not exist, the UI says
  "no data". Simple as that.

## 3. Project and folder structure

- Pages under `src/app/`, components under `src/app/components/`, API
  routes under `src/app/api/`, server logic under `src/server/`,
  validation and security under `src/security/`, migrations under
  `db/migrations/`, scripts under `scripts/`, tests under `tests/`.
- A new resource gets its route, its Zod schema, its server logic, its
  migration (if the schema changes), and its tests in the same change.
  A route without a schema, or a schema without a test, is incomplete.
  Half the set doesn't count.
- A new screen reuses an existing component before creating one, and
  follows `DESIGN.md` tokens and patterns. Don't introduce a component
  library, a CSS framework, or a webfont without a documented decision.

## 4. Component reuse

- Reuse the shared auth shell, workspace pages, project navigation, and
  notification centre. Don't build a second shell for a new auth page
  or a second project nav for a new project screen. We've already got
  one, use it.
- Reuse the shared JSON helpers (`jsonOk`, `jsonError`,
  `jsonServerFailure`), the origin check, and the tenant-context helpers.
  No route builds its own envelope, its own request ID, or its own
  authorization check.
- Reuse existing patterns for loading, empty, error, and
  permission-denied states. A new screen defines all four before it ships.

## 5. Dependency management

- Don't add a dependency without a reason that cannot be met by the
  existing stack. The current dependencies are Next.js, React, `pg`,
  Zod, Nodemailer, `server-only`, Biome, and TypeScript tooling. That
  list is intentionally short, and it stays that way on purpose.
- Don't add Redis, a queue, a WebSocket library, an AI SDK, or an
  object-storage SDK until its design exists in `ARCHITECTURE.md` and
  its authorization and failure handling are specified. Don't introduce
  Convex or change the database architecture to use a tool that happens
  to be installed.
- Pin versions as the project does today, and run `npm audit` after a
  dependency change. A new vulnerability is a finding, not a note.

## 6. Type safety

- Strict TypeScript everywhere, including tests. `tsc --noEmit` must
  pass. A `@ts-expect-error` or a cast to `any` needs a comment saying
  why the real type cannot be expressed, and must not be used to hide a
  real mismatch.
- Zod schemas are the runtime boundary: every API input, every webhook
  payload, and every AI structured output is validated by a schema
  before it is trusted. A TypeScript type alone is not runtime validation.
  Types disappear at runtime. Schemas don't.
- Database rows are typed at the boundary where they are read, not
  passed around as untyped objects.

## 7. Error handling

- Return the shared error codes in `API.md`. Never return a database
  error, a stack trace, a file path, or a secret to the client. None of
  that leaves the server.
- Log server-side with structure: operation, request ID, error name,
  and a validated database code where present. Never log a password,
  token, key, or file-link query parameter.
- A serialization conflict (`40001`) is a 409 with a refresh-and-retry
  message, not a 500. A missing configuration fails closed (503), not
  silently degraded.
- Don't weaken validation, remove a test, or catch-and-ignore an error
  to make a build pass. Investigate the failure. If it cannot be fixed
  safely, document the exact cause and evidence and stop.

## 8. Security and secrets

- Never hardcode a secret, a password, a token, or a connection string.
  Never commit `.env.local` or any file containing a credential. Never
  paste a credential into a chat message, a report, or a test fixture
  that will be committed.
- Never trust the client: no role, user ID, organization ID, or tenant
  from a request body, query string, or header is trusted. Identity comes
  from the verified session; authorization comes from
  `withOrganizationContext` and RLS.
- Never expose a secret client-side, in a URL that a user can share, in
  a log, or in an error message. Signed file links are the one exception,
  and they are time-limited (five minutes) and bound to one user, tenant,
  task, file, and version.
- File uploads are validated by extension, declared MIME, and file
  signature/content, in that order, before storage. The order matters,
  so don't shuffle it. A filename from a user is never used as a storage
  path.

## 9. Database and API access

- All queries are parameterized. No string-interpolated SQL, ever.
- All tenant access goes through `withOrganizationContext` (or
  `withUserContext` for personal data) and RLS. A direct pool query for
  tenant data, outside a tenant transaction, is a bug. Call it that.
- Migrations are numbered, immutable, and append-only. A migration that
  has run anywhere is never edited; a correction is a new migration.
  Every migration records its checksum, and the migrator applies
  `db/runtime-grants.sql` in the same run, never as a manual follow-up.
- The migrator runs on the direct endpoint only, never a pooled endpoint,
  and with `sslmode=require` for Neon. The migrator refuses otherwise;
  do not work around that refusal.
- New tables get RLS, grants, indexes for their real queries, and
  integration tests for cross-tenant denial in the same change.
- API changes are backward-compatible or versioned with a documented
  deprecation policy. Don't break a client silently, and don't change
  a response shape without updating `API.md` in the same change.

## 10. Testing

- `npm run check` (lint, typecheck, tests) and `npm run build` are the
  gates. A change that breaks either is not finished. Doesn't matter
  how close it looks.
- Unit and schema tests always run. Integration tests run against a
  disposable database only and skip otherwise; a skip is reported as a
  skip, never as a pass, and never as a reason to weaken a test.
- A new feature adds tests for its happy path, its authorization
  boundaries (including cross-tenant denial), its validation failures,
  and its loading, empty, and error states, where those apply.
- Don't modify production behaviour just to make a test pass, and don't
  delete or weaken a test to hide a regression. If a test is wrong,
  say why and fix the test with evidence, in a separate, reviewed change.

## 11. Documentation

- A behaviour change updates the document that describes it in the same
  change: a UI change updates `DESIGN.md`, a stack or flow change
  updates `ARCHITECTURE.md`, a schema change updates `DATABASE.md`, an
  endpoint change updates `API.md`, and a phase completion updates
  `IMPLEMENTATION_PLAN.md` and `docs/prd-traceability.md`.
- Documentation states what is verified and what is not. "Implemented"
  means code exists; "verified" means a test, a live check, or a
  production check proved it. Don't upgrade one to the other without
  evidence. They're different claims.
- A document that describes a future capability must say it is future
  work, in the same paragraph, not in a footnote.

## 12. Git and change discipline

- Don't commit or push unless the user explicitly authorizes it, for
  that change, in that message. A general instruction to "continue work"
  is not a push authorization.
- Keep a change focused: one feature or fix, its tests, and its
  documentation. Don't rewrite unrelated code, reformat unrelated
  files, or smuggle a second feature into a fix.
- Review the diff before reporting a change as done. Check for secrets,
  for unrelated files, for a test that was weakened, and for a document
  that was not updated.
- Never make a destructive database change, and never run a production
  migration, without explicit authorization for that database, that
  migration, and that run.
