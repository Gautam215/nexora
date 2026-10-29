# Nexora scalability plan (Step 1 targets APPROVED 2026-10-28, bounded scope)

Status: draft written 2026-10-28; Step 1 gate values, the
threshold-to-review mapping, and the lever order were APPROVED by
the user 2026-10-28 as the initial test targets. Approval covers
only that scope — not Redis, not Vercel Pro, not production
targets, not automatic scaling. Step 1 is measured (see below);
Step 2 production-scale verification remains open.

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

Step 1 measurement (2026-10-28, disposable local DB, migrator
role, freshly migrated 0001–0062, seeded 10x: 2000
organizations, 5000 projects, 50000 tasks, 20000 task files,
50000 notifications): sequential p95 — list_projects 6.11 ms,
list_tasks 44.91 ms, search_files_by_name 1.30 ms,
list_notifications 2.08 ms, org_storage_usage 7.36 ms — all
under the proposed 100 ms gate. Production liveness re-probe
on current code (bf42d788): 50/50 success, p95 ~2.65 s, under
the proposed 5 s gate. Caveats, recorded not hidden:
notification counts read 0 under the migrator session (FORCE
RLS shape-check caveat, same as round 4). Correction
2026-10-28 (benchmark artifact, not a product defect): the
earlier concurrent list_tasks p95 of 190.94 ms came from a
global ORDER BY created_at that seq-scanned all 50000 rows —
a query the app never runs, because the real task-list route
always filters by organization + project. The benchmark was
fixed (scripts/benchmark-queries.mjs now picks a real seeded
org/project pair and measures the scoped shape) and re-run on
the same 10x dataset: list_tasks sequential p95 1.21 ms,
concurrent p95 17.62 ms; all five shapes concurrent p95 under
100 ms (list_projects 39.76, list_tasks 17.62,
search_files_by_name 12.89, list_notifications 16.21,
org_storage_usage 65.53). No index migration was needed — the
scoped plan is an index scan at 0.12 ms single-run. Gate
values were APPROVED by the user 2026-10-28 (bounded scope);
Step 1 is measured, and with the corrected shape it passes
its gate; Step 2 production-scale verification stays open.

## Provisional acceptance proxy (user decision 2026-10-28, ₹0 policy)

The 10x seeded dataset above is adopted as a PROVISIONAL
acceptance proxy for performance testing — not as production-scale
verification. Methodology: disposable local PostgreSQL, freshly
migrated 0001–0062, seeded with
`scripts/seed-benchmark-dataset.mjs` (2000 organizations, 5000
projects, 50000 tasks, 20000 task files, 50000 notifications),
measured with `scripts/benchmark-queries.mjs` in two phases
(sequential, then concurrent 10 workers × 20). Results on the
corrected scoped shapes: list_tasks sequential p95 1.21 ms,
concurrent p95 17.62 ms; all five shapes concurrent p95 under
the approved 100 ms gate (list_projects 39.76, list_tasks 17.62,
search_files_by_name 12.89, list_notifications 16.21,
org_storage_usage 65.53). The other four sequential figures
from the first run (list_projects 6.11, search_files_by_name
1.30, list_notifications 2.08, org_storage_usage 7.36) were not
re-measured sequentially after the benchmark fix and are kept
as first-run figures, not corrected-run figures. Production
liveness (50/50, p95 ~2.65 s) is liveness only, not performance
acceptance. Limitations, stated not hidden: the data is
synthetic and near-uniform (~10 tasks per seeded project);
production holds almost no real data, so no representative
production dataset exists yet; notification counts read 0
under the migrator session (FORCE RLS shape-check caveat);
local PostgreSQL 16 differs from production PostgreSQL 18 and
from serverless cold-start behaviour; no Web Vitals or
production performance targets exist. Consequence: production-data
validation stays Partial (§§3/38/39) until evidence from a
representative production dataset exists. The proxy answers
"the queries scale on 10x seeded data", not "production-scale
performance is verified".

## Scale steps (measurement gates, not promises)

Run `scripts/seed-benchmark-dataset.mjs` at each step, then
`scripts/benchmark-queries.mjs` on the same reference host, then
the bounded production liveness probe. Advance only when the
step's gate passes; a failed gate means stop and fix, not
redefine the gate.

- Step 0 (done): seed dataset above, all five query shapes
  under 4 ms at p95 locally.
- Step 1 (approved 2026-10-28, bounded scope): 10x dataset (2000 organizations, 5000
  projects, 50000 tasks). Approved gate: the same five query
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
