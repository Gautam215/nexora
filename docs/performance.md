# Performance and reliability — local measurements

This document records what was actually measured locally, and
what was deliberately NOT claimed. Production performance
acceptance needs a deployed environment and a realistic dataset;
nothing here is that.

## Benchmark method

`scripts/benchmark-queries.mjs` runs five hot read-query shapes,
20 iterations each after a warm-up, against `DATABASE_URL` and
prints mean/p50/p95 in milliseconds plus row counts. Run it
against a disposable database. Note: with the runtime role the
row counts are RLS-filtered (no tenant session), so for a
meaningful dataset size run it with the migrator role, as was
done for the baseline below.

`scripts/seed-benchmark-dataset.mjs` (2026-10-28 round 4)
builds the realistic dataset the old baseline lacked: 200
organizations, 500 projects, 5000 tasks, 2000 task files, 5000
notifications, seeded as the migrator role with per-organization
tenant context. Run it ONLY against a disposable database,
never production. `scripts/production-load-probe.mjs` is the
bounded read-only probe for the deployed app (health + ready
only, 5 concurrent, 50 requests, 10-second timeout, aborts
above 10% failures); it is NOT run by this repo's gates and
must NOT run against production without the operator's
explicit approval for that run.

## Baseline — 2026-10-26, local PostgreSQL 16, disposable test database

Dataset: 10 organizations, 10 projects, 11 tasks, 6 task files,
0 notifications (leftover integration-test fixtures, not a
production-shaped dataset).

| Query | Mean (ms) | p50 (ms) | p95 (ms) |
| --- | --- | --- | --- |
| list_projects | 1.00 | 0.66 | 3.75 |
| list_tasks | 0.50 | 0.47 | 1.10 |
| search_files_by_name | 0.48 | 0.46 | 0.58 |
| list_notifications | 0.51 | 0.47 | 0.92 |
| org_storage_usage | 0.43 | 0.41 | 0.88 |

Reading: on a tiny dataset these are all sub-millisecond to a
few milliseconds, dominated by round-trip and planning, not by
the queries themselves. They establish that the query shapes run
and give a regression baseline to compare future runs against on
the same dataset — they do not establish that the same queries
stay fast at production scale, with tenant RLS filters, or under
concurrent load.

## Realistic dataset — 2026-10-28 round 4, local PostgreSQL 16, disposable test database

Dataset (scripts/seed-benchmark-dataset.mjs, migrator role):
200 organizations, 500 projects, 5000 tasks, 2000 task files,
5000 notifications — a plausible early-production workload.
Run on the same VM as the database, no concurrent load, no
tenant RLS filtering on most queries (the migrator role
bypasses RLS). These are LOCAL measurements, not production
acceptance.

| Query | Mean (ms) | p50 (ms) | p95 (ms) |
| --- | --- | --- | --- |
| list_projects | 0.97 | 0.81 | 3.07 |
| list_tasks | 1.76 | 1.63 | 3.67 |
| search_files_by_name | 0.51 | 0.52 | 1.30 |
| list_notifications | 0.22 | 0.18 | 0.53 |
| org_storage_usage | 0.51 | 0.46 | 0.94 |

Reading: all five shapes stay under 4 ms at p95 on this
dataset, on local hardware, without concurrency. Two honest
limits: `list_notifications` ran against 0 visible rows for
the migrator role — `notifications` has FORCE RLS, so the
owner sees none without a recipient tenant session (the 5000
seeded rows were verified separately under a recipient
session) — that row is a query-shape check, not a
notification-scale measurement. And none of this covers
concurrent load, tenant-filtered plans, or the deployed
environment; the bounded read-only probe
(`scripts/production-load-probe.mjs`) exists for the
deployed-app comparison, and it has NOT been run against
production in this round.

## Realistic dataset WITH concurrent load — 2026-10-28, local PostgreSQL 16, disposable database

Same seeded dataset as above (200 organizations, 500
projects, 5000 tasks, 2000 task files, 5000 notifications),
re-seeded fresh; `scripts/benchmark-queries.mjs` now runs a
concurrent phase after the sequential one: 10 workers × 20
iterations per query shape (200 queries per shape), pool
raised to 12 so the workers measure database contention, not
pool queueing. Sequential numbers reproduce the round-4 run
within noise.

| Query (concurrent 10×20) | Mean (ms) | p50 (ms) | p95 (ms) | Max (ms) |
| --- | --- | --- | --- | --- |
| list_projects | 5.90 | 3.26 | 12.17 | 70.39 |
| list_tasks | 14.55 | 12.97 | 28.46 | 37.34 |
| search_files_by_name | 5.82 | 5.46 | 14.89 | 22.75 |
| list_notifications | 1.12 | 0.80 | 3.36 | 8.50 |
| org_storage_usage | 2.27 | 1.90 | 4.70 | 6.44 |

Reading: under 10-way concurrency every shape stays under
30 ms at p95 on this dataset — contention roughly triples
to quintuples the sequential cost (list_tasks p95 5.29 →
28.46 ms) but nothing blows up, and the slowest single
query observed was one 70 ms list_projects outlier. The
same honest limits apply: migrator role (no tenant RLS
filtering on most shapes, notifications at 0 visible rows),
local hardware, and no deployed-environment measurement.
This closes the "no concurrency" gap of the round-4 run; it
does not close the production-acceptance gap.

Correction 2026-10-28 (10x dataset, benchmark artifact):
the Step 1 concurrent list_tasks p95 of 190.94 ms reported
in docs/scalability-plan.md came from a global ORDER BY
created_at that seq-scanned all 50000 rows — a query the app
never runs, since the real task-list route always filters by
organization + project (sort=createdAt). The benchmark was
fixed to measure the scoped shape and re-run on the same 10x
dataset (2000 orgs / 5000 projects / 50000 tasks):
list_tasks sequential p95 1.21 ms, concurrent p95 17.62 ms;
all five shapes concurrent p95 under 100 ms (list_projects
39.76, list_tasks 17.62, search_files_by_name 12.89,
list_notifications 16.21, org_storage_usage 65.53). The
scoped plan is an index scan (0.12 ms single-run), so no
index migration was added. The production-acceptance gap
itself is unchanged: these are still local numbers, not
production-dataset evidence.

## Timeout, retry, and circuit-breaker inventory

- Database pool: statement timeout 10 s, query timeout 12 s
  (15 s for Neon hosts). No retry: a failed transaction is
  reported, and idempotency keys make client retries safe.
- AI provider: 30 s timeout per call; one retry only for
  transient HTTP 429/502/503/504, with a short backoff honouring
  Retry-After up to 5 s. Timeouts and network errors are not
  retried (a timed-out generation may still be running
  provider-side). Circuit breaker (2026-10-28 healing round,
  `src/server/ai/circuit-breaker.ts`): 5 consecutive
  HTTP-provider failures open the breaker for 60 s (one probe
  after cooldown); the mock provider is never wrapped.
  Openings are counted in `/api/metrics` as `ai.circuitOpens`.
  The breaker is process-local, like all counters here, so it
  bounds one process's failure storm, not a fleet-wide one.
- SMTP: 5 s greeting, 5 s connection, 10 s socket timeouts.
  Notification email delivery retries through the outbox
  (attempts × 5 minutes backoff, max 5 attempts, then failed),
  not through SMTP retries.
- S3 adapter: 15 s fetch timeout per request, no retry.
- ClamAV: 30 s socket timeout per scan; an unavailable scanner
  quarantines the file (fail closed), it does not retry the scan
  at upload time. The rescan script is the retry path.
- SSE streams: 2 s poll, 15 s heartbeat, client-side reconnect
  via last-event-id / since_id / since with a resync fallback.
