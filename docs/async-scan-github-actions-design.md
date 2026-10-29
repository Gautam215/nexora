# Async malware scanning via GitHub Actions — DESIGN ONLY (2026-10-28)

Status: design, NOT implemented. No code, migration, secret, or
deployment is part of this document. Nothing here is pushed or
live until each step is separately approved.

## 1. Problem

Production uploads are recorded `pending` (unscanned) because no
scanner is configured, and the pending-download block (implemented
locally, not deployed) would make pending files undownloadable
forever. A synchronous scanner cannot run on Vercel serverless,
and no free in-infrastructure scanner exists. This design adds
real ClamAV scanning at ₹0 by running the scan in a GitHub
Actions runner, asynchronously, while keeping every credential
that matters inside Vercel.

## 2. Goals and non-goals

Goals: real ClamAV verdicts (clean / infected) on production
uploads; ₹0 additional spending; no new paid service; no
database or storage credential leaves Vercel; fail-closed
behaviour preserved; the pending-download block becomes viable
(files unlock within minutes instead of never).

Non-goals: real-time scanning (latency is minutes, not seconds);
a new jobs table in v1 (see §8); changes to the synchronous
clamd mode or to the no-scanner mode; changes to download-block
semantics; scanning for the local-filesystem storage mode
(async dispatch requires S3 presigned URLs — see §5).

## 3. Current state (verified in code, 2026-10-28)

- Upload (POST collection route): `writeObject` stages bytes,
  `scanFileForUpload` scans synchronously, then the transaction
  INSERTs the `task_files` row with the resulting `scan_status`.
  An idempotency replay returns the prior file WITHOUT re-scan.
- Replace (PUT file route) mirrors this: scan, then versioned
  update.
- Storage (`src/server/storage.ts`): `presignedDownloadUrl`
  exists (S3 provider implements it via SigV4; default TTL 300 s;
  the local provider returns null).
- Cron: five daily jobs (02:00–06:00 UTC) in `vercel.json`;
  `SCHEDULED_JOBS = ["due-date", "cleanup", "email-outbox",
  "alerts", "healing"]`. Vercel Hobby rejects sub-daily
  expressions, so any new job is daily.
- The existing `scripts/rescan-task-files.mjs` is a sync-scanner
  tool; it does not dispatch and is NOT the async retry path
  (see §8). It remains the manual fallback for an operator with
  a sync scanner.

## 4. Proposed flow

1. Upload (or replace) succeeds. The row is recorded `pending`.
   On an idempotency replay, nothing is re-dispatched.
2. After the transaction commits, the route best-effort
   dispatches a scan job (see §6). Dispatch failure never fails
   the upload: it is logged and picked up by the daily retry
   (§8). Dispatch never happens before commit, and never on a
   failed or replayed upload.
3. GitHub Actions runs the workflow (§7): downloads the file
   from a short-lived presigned B2 URL, verifies its SHA-256,
   scans with `clamscan`, and calls back with the verdict.
4. The callback route (§6) applies the verdict only if the row
   is still active, still `pending`, and still at the dispatched
   version. Anything else (replaced file, deleted file, second
   delivery) is ignored. `clean` → downloadable;
   `infected` or `error` → `quarantined` (fail closed, matching
   the existing rule that a scanner failure never yields clean).
5. Files still `pending` after an hour are re-dispatched by the
   daily `scan-retry` cron (§8), up to 7 days old. Older files
   stay `pending` and are logged for the operator.

Typical latency: dispatch → runner start → setup → scan →
callback is 2–5 minutes. The UI already shows "Scan pending"
for such files; with the block deployed, the download button
appears when the file turns `clean`.

## 5. Scan modes (no behaviour change to existing modes)

A new helper, `getScanMode()`, reads `NEXORA_MALWARE_SCANNER`:

- `"clamav"` → synchronous, exactly as today.
- `"github-actions"` → asynchronous, this design.
- unset / `"none"` → no scanning, exactly as today.
- anything else → `MalwareConfigurationError`, as today.

The upload and replace routes branch on the mode: sync scans
in-route as today; async records `pending` and dispatches after
commit; none records `pending` with no dispatch. The sync
`MalwareScanner` interface is untouched.

Async dispatch requires S3 storage. If `presignedDownloadUrl`
returns null (local-filesystem mode), dispatch is skipped and
logged; the file stays `pending`. This is a configuration
guard, not a silent success.

## 6. Components

### 6.1 Dispatch helper (new file `src/server/scan-dispatch.ts`)

`dispatchScanJob({ fileId, version, organizationId, projectId,
taskId, storageKey, sha256 })`:

- Builds a presigned download URL with a 900 s TTL (covers
  runner startup + download; still short-lived).
- POSTs `https://api.github.com/repos/{repo}/dispatches` with
  `Authorization: Bearer <NEXORA_GITHUB_DISPATCH_TOKEN>`,
  `event_type: "nexora-scan"`, and `client_payload` carrying
  only: fileId, version, organizationId, projectId, taskId,
  sha256, and the presigned URL.
- Uses a 10 s fetch timeout and never throws into the upload
  response: any failure returns `{ dispatched: false }` and is
  logged server-side (no secret, no URL in the log).
- The presigned URL is never logged and never echoed by the
  workflow (see §7).

`repository_dispatch` (not `workflow_dispatch`) is the trigger
because it is designed for external events carrying a payload.
GitHub API rate limits (5,000/hr authenticated) are far above
this project's volume.

### 6.2 Callback route (new route `POST /api/internal/scan-result`)

Server-to-server, like the cron route: NO origin check, NO
user session. Authentication is a shared secret:

- Header `x-nexora-scan-secret`, compared timing-safe against
  `NEXORA_SCAN_WEBHOOK_SECRET`.
- Secret env unset → 503 (fail closed, same rule as the cron
  and metrics token-missing behaviour).
- Mismatch → 401 + a server log shaped like the existing
  `operator.auth_failed` event (endpoint only, never the
  secret value).
- No IP rate limit in v1 (GitHub egress IPs vary); the secret
  plus the pending-only transition below are the controls.
  Recorded as a residual, not as a claim of rate limiting.

Body (Zod, strictObject — unknown keys rejected):

```json
{ "fileId": "<uuid>", "version": 3, "outcome": "clean",
  "runId": "<github-run-id>" }
```

`outcome` is `"clean" | "infected" | "error"`.

Behaviour: a SECURITY DEFINER function
`apply_scan_result(file, version, outcome)` updates the row
only if it exists, `deleted_at IS NULL`, `scan_status =
'pending'`, and `version` matches. `clean` → `clean`;
`infected` or `error` → `quarantined`. Otherwise the call is
a no-op. The route always answers 200 after authentication
(`{ ok: true }`), whether applied or ignored; ignored reasons
stay in server logs only. No audit row in v1 (audit actors
must be real users; completion is observable via
`scan_status` / `updated_at`).

### 6.3 Migration 0064 (functions only, no new tables)

- `apply_scan_result(file_id, version, outcome)` — SECURITY
  DEFINER, pending-only transition as above, plus grants for
  the app role (runtime-grants pattern).
- `list_stale_pending_files()` — SECURITY DEFINER, returns
  active `pending` rows older than 1 hour and younger than 7
  days, capped at 50 rows per call (file id, version, storage
  key, sha256, org/project/task ids), for the retry cron.
- No new tables in v1. Trade-off, stated: there are no
  per-file attempt counts; the age cap (7 days) bounds
  retries instead. A jobs table is future work if volume or
  observability ever demands it — it is NOT in this design.

### 6.4 Retry cron (new daily job `scan-retry`)

- `vercel.json`: `{"path": "/api/cron/scan-retry", "schedule":
  "0 7 * * *"}` (07:00 UTC, after healing at 06:00; daily-only
  per the Hobby constraint).
- The cron route's existing token gate and operator rate limit
  apply automatically (same route, same checks as the other
  jobs).
- Handler: `list_stale_pending_files()` → presign (900 s) →
  dispatch each → record counts in `scheduled_job_runs`
  detail, following the existing cron pattern.
- Re-dispatching a file whose callback is merely slow is safe:
  the second callback is a no-op once the row leaves
  `pending`, and version pinning blocks cross-version
  confusion.

## 7. Workflow file (`.github/workflows/scan-upload.yml`)

Deliberately minimal — NO checkout (the workflow needs no repo
code), least-privilege permissions, bounded runtime:

```yaml
name: scan-upload
on:
  repository_dispatch:
    types: [nexora-scan]
permissions:
  contents: none
jobs:
  scan:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Install ClamAV
        run: sudo apt-get update -qq && sudo apt-get install -y -qq clamav
      - name: Restore signature cache
        uses: actions/cache@v4
        with:
          path: /var/lib/clamav
          key: clamav-db-v1
      - name: Update signatures
        run: sudo freshclam --quiet || sudo freshclam --quiet
      - name: Download file
        env:
          SCAN_URL: ${{ github.event.client_payload.downloadUrl }}
          EXPECTED_SHA256: ${{ github.event.client_payload.sha256 }}
        run: |
          curl -fsSL --max-time 120 -o scan-target "$SCAN_URL"
          echo "$EXPECTED_SHA256  scan-target" | sha256sum -c -
      - name: Scan
        id: scan
        run: |
          set +e
          clamscan --no-summary scan-target
          echo "code=$?" >> "$GITHUB_OUTPUT"
      - name: Report result
        if: always()
        env:
          APP_URL: ${{ secrets.NEXORA_APP_URL }}
          SCAN_SECRET: ${{ secrets.NEXORA_SCAN_WEBHOOK_SECRET }}
        run: |
          case "${{ steps.scan.outputs.code }}" in
            0) outcome="clean" ;;
            1) outcome="infected" ;;
            *) outcome="error" ;;
          esac
          curl -fsSL --max-time 30 -X POST "$APP_URL/api/internal/scan-result" \
            -H "content-type: application/json" \
            -H "x-nexora-scan-secret: $SCAN_SECRET" \
            -d "$(jq -n --arg f "${{ github.event.client_payload.fileId }}" \
              --argjson v "${{ github.event.client_payload.version }}" \
              --arg o "$outcome" --arg r "${{ github.run_id }}" \
              '{fileId: $f, version: $v, outcome: $o, runId: $r}')"
```

Notes on the sketch (to be verified at implementation, not
assumed): `clamscan` exit codes are 0 clean / 1 infected /
2 error; the cache path needs root read/write (the cache
action runs as the runner user — if restore fails, the step
must fall back to a full `freshclam`, which is slow but
correct); `jq` is preinstalled on `ubuntu-latest` runners;
the presigned URL must never be echoed (it is passed only via
env, and GitHub masks secret values, but the URL itself is
NOT a registered secret — so no step may print it).

Security notes: the runner downloads an untrusted file and
scans it — that is the scanner's purpose, and the runner is
ephemeral (a fresh VM per run, discarded afterwards), so a
malicious file has no persistent host to infect. The workflow
runs no repo code and writes nothing to the repo.

## 8. Failure matrix

| Situation | Result |
|---|---|
| Dispatch fails (network, token) | Upload still succeeds; file stays `pending`; daily retry re-dispatches. |
| Runner never starts / dies | No callback; daily retry re-dispatches (idempotent). |
| Download fails in runner (bad URL, expired, B2 down) | Callback `error` → `quarantined` (fail closed). Re-upload always possible. |
| SHA-256 mismatch after download | Callback `error` → `quarantined` (bytes are not the uploaded bytes). |
| Scan finds a signature | Callback `infected` → `quarantined`, download 409. |
| File replaced while scan in flight | Callback version mismatch → ignored. The new version gets its own dispatch. |
| File deleted while scan in flight | Callback ignored (`deleted_at` set). |
| Callback delivered twice | Second delivery is a no-op (row no longer `pending`). |
| Callback secret wrong / missing env | 401 / 503; nothing changes. |
| Workflow file missing (not yet added) | Dispatches succeed at GitHub's API but no run starts; files stay `pending` until the workflow lands — visible in logs, not silent. |

## 9. Secrets and setup checklist (all user-side, none in code)

Vercel Production secrets (user enters in the dashboard):

- `NEXORA_MALWARE_SCANNER = "github-actions"` (switches the
  mode; do this LAST, after the workflow is verified).
- `NEXORA_GITHUB_DISPATCH_TOKEN` — a GitHub token able to
  dispatch. Verify at setup which token type works: a classic
  PAT with `repo` scope works; a fine-grained PAT needs the
  repository-dispatch permission. Do not guess — confirm by
  sending one test dispatch before enabling the mode.
- `NEXORA_SCAN_WEBHOOK_SECRET` — random, at least 32 bytes.

GitHub (repository Settings → Secrets and variables →
Actions):

- `NEXORA_SCAN_WEBHOOK_SECRET` — the same value as Vercel's.
- `NEXORA_APP_URL` — `https://nexora-two-ruby.vercel.app`.

Repository prerequisites (verify before enabling):

- Actions enabled on `Gautam215/nexora`, with free minutes
  available for this volume. If minutes are exhausted, runs
  queue/fail and files stay `pending` — visible, not silent.
- The workflow file itself: snapshot pushes may fail for
  `.github/workflows/*` files if the pushing token lacks the
  `workflow` scope. If that happens, add the file via the
  GitHub web UI or a git push from the user's machine instead
  — do not work around a scope denial.

## 10. Verification plan (in order, each step before the next)

1. Test dispatch: send one repository dispatch by hand
   (with a throwaway payload) and confirm a workflow run
   starts. If it does not, stop — the mode must not be
   enabled.
2. Clean file: upload a small text file via the app →
   expect `pending`, then `clean` within minutes, then a
   successful download.
3. EICAR: upload the standard EICAR test file (harmless
   test string, not malware) → expect `quarantined` and a
   409 on download, on both download paths.
4. Wrong secret: POST the callback with a wrong secret →
   expect 401 and no status change.
5. Stale version: replace a file while its scan is in flight
   → expect the old callback to be ignored and the new
   version to get its own scan.
6. Retry: leave a file pending (dispatch token temporarily
   unusable in a test setup only — never by breaking
   production) → expect the daily retry to re-dispatch it.
7. Only after 1–6 pass: enable the mode in production, then
   decide separately on deploying the pending-download block
   — async scanning is what makes that block viable.

## 11. Costs and residuals (honest)

- Money: ₹0 at this volume (GitHub Actions free minutes;
  no new service). Assumption: Actions enabled + minutes
  available (see §9).
- Latency: minutes, not seconds. Uploads are not instantly
  downloadable — that is the design, and the UI already says
  "Scan pending".
- Privacy: file bytes pass through GitHub's ephemeral
  runners (the user's own repo infrastructure, discarded per
  run) — better than sending files to a third-party scanning
  company, but the bytes DO leave Nexora's own systems. The
  presigned URL is short-lived (900 s) and must never be
  logged.
- Residuals: no IP rate limit on the callback in v1 (secret
  + pending-only transition are the controls); no per-file
  attempt counts (age cap instead); no audit row for scan
  completion in v1; the workflow file's delivery may need the
  web UI if the snapshot token lacks `workflow` scope.
- Traceability: §§14/29 stay Partial until the live
  end-to-end verification (§10) passes with evidence. This
  design alone promotes nothing.

## 12. Rollout order (each step separately approved)

1. Migration 0064 (production, separate approval).
2. Code: dispatch helper, callback route, upload/replace
   branches, retry cron, workflow file, tests (unit: dispatch
   helper with mocked fetch; integration: callback
   transitions including stale-version, deleted, and
   double-delivery cases; the workflow itself is verified
   live per §10, not in the suite).
3. Secrets + repository prerequisites (§9).
4. Verification (§10), in order.
5. Mode switch (`NEXORA_MALWARE_SCANNER=github-actions`),
   then — separately — the pending-download block deploy
   decision.
