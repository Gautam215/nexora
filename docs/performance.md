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

## Timeout, retry, and circuit-breaker inventory

- Database pool: statement timeout 10 s, query timeout 12 s
  (15 s for Neon hosts). No retry: a failed transaction is
  reported, and idempotency keys make client retries safe.
- AI provider: 30 s timeout per call; one retry only for
  transient HTTP 429/502/503/504, with a short backoff honouring
  Retry-After up to 5 s. Timeouts and network errors are not
  retried (a timed-out generation may still be running
  provider-side). No circuit breaker: with one retry and a
  30-second timeout a failing provider already fails closed
  fast, and a breaker would need shared state across processes
  that this codebase does not have (all counters are
  process-local, including /api/metrics).
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
