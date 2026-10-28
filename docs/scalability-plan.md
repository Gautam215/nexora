# Nexora scalability plan (DRAFT — targets proposed, not approved)

Status: draft written 2026-10-28. The load targets and scaling
thresholds below are PROPOSED values for user review, not measured
results and not accepted service levels. PRD section 43 stays Partial
until the user approves (or changes) these targets.

## Measured baseline (the only numbers this plan rests on)

Local disposable dataset, local PostgreSQL 16, no concurrency
(2026-10-28 round 4; dataset: 200 organizations, 500 projects,
5000 tasks, 2000 task files, 5000 notifications):

- `list_projects` p95 3.07 ms
- `list_tasks` p95 3.67 ms
- `search_files_by_name` p95 1.30 ms
- `org_storage_usage` p95 0.94 ms
- `list_notifications` p95 0.53 ms — SHAPE CHECK ONLY: 0 visible
  rows under the owner session (notifications FORCE RLS hides them
  from the owner; the 5000 rows were verified under a recipient
  session), so it is not a scale measurement.

Production liveness probe (2026-10-28, health + ready only,
5 concurrent, 50 requests): 50/50 success, 0 failed;
`/api/health` mean ~407 ms, p95 ~1.7 s; `/api/ready` mean
~324 ms, p95 ~1.2 s. These numbers include serverless cold
starts. They are liveness, NOT performance acceptance.

## Scale steps (measurement gates, not promises)

Run `scripts/seed-benchmark-dataset.mjs` at each step, then
`scripts/benchmark-queries.mjs` on the same reference host, then
the bounded production liveness probe. Advance only when the
step's gate passes; a failed gate means stop and fix, not
redefine the gate.

- Step 0 (done): seed dataset above, all five query shapes
  under 4 ms at p95 locally.
- Step 1 (proposed): 10x dataset (2000 organizations, 5000
  projects, 50000 tasks). Proposed gate: the same five query
  shapes under 100 ms at p95 locally, liveness probe 100%
  success with p95 under 5 s.
- Step 2 (proposed, needs a production dataset decision):
  production-scale verification on a realistic production
  dataset with user-approved targets. No production target is
  set by this draft.

## Scaling thresholds (signals, not user counts)

No user-count thresholds are set: no production usage data
exists to base them on. Thresholds are system signals:

- Query p95 breach: any benchmark shape exceeds its step gate
  for two consecutive runs → index/query review first; only
  then consider instance or database scaling.
- Pool pressure: sustained `waiting` > 0 in `/api/metrics`
  pool counters, or probe latency climbing while the database
  stays up → pool sizing review (current code: pool limits
  and query timeouts exist; see ARCHITECTURE.md).
- Storage pressure: organization usage approaching its quota
  (default 1 GiB, `NEXORA_DEFAULT_STORAGE_QUOTA_BYTES`) →
  raise the quota deliberately or add bucket capacity; never
  silently lift a cap.
- Realtime pressure: presence or metrics counters diverging
  across instances (per-process state, ARCHITECTURE.md §9a/§9c)
  → trigger the multi-instance path below.
- Error pressure: server-error threshold crossings in the
  alerts job (default 10, `NEXORA_ALERT_EMAIL` set) → treat as
  an incident signal, not a scaling signal, until a cause is
  known.

## Scaling levers, in order

1. Single instance (current default, ARCHITECTURE.md §9c):
   per-process presence, process-local metrics, server-local
   file bytes under the local provider. Stay here while all
   gates pass.
2. Shared storage (already live for new uploads via Backblaze
   B2 S3; older local files need the documented copy-then-
   verify migration, never move-then-hope).
3. Multi-instance (reversible 4-step path in ARCHITECTURE.md
   §9c): shared storage copy-then-verify, DB-backed presence
   or an approved Redis design, external metrics aggregation,
   two-instance verification. Redis is NOT approved by this
   draft; it needs its own design decision.
4. Cron cadence: Vercel Hobby allows daily crons only
   (current schedule: due-date 02:00, cleanup 03:00,
   email-outbox 04:00, alerts 05:00 UTC). Finer cadences need
   a Pro upgrade or an external header-capable caller, with no
   code change.

## What approval of this plan means (bounded)

Approving this plan approves ONLY: the Step 1 gate values, the
threshold-to-review mapping above, and the lever order. It does
NOT approve: a Redis design, a Vercel Pro upgrade, any production
performance target, or any automatic scaling action — thresholds
trigger a review, never an automatic change. Those remain separate
decisions, each needing its own approval.

## Explicitly open (not decided by this draft)

- Production dataset and approved performance targets
  (user decision; PRD §§3, 38, 39 stay Partial until then).
- Multi-instance Redis design (needs approval; §9c path only).
- WebSocket vs SSE transport (PRD §25 decision; SSE is the
  current transport, presence per-process best-effort).
- Live ClamAV endpoint (PRD §14/§29; see docs/deployment.md
  enablement note — plain-TCP adapter, private networking
  required).
- Human accessibility pass (PRD §37) and the user's own
  production login (PRD §5).
