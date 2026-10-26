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
- **No background jobs in code:** The only scheduled operation that exists
  is the file-retention/orphan cleanup script (`scripts/cleanup-task-files.mjs`),
  which the operator must run daily. It is not scheduled by the repository,
  and that gap is recorded in the implementation plan.

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
- **Missing (not yet built):** OAuth implementation, organization
  settings and deletion, project and milestone deletion. Logged-in
  password change, active session list, and revoke-all are built (API
  and `/account` UI); OAuth is documented below as a proposal only and
  must not be implied by UI that does nothing.

## 7.1 OAuth — IMPLEMENTED 2026-10-26 (local, unpushed)

This section was the approved design and is now the implemented
design: the provider module (`src/server/oauth/`), the three
endpoints, migration 0032, and the sign-in / account UI exist and
are tested (unit + mock-IdP integration). The design reuses the
existing session model exactly; it does not introduce an identity
framework. Live Google verification is still blocked on client
credentials: no real Google sign-in has been exercised, only a
local mock IdP.

**Decisions resolved 2026-10-26 (documentation only; implementation
still pending approval):** the HIGH and MEDIUM risks found in the
2026-10-26 design review are resolved below — disabled-account gate,
strict `id_token` validation, tamper-resistant flow cookie, sign-in /
linking separation, atomic creation with duplicate-email race
handling, provider-email normalization, access-token discard, fixed
callback redirect and error codes, separate IP rate limits, the
RLS / security-definer split in one migration, one Google identity
per user, flag coverage for both endpoints, the loopback exception,
existing validation schemas, and one Google button on the sign-in
page. One deliberate behaviour change from the 2026-10-25 draft is
called out where it lands: the sign-in flow no longer links an
identity to an existing account by email match (see "Sign-in flow"
below). A pre-existing password user adopts Google sign-in through
the signed-in link flow instead.

### Provider selection and rationale

- **First provider: Google only.** Google is an OpenID Connect
  provider: it returns an `id_token` whose `email_verified` claim can be
  checked, it supports Authorization Code flow with PKCE, and its token
  and revocation endpoints are documented. One provider first proves
  the linking model; each additional provider adds a separate callback,
  token handling, and linking edge case, so a second provider is a
  separate, later change behind the same abstraction.
- **No identity framework (no Auth.js/NextAuth).** Nexora already has
  opaque sessions stored as SHA-256 hashes, a single session cookie,
  RLS, and scrypt passwords. An identity framework would replace that
  session model, add its own tables, and duplicate the authorization
  boundary, for a flow that is a few hundred lines of OIDC code when
  built directly. The proposed code is a small provider module in
  `src/server/oauth/` implementing one interface
  (`authorizeUrl`, `exchangeCode`, `verifyIdToken`), never called
  directly by business logic outside that module.
- **No new database framework and no Convex.** The proposed tables
  below are PostgreSQL tables in the existing schema, with the existing
  RLS and grants pattern.

### Authorization Code flow with PKCE

1. The user clicks "Continue with Google" on the sign-in page. That
   button is a form that POSTs to the proposed start endpoint (POST,
   with the existing same-origin check, so a third-party page cannot
   start a login for a victim).
2. The server generates a random `state`, a PKCE `code_verifier`,
   and a `nonce` — each 32 random bytes rendered as 43 base64url
   characters, the same generation pattern as the existing opaque
   tokens (`createOpaqueToken`, 43-character base64url) — and stores
   them plus the validated return path and the flow intent in a
   short-lived, tamper-resistant cookie. The cookie value is
   `base64url(payload) + "." + base64url(HMAC-SHA256(payload))`,
   where the payload is JSON with exactly these fields: `v` (1),
   `state`, `verifier`, `nonce`, `next` (the `safeReturnPath` result,
   or `/workspaces`), `intent` (`"signin"` or `"link"`), and
   `linkUserId` (the signed-in user's UUID when `intent` is
   `"link"`, otherwise `null`). The HMAC key is a dedicated
   server-only secret, `OAUTH_FLOW_SIGNING_KEY` (at least 32 bytes,
   same minimum as the other server secrets); it is never the
   rate-limit key or the file-signing key, because key reuse across
   purposes would let a compromise in one purpose forge flows in
   another. If OAuth is enabled and this key is missing, the start
   endpoint fails closed (see "Feature flag and missing credentials"
   below) instead of issuing an unsigned flow cookie. Cookie
   attributes: `HttpOnly`, `SameSite=Lax` (Lax, not Strict, because
   the callback is a top-level GET navigation from the provider),
   `Secure` in production, `Path=/api/auth/oauth` (the narrowest
   path covering both the start and callback routes, so the flow
   values are not sent to any other route), no `Domain` attribute,
   and the `__Host-` prefix in production
   (`__Host-nexora_oauth_flow`; plain `nexora_oauth_flow` in
   development, mirroring the session cookie's naming), which binds
   the cookie to the host that set it and blocks subdomain cookie
   tossing. The cookie is deleted on the callback, success or
   failure, so a flow can be used at most once. A malformed cookie,
   a bad HMAC, a missing field, or an unknown `intent` is rejected
   with a generic error before any token exchange, and the cookie is
   deleted. Starting a second flow in the same browser overwrites
   the flow cookie, so the first flow's callback will fail its state
   check — only one OAuth flow per browser at a time is supported,
   and this limitation is documented here rather than silently
   supported.
3. The server redirects to Google's authorize endpoint with
   `response_type=code`, `scope=openid email profile`,
   `code_challenge` (S256 of the verifier), `code_challenge_method=S256`,
   `state`, `nonce`, and an exact `redirect_uri`.
4. The callback is a GET to the proposed callback endpoint. It does
   NOT use the same-origin check (the provider is cross-origin by
   design); its defences are the state, the PKCE verifier, and the
   exact redirect URI, as specified below.
5. The server exchanges the code at Google's token endpoint,
   server-side only, with the client secret from the environment. The
   secret never reaches the browser, is never logged, and is never in
   a URL.
6. The server verifies the `id_token` strictly, and any failure is
   a generic sign-in error; no provider error detail is shown to
   the client. All of these must hold, or the token is rejected:
   - **Algorithm allowlist:** the JWT header `alg` must be exactly
     `RS256`. `none`, `HS256`, and every other algorithm are
     rejected, even if a key could verify them — accepting `HS256`
     would let an attacker forge a token with Google's public key
     as an HMAC secret, and `none` needs no key at all. The header
     `kid` must be present and non-empty.
   - **Signature and JWKS:** the signature is verified against
     Google's JWKS key matching `kid`. JWKS keys are cached for at
     most 1 hour. On an unknown `kid`, the server refetches the
     JWKS exactly once and retries; if the `kid` is still unknown,
     the token is rejected. If the JWKS fetch fails (network error,
     non-200, malformed document), verification fails closed: the
     token is rejected and no session is created. Keys are never
     accepted from any source other than Google's JWKS endpoint.
   - **Issuer:** `iss` must be exactly
     `https://accounts.google.com`. Any other value is rejected.
   - **Audience:** `aud` must be a string exactly equal to this
     app's `OAUTH_GOOGLE_CLIENT_ID`. An array `aud`, or any other
     value, is rejected.
   - **Expiry:** `exp` must be in the future, allowing at most 60
     seconds of clock skew; `iat`, if present, must not be more
     than 60 seconds in the future. An expired token is rejected.
   - **Nonce:** `nonce` must match the flow cookie's `nonce`
     exactly.
   - **Verified email:** `email_verified` must be exactly the
     boolean `true`. Missing, `false`, or any non-boolean value is
     rejected — an unverified provider email is not evidence of
     ownership, and a missing claim must fail closed, not default
     to trusted.
   - **Subject and email shape:** `sub` must be a non-empty string
     (at most 256 characters), and `email` must be a non-empty
     string that passes the normalization and validation in
     "Provider email" below before it is used for anything.
7. The server applies the sign-in or linking rules below, depending
   on the flow cookie's `intent`. A sign-in (`intent="signin"`) is a
   normal sign-in, like a password sign-in: it creates exactly one
   new session with the existing `createSession()` and
   `setSessionCookie()` (14-day, `HttpOnly`, `SameSite=Strict`,
   `Secure` in production, `__Host-` prefix in production) and
   keeps other sessions. It does not revoke other sessions (that
   behaviour belongs to password reset and password change, where a
   credential is known to have changed). A link
   (`intent="link"`) creates no new session at all (see "Link
   flow" below). In both flows, before any session is created, the
   account gate in "Account gate" below must pass; a disabled
   account never receives a session through OAuth.

### Callback, state validation, and error handling

- **State:** must match the flow cookie exactly, must not be expired
  (10 minutes), and is single-use (the cookie is deleted on first
  callback, even on failure). A missing, mismatched, or reused state
  is a generic sign-in error, not a provider error passthrough.
- **Provider errors:** if the callback carries `error`
  (`access_denied`, `invalid_request`, or any other value), the user
  is shown the sign-in page with a generic message ("Sign-in with
  Google did not complete. Try again or sign in with your password."),
  and the flow cookie is deleted. The provider's error value is logged
  server-side only, with the operation and request ID, never with a
  code, token, or email.
- **Token-exchange failures:** network failure, invalid grant, or
  invalid `id_token` all produce the same generic sign-in error and
  the same server-side log shape as other authentication failures.
- **Replay protection:** state, PKCE verifier, and nonce are all
  single-use and short-lived; the authorization code itself is
  single-use at Google. A replayed callback (same state, same code)
  fails at the state check before any token exchange, so it cannot
  create a second session.

### Account linking and account-takeover prevention

Linking is keyed by the provider subject (`sub`), not by email.
The proposed `oauth_identities` table (below) stores
`(provider, provider_subject)` as the unique key, and
`provider_email` is never a lookup key and never a linking key: it
is informational only, it has no unique constraint, and no query in
either flow looks an identity up by email. Sign-in and linking are
separate flows, distinguished by the flow cookie's `intent`
(see step 2 above). At most one Google identity per Nexora user is
allowed initially, enforced by `UNIQUE(user_id, provider)` (see
"Proposed database changes" below).

### Provider email

Before the provider email is used for anything, it is normalized
with the existing `normalizeAuthEmail` (trim, then lowercase) and
validated with the existing email rule from `auth-schemas.ts`
(trim, 3–320 characters, valid email shape, lowercased) — the same
rule registration uses, because `users` enforces the normalized
form (`users_email_normalized` CHECK) and the 3–320 length CHECK.
A provider email that fails normalization or validation is a
generic sign-in error, never a 500 from a CHECK violation. The
normalized email is what is stored on the identity row and what is
compared with `users.email`; the raw `id_token` email is never
stored and never compared.

### Account gate

Before any session is created in either flow, the target account
must pass the same gate password login applies (see the login
route): `status` must be `"active"` and `email_verified_at` must
be set. A disabled account never receives a session through OAuth,
even with a valid, verified Google token — otherwise OAuth would
be a way to revive an account that was deliberately disabled.
A failed gate is a generic sign-in error (or, for a link flow, the
link error in "Callback redirect and error codes" below); it never
reveals whether the account is disabled, unverified, or missing.

### Sign-in flow (`intent="signin"`)

1. Look the identity up by `(provider, provider_subject)` only
   (see "Pre-auth lookup" below). If it is found, run the account
   gate for its user, update `last_used_at` (and `provider_email`
   if the provider email changed, per "Provider email changes
   later" below), and create exactly one new session. Other
   sessions are kept.
2. If no identity is found and the provider email is verified
   (`email_verified` exactly `true`): check whether any Nexora
   user already has the normalized email.
   - If no user has it, create a new user and its identity row
     atomically (see "Atomic creation and duplicate-email races"
     below). `display_name` comes from the provider profile
     through the existing registration name rule (trim, 1–120
     characters; fallback: the email local part if the profile
     name is empty after trimming). `email_verified_at` is set to
     now, because the provider verified the email.
     `password_hash` is NULL (see schema changes below). Then
     create exactly one new session.
   - If a user already has it, **do not link and do not create.**
     This is a deliberate change from the 2026-10-25 draft, which
     linked on a verified-email match: the sign-in flow now never
     creates a link from an email match, because email is never a
     linking key. Creating would violate `users_email_unique`,
     and linking by email alone would reintroduce the
     takeover surface this design exists to close. The user gets
     the generic sign-in error with an actionable, non-revealing
     message (see the error-code table below): sign in with their
     password first, then link Google from Account security.
     Note on enumeration: this branch is only reachable with a
     Google account whose verified email the caller already
     controls, so it discloses nothing about an address the
     caller does not own.
3. If the provider email is NOT verified, never create an account,
   never link, never sign in. Show the generic sign-in error and
   offer password sign-in. An unverified provider email is not
   evidence of ownership.

### Link flow (`intent="link"`)

The link flow is started only by a signed-in user, via a POST with
the existing same-origin check, after explicit confirmation on the
account page. The flow cookie's `linkUserId` is the user_id of the
session that started the flow.

1. At the callback, the current session's user_id must equal
   `linkUserId`, or the link is aborted with a generic error and
   no identity is created. This covers the case where the user
   signed out (or another user signed in) on the same browser
   between start and callback: without this check, the provider
   could be linked to the wrong account.
2. Look the identity up by `(provider, provider_subject)` only.
   - If it is already linked to the same user, treat it as
     already-linked: no duplicate insert (the unique constraints
     would reject one), no new session, redirect to `/account`.
   - If it is linked to a different user, refuse with a generic
     message that does not reveal that the other account exists.
3. If no identity is found, enforce the one-identity rule first:
   if the signed-in user already has a Google identity (a
   different `sub`), refuse — one Google identity per user
   initially — with a clear message on `/account` (this message
   is about the user's own account, so it reveals nothing to
   anyone else).
4. Then apply the squatting guard: the provider email must either
   match the signed-in user's `users.email` or belong to no
   Nexora account at all. If it belongs to a different Nexora
   account, refuse with a generic message that does not reveal
   that the other account exists. Here email is only a guard
   against squatting on another user's address; it is still never
   a lookup key and never creates the link by itself.
5. On success, insert the identity row and redirect to `/account`.
   **No new session is created by a link flow.** The user is
   already signed in; creating a session they did not ask for
   would add an unexplained session to their `/account` list.
   If the session is gone at callback time, the link is aborted
   and the user is sent to `/login` with a generic error code.

### Atomic creation and duplicate-email races

User creation and identity insertion happen in a single
transaction, following the registration pattern (a new UUID with
`withUserContext(newId)`, user insert plus identity insert, then
commit) — never as two separate commits, so a crash between them
cannot leave a passwordless user with no identity. If the
transaction fails on a duplicate-email unique violation (two
callbacks racing for the same new address), it is a recoverable
conflict, not a 500: re-look the normalized email up, and if a
user now exists with it, fall back to the sign-in flow's
email-taken branch (generic error guiding to password sign-in and
linking from Account security). If the re-lookup finds nothing,
return the generic sign-in error. The same rule applies to a
duplicate `(provider, provider_subject)` violation in either flow:
re-look the identity up and proceed as if it had been found
(already-linked for the same user, refused for a different user),
never a 500. If identity insertion commits but session creation
then fails, the user gets a generic error and a retry signs them
in through the existing identity — that state is recoverable by
design, not a broken account.

- **Never merge two existing Nexora accounts automatically.** If two
  accounts exist, they stay separate; merging is a manual,
  out-of-scope process, not a callback side effect.
- **Provider email changes later:** a later OAuth sign-in is looked
  up by `(provider, sub)`, not by email. If the provider email has
  changed, `provider_email` on the identity row is updated, but
  `users.email` is NOT changed automatically — `users.email` is the
  workspace identity and changing it would affect memberships.
  Changing a Nexora email address is a separate future feature.
- **Unlinking (future, not in this design):** unlinking a provider
  must require that the account still has a way to sign in (a password
  set, or another linked provider). An account must never be left
  with no sign-in method by an unlink action.

### Access token

Google's token endpoint also returns an `access_token`. The design
does not request offline access (`access_type` is never set to
`offline`, so no `refresh_token` is issued), and the `access_token`
is discarded immediately after the `id_token` is verified: it is
never stored in the database, the session, or a cookie, never sent
to the browser, never logged, and never used for Google APIs.
Only the verified `id_token` claims (`sub`, normalized email,
`email_verified`, profile name) are used, and only for the account
decisions above.

### CSRF, redirect, secrets, rate limits

- **CSRF:** the state value and PKCE verifier are the callback CSRF
  defence (the callback cannot use the same-origin check, as above).
  The start endpoint is a POST with the existing same-origin check.
  The link start endpoint is likewise a POST with the same-origin
  check, and it additionally requires a valid session.
- **Redirect URI validation:** the redirect URI is derived from
  `APP_ORIGIN` plus the fixed callback path, never from user input,
  and must match exactly the URI registered in the Google console.
  No wildcards, no query-string redirects. The return path after
  sign-in (`next`) is validated with the existing
  `safeReturnPath()` and stored in the flow cookie at start time; a
  `next` value in the callback query is ignored.

### Callback redirect and error codes

The callback never returns HTML or JSON: it always answers with a
fixed 302 redirect, with the session cookie (sign-in success only)
set on that redirect response. That way the authorization code
never stays in the address bar and never reaches a rendered page,
where it could leak through a link, a copy, or a third-party
resource. Redirect targets: sign-in success goes to the flow
cookie's `next` (already validated by `safeReturnPath` at start
time) or `/workspaces`; link success goes to `/account`; every
failure goes to `/login` (sign-in flow, or link flow with no valid
session) or `/account` (link flow with a valid session), with
exactly one allowlisted error code in the query string. The
receiving page renders only the fixed message for that code from
the table below; it never echoes a query value, and the provider's
error text is never shown and never put in the URL.

| Code | Shown message | Used when |
| --- | --- | --- |
| `oauth_failed` | "Sign-in with Google did not complete. Try again or sign in with your password." | Any generic callback failure: bad state, bad PKCE, token-exchange failure, `id_token` rejection, account-gate failure, atomicity fallback, missing credentials at callback time. |
| `oauth_denied` | "Google sign-in was not completed. Try again or sign in with your password." | The provider returned `error=access_denied` (the user cancelled at Google). Any other provider `error` value maps to `oauth_failed`, never to a distinct code. |
| `oauth_expired` | "The Google sign-in expired. Start again from the sign-in page." | Flow cookie missing, expired (10 minutes), or already used. |
| `oauth_already_linked` | "This account already has a Google sign-in linked." | Link flow only: the signed-in user already has a Google identity. Shown on `/account`, about the user's own account, so it reveals nothing to anyone else. |
| `oauth_email_taken` | "That email already has a Nexora account. Sign in with your password, then link Google from Account security." | Sign-in flow only: the provider email already belongs to a Nexora user, so no link is created by email match (see "Sign-in flow"). |

- **Referrer-Policy (explicit decision):** the callback response
  must carry `Referrer-Policy: no-referrer`, so no Referer is sent
  on the redirect that follows it. This is defence in depth on top
  of the 302-only shape above: even if a future change rendered
  something at the callback URL, the authorization code in its
  query string could not leak through a Referer header. The header
  is required on the callback response only; it is not a global
  header change in this design.

- **Secrets:** `OAUTH_GOOGLE_CLIENT_ID` is public (it appears in the
  authorize URL); `OAUTH_GOOGLE_CLIENT_SECRET` and
  `OAUTH_FLOW_SIGNING_KEY` are server-only, environment-only,
  never in code, never in a URL, never logged, and never sent to
  the browser. Rotation is an environment change plus a restart:
  existing sessions are unaffected, in-flight OAuth flows fail and
  must be restarted (acceptable, 10-minute window).

### Feature flag and missing credentials

- **Feature flag:** OAuth is disabled by default
  (`OAUTH_GOOGLE_ENABLED=false`). When disabled, **both** the
  start and the callback endpoints return 404, so neither endpoint
  can be probed while the feature is off. A disabled callback does
  not redirect with an error code — it 404s, exactly like a
  disabled start.
- **Missing credentials fail closed, without redirecting to
  Google.** Credentials are checked at request time (consistent
  with how the rate-limit key is checked on use, not at process
  startup). If OAuth is enabled but `OAUTH_GOOGLE_CLIENT_ID`,
  `OAUTH_GOOGLE_CLIENT_SECRET`, or `OAUTH_FLOW_SIGNING_KEY` is
  missing, the start endpoint returns 503 (missing configuration
  fails closed, per the project rules), and the callback returns
  the generic sign-in error redirect (`oauth_failed`) rather than
  a 503 page, because the user is mid-flow. In neither case is
  the user redirected to Google with a missing client ID.

### Rate limits

Start and callback have **separate** IP rate limits, because they
are different attack surfaces: start is cheap to call, callback
is where state-guessing floods land, and a shared scope would let
one surface consume the other's budget. Each limit is **60
requests per IP per 15 minutes (900 seconds)** as the initial
proposal, subject to a compatibility review against the existing
rate-limit rules before implementation (see below). Neither limit
has a per-email component, because no email exists yet at start
time and the callback email is provider-supplied, not user-typed:
login's per-email limit (10 per 900 seconds) has no equivalent
here, and "rate-limited like login" is therefore not an accurate
description — only login's IP limit (60 per 900 seconds) is
comparable. Compatibility: the proposed 60 per 900 seconds fits
the existing mechanism exactly — `consume_auth_rate_limit`
(scope, subject hash, max attempts, window) with the existing
1000-attempt cap and 900-second window, and the same trusted-IP
header rule (`NEXORA_TRUSTED_CLIENT_IP_HEADER`, required in
production, IP limit bypassed in development exactly as for
login). Because the existing helpers (`isRateLimited`,
`isTokenRateLimited`) both require an email or token subject,
implementation needs one small IP-only helper that calls the
existing `consumeIpLimit` path with the new scope — a new call
shape on the existing mechanism, not a new mechanism, and it must
not bypass any existing protection. On start, a exceeded limit
returns 429 with `Retry-After: 900`, exactly like login's
rate-limit response; on callback, an exceeded limit returns the
generic sign-in error redirect (`oauth_failed`), not a distinct
429, so the limit itself does not become an oracle. The callback
is additionally bounded by single-use state, which already makes
a replayed callback fail before any exchange.

- **Production origin:** `APP_ORIGIN` must be HTTPS in production.
  This is already required for the `Secure` session cookie, and it
  is a hard requirement for the OAuth redirect URI. **Loopback
  exception (development only):** a production build running on a
  loopback origin (`localhost`, `127.0.0.1`, `::1`) over HTTP is
  permitted for local development, matching the existing
  `hasSameOrigin` loopback exception and Google's own allowance
  for `http://localhost` redirect URIs. A remote HTTP
  `APP_ORIGIN` in production is a misconfiguration: OAuth must
  fail closed there (start returns 503, callback returns the
  generic sign-in error), never redirect to Google from a remote
  HTTP origin.

### Database changes — APPLIED in migration 0032

All of the changes below landed in **one append-only migration**
(0032) plus the matching `db/runtime-grants.sql` update in the
same change, never as a manual follow-up and never by editing an
existing migration. The migrator applies `runtime-grants.sql`
automatically in the same run, so no manual GRANT step is ever
needed. The migration was tested on a disposable database first,
and it must not run on production without a separate authorization
for that database, that migration, and that run. One grant change
beyond the design's list proved necessary in implementation: the
`users` INSERT grant gained `email_verified_at`, because OAuth
creation sets it at insert time (the provider verified the email),
unlike registration, which verifies later.

- **`oauth_identities` (new table):** `id uuid` (primary key),
  `user_id uuid` (FK to `users(id)`, ON DELETE CASCADE — deleting
  a user deletes their identities, which is correct because an
  identity without a user cannot sign in; note that user deletion
  itself does not exist yet and `user_sessions` uses ON DELETE
  RESTRICT, so CASCADE here is a statement about identity
  lifetime, not a new deletion feature), `provider text`
  (CHECK: initially only `'google'`), `provider_subject text`
  (non-empty, at most 256 characters, matching the `id_token`
  validation), `provider_email text` (normalized, 3–320
  characters; **no unique constraint** — see below),
  `created_at timestamptz NOT NULL DEFAULT now()`,
  `last_used_at timestamptz`. Constraints: `UNIQUE(provider,
  provider_subject)` (the identity key) **and**
  `UNIQUE(user_id, provider)` (at most one Google identity per
  user initially). Index on `user_id` for the one-identity check
  and for `/account` listing. `provider_email` is deliberately
  non-unique: it is informational only, it is never a lookup key,
  and a provider email change that happens to match another
  user's email must not fail the identity update.
- **RLS / security-definer split (decided, not left open).** The
  two access patterns in this design need two different
  mechanisms, and the migration must provide both:
  - **Pre-auth lookup by subject** (callback, before any session
    exists) cannot use RLS, because there is no user context yet
    — an RLS `select_self` policy would deny it. It therefore
    goes through a new SECURITY DEFINER function,
    `lookup_oauth_identity(provider, provider_subject)`,
    following the existing `lookup_user_for_login` pattern
    (`STABLE`, `SECURITY DEFINER`, `SET search_path = pg_catalog,
    nexora`). It returns the **minimal** result the callback
    needs for the account gate and nothing more: `user_id`,
    `status`, and `email_verified_at`. It never returns `email`,
    `display_name`, or `password_hash`, and it is the only way
    the callback learns a user_id from a subject.
  - **Creation and linking** (signed-in link flow, and the
    creation transaction) follow the registration pattern:
    `withUserContext` plus RLS policies on `oauth_identities`
    (`INSERT` / `SELECT` / `UPDATE` where `user_id` equals the
    current user id, mirroring `users_insert_self` /
    `users_select_self` / `users_update_self`). The app role
    never reads `oauth_identities` outside one of these two
    paths.
  - RLS is enabled on the table (`ENABLE ROW LEVEL SECURITY`),
    with the policies above; without RLS enabled, the app role
    could read every user's identities, which is exactly what
    the policies exist to prevent.
- **Column-scoped grants (in `runtime-grants.sql`, same change):**
  mirroring the `users` grants pattern, not blanket ALL. App
  role on `oauth_identities`: `SELECT (id, user_id, provider,
  provider_subject, provider_email, created_at, last_used_at)`,
  `INSERT (id, user_id, provider, provider_subject,
  provider_email)`, `UPDATE (provider_email, last_used_at)`, and
  `EXECUTE` on `lookup_oauth_identity`. The migrator role owns
  the table, as with every other table.
- **`users.password_hash` nullable (proposed change):** OAuth-only
  users have no password, so the current `NOT NULL` constraint and
  the `users_password_hash_length` check must be relaxed to allow
  NULL in the same migration (new CHECK: `password_hash IS NULL
  OR length(password_hash) BETWEEN 32 AND 512`). The login code
  already treats a null or malformed hash as a failed verification
  (dummy scrypt work), so a null hash can never sign in by
  password. The alternative — storing a random "unusable" hash —
  is rejected: a fake hash looks like a real password hash,
  invites confusion in audits, and complicates the "set a
  password later" flow, which already works through the existing
  password-reset route once the user has a verified email. No
  other `users` column changes in this design. The migration
  change must also update any migration-guard test that asserts
  the old `password_hash` NOT NULL / CHECK shape, or that test
  will (correctly) fail on the new schema.
- **Rate-limit scopes (same migration):** add both `oauth-start`
  and `oauth-callback` — separate scopes, decided, not "if
  chosen" — to **both** the `consume_auth_rate_limit` function
  allowlist **and** the `auth_rate_limits` table CHECK,
  following migration 0023's lesson that both allowlists must
  change together, or the first rate-limit call fails (22023
  from the function, 23514 from the CHECK).

### Environment variables and operations — IMPLEMENTED

| Variable | Required | Notes |
| --- | --- | --- |
| `OAUTH_GOOGLE_ENABLED` | No (default `false`) | Feature flag; when false, **both** start and callback return 404. |
| `OAUTH_GOOGLE_CLIENT_ID` | Yes, when enabled | Public; appears in the authorize URL. |
| `OAUTH_GOOGLE_CLIENT_SECRET` | Yes, when enabled | Server-only; never logged, never in a URL. Missing while enabled: start 503, callback generic error redirect, never a redirect to Google. |
| `OAUTH_FLOW_SIGNING_KEY` | Yes, when enabled | Dedicated HMAC key for the flow cookie, at least 32 bytes, server-only. Never reuse the rate-limit key or the file-signing key. Missing while enabled: start fails closed (503), no unsigned flow cookie is issued. |
| `APP_ORIGIN` | Already required | Must be HTTPS in production, except loopback origins (`localhost`, `127.0.0.1`, `::1`) over HTTP for local development only. Redirect URI is derived from it. |

Operational notes: register exactly one redirect URI and one
JavaScript origin (`APP_ORIGIN`) in the Google console; test the
redirect-URI mismatch case in staging (Google rejects it before any
code runs, which is the correct failure); rotate the secret by
changing the environment and restarting, with no database change;
log OAuth start/callback success and failure with operation and
request ID only (no tokens, no codes, no emails in logs, following
the existing logging practice); and note that revoking Google access
does NOT automatically revoke Nexora sessions — a user who loses
Google access must still use `/account` session revocation, and a
provider revocation event is not a Nexora sign-out. The
`.env.example` entries (placeholders only, never real values) and
the sign-in page button (see below) were added in the
implementation change. Test-only endpoint overrides
(`OAUTH_GOOGLE_AUTHORIZE_URL`, `OAUTH_GOOGLE_TOKEN_URL`,
`OAUTH_GOOGLE_JWKS_URL`) are honored only outside production, so a
production deployment always talks to Google's real endpoints; they
exist so the mock-IdP integration tests can run without network
access.

### Observability — IMPLEMENTED 2026-10-26 (local, unpushed)

Three endpoints, three distinct purposes:

- `GET /api/health` (liveness, unauthenticated, always 200): a live
  process answers; the `database` field — not the status code —
  reports database state, so a Neon scale-to-zero wake-up does not
  flap a liveness probe.
- `GET /api/ready` (readiness, unauthenticated): 200 only when the
  database probe succeeds, 503 otherwise, so a load balancer can
  hold traffic until the process can actually serve. Returns no
  detail beyond the boolean.
- `GET /api/metrics` (operator, token-authenticated): in-process
  counters collected at the shared JSON response helpers
  (`src/server/metrics.ts`), so every JSON route is counted with no
  per-route code. Reports uptime, request counts by status class and
  by normalized path (UUID/numeric segments become `:id`, query
  strings never recorded), failures by operation name, a timed
  database probe latency, and pool counters (total/idle/waiting),
  plus realtime counters (live/total stream connections, events
  published, events enqueued to streams; "delivered" means enqueued,
  not client-acknowledged).
  No user data, request body, or credential is ever recorded, and
  the path table is capped to bound memory.

Authentication for metrics is a shared bearer token
(`NEXORA_METRICS_TOKEN`, header `x-nexora-metrics-token`,
constant-time comparison); when the variable is unset the endpoint
fails closed with 503 instead of serving metrics unauthenticated.
Counters are process-local: a multi-instance deployment aggregates
across instances in the external monitor. OAuth 302 redirects
bypass the JSON helpers and are not counted; their failures remain
covered by the structured failure logs. **Not implemented here:**
alerting needs an operator channel decision (the external monitor
scraping `/api/metrics` is the intended alert source — alert on
5xx rate and on `database.up` false); queue/job failure metrics
are not applicable because Nexora has no queue or background job
system (cleanup is an operator-run script, see Phase 4 item 1).

### Sign-in page button (decided)

The sign-in page has **one** Google button, labelled "Continue
with Google", and it serves **both** sign-in and account creation:
a new Google user who completes the sign-in flow gets an account
created by that same flow (see "Sign-in flow"), so no separate
sign-up button is needed. The button is a form that POSTs to the
start endpoint (same-origin check applies); it is **not rendered
at all** when the feature flag is off, so there is no dead button
that 404s, and it does **not** appear on the register page, so
there is no second, duplicate flow to maintain. The button reuses
the existing auth shell and shared auth-page component patterns;
its styling follows `DESIGN.md` and is decided in the
implementation change, not here.

### Security tests and acceptance criteria — COVERED (mock IdP; live Google pending)

These criteria were required before any OAuth code shipped, and they
are now covered by `tests/oauth-google.test.ts` (unit) and
`tests/oauth-google.integration.test.ts` (mock IdP) — except the
parts that need real Google credentials, which remain unexercised:

- **Unit:** PKCE S256 challenge equals `base64url(SHA256(verifier))`,
  verifier length 43 (32 random bytes, base64url); state, verifier,
  and nonce randomness and single-use; flow-cookie HMAC verifies,
  and a tampered cookie, a malformed cookie, and a missing field
  are all rejected before any exchange; redirect URI exact match
  (a trailing slash or extra query fails); `safeReturnPath`
  rejects external `next` values and callback `next` is ignored;
  `id_token` validation rejects wrong `aud` (including an array
  `aud`), expired token, wrong `iss`, mismatched `nonce`,
  `email_verified=false` **and** `email_verified` missing,
  `alg=none`, `alg=HS256`, and unknown `kid` after one JWKS
  refetch; JWKS fetch failure fails closed.
- **Linking matrix (unit + integration):** provider-verified email
  with no existing user creates a user; provider email belonging
  to an existing Nexora user in a **sign-in** flow does NOT link
  and does NOT create (generic error guiding to password sign-in
  and linking from Account security); provider-unverified email
  never creates, links, or signs in; disabled account (`status`
  != `"active"`) never receives a session through OAuth, in
  either flow; link flow with a changed session (current user !=
  `linkUserId`) aborts with no identity created; link flow
  creates no new session; link flow with an already-linked
  identity for the same user is already-linked, not a 500; link
  flow with an identity linked to a different user refuses
  without revealing that account; link flow with a second Google
  identity for the same user refuses (one identity per user);
  link flow with a provider email belonging to a different
  Nexora account refuses without revealing that account.
- **Atomicity and races (integration, disposable database):**
  user + identity commit together; a duplicate-email race
  re-looks the email up instead of returning 500; a duplicate
  `(provider, sub)` race re-looks the identity up instead of
  returning 500; identity committed but session creation failed
  is recoverable by retry through the existing identity.
- **Validation (unit):** provider email normalization
  (`normalizeAuthEmail`) and the existing email schema (trim,
  3–320, valid shape, lowercase) reject over-long, malformed,
  and unnormalized emails before lookup or insertion; provider
  display name goes through the existing registration name rule
  (trim, 1–120, email-local-part fallback).
- **Rate limits and flag (integration):** start IP limit 60 per
  900 seconds and callback IP limit 60 per 900 seconds, as
  separate scopes, enforced with the trusted-IP header set
  (in development the IP limit is bypassed exactly as for login,
  so tests must set the header to exercise it); disabled flag
  makes **both** start and callback return 404; enabled with a
  missing client secret or flow-signing key fails closed (start
  503, callback generic error redirect, no redirect to Google);
  remote HTTP `APP_ORIGIN` in production fails closed the same
  way, while loopback HTTP is permitted for local development.
- **Callback shape (unit + browser):** callback always answers
  with a fixed 302 (never HTML/JSON), with
  `Referrer-Policy: no-referrer`, and only allowlisted error
  codes (`oauth_failed`, `oauth_denied`, `oauth_expired`,
  `oauth_already_linked`, `oauth_email_taken`) whose messages
  come from a fixed table, never from a query value or provider
  text; the access token is never persisted (no row, no session
  value, no cookie contains it) and no offline access is
  requested.
- **Integration (disposable database, mocked provider — never real
  Google in tests):** a stub token endpoint and JWKS let the full
  callback flow run: first login creates user + identity, second
  login signs in the same user, provider email change does not
  change `users.email`, replayed state/code is rejected, expired
  flow is rejected, `error=access_denied` shows the generic sign-in
  message, and a revoked session after OAuth login still works via
  `/account`. The sign-in page shows one Google button when the
  flag is on and none when it is off, and no Google button
  appears on the register page.
- **Migration (disposable database):** the single new migration
  applies cleanly, both rate-limit allowlists contain
  `oauth-start` and `oauth-callback`, `oauth_identities` has RLS
  enabled with its policies, both unique constraints exist,
  `provider_email` has no unique constraint, column-scoped
  grants exist for the app role, `lookup_oauth_identity` returns
  only `user_id`, `status`, and `email_verified_at`, and
  `users.password_hash` accepts NULL while the old CHECK shape
  is updated in migration-guard tests.
- **Manual acceptance (staging, real Google, test account only):**
  sign-in with Google works end to end; redirect-URI mismatch is
  rejected by Google; secret rotation (env change + restart) does
  not break existing sessions; session cookie attributes are
  verified in the browser (`HttpOnly`, `Secure`, `SameSite=Strict`,
  `__Host-` prefix in production); and an OAuth-only user can set a
  password later via the reset flow (which requires production SMTP
  to be verified — see the release note below).
- **Release note, not a blocker for OAuth sign-in itself:** OAuth
  sign-in does not depend on SMTP (the provider verifies the email),
  but the "set a password later" path for OAuth-only users does
  depend on password-reset email delivery, which is currently
  unverified in production. That path must be verified before it is
  offered to OAuth-only users.

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
- **Event set (v1):** `task.created`, `task.updated`,
  `task.deleted` (fired when a task is archived — archiving is this
  codebase's task deletion), `comment.created`, `project.updated`.
  Event data is minimal (ids, titles, names) and never contains
  secrets, bodies, or emails. Connection attempts are rate-limited
  (scope `realtime-connect-user`, 120/hour/user).
- **Explicitly NOT built:** `notification.created` (notifications
  already have their own centre; streaming them is future work) and
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
  Production WebSocket connectivity is not claimed: this is SSE
  over HTTP, and a future WebSocket provider would replace the
  transport while keeping the event log, versioning, and
  authorization contract.
- **Observability:** stream connections (live/total), events
  published, and events enqueued to streams are counted in
  `src/server/metrics.ts` and reported by `GET /api/metrics`
  ("delivered" means enqueued, not client-acknowledged — SSE has no
  acknowledgements). Per-request latency histograms and alerting
  remain future work (see §7).

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
  `APP_ORIGIN` set to the production `https:` origin, and the cleanup
  script scheduled daily by the operator. Multi-instance, Redis, object
  storage, and a realtime service are future work, not current options.
- **Release gates (not yet met):** production SMTP verification, trusted
  ingress configuration, durable shared storage, backup and recovery
  verification, accessibility acceptance, performance measurement, and
  monitoring. None of these may be claimed from a local check.
