import "server-only";
import { MalwareConfigurationError } from "./malware.ts";
import { presignedDownloadUrl } from "./storage.ts";

// Async malware scanning via GitHub Actions (design:
// docs/async-scan-github-actions-design.md). The scan mode is
// derived from the same NEXORA_MALWARE_SCANNER variable as the
// synchronous scanner, so the three modes stay mutually
// exclusive:
//
// - "clamav" -> synchronous, exactly as before (scanFileForUpload).
// - "clamav-relay" -> synchronous through the HTTPS relay
//   (relay/server.mjs): same sync semantics as "clamav", only the
//   transport differs. A relay configuration error throws here,
//   like the TCP path's, instead of silently going unscanned.
// - "github-actions" -> asynchronous: the upload records
//   'pending' and this module dispatches a scan job after the
//   transaction commits. A dispatch failure never fails the
//   upload: the row stays 'pending' and the daily scan-retry
//   cron re-dispatches it. Pending is the honest, safe state
//   (undownloadable once the pending block ships,
//   warning-labelled until then), so a broken dispatch degrades
//   to the no-scanner behaviour, not to a 500.
// - unset / "none" -> no scanning, exactly as before.
//
// An unknown scanner value still throws, preserving the
// synchronous path's behaviour for misconfiguration. The
// dispatch configuration itself (token, repo) is deliberately
// NOT validated here: a missing dispatch token must not break
// file uploads, it only leaves rows pending for the retry cron.

export type ScanMode = "sync" | "async-github-actions" | "none";

export function getScanMode(): ScanMode {
  const selected = process.env.NEXORA_MALWARE_SCANNER?.trim().toLowerCase() ?? "";
  if (selected === "" || selected === "none") return "none";
  if (selected === "clamav" || selected === "clamav-relay") return "sync";
  if (selected === "github-actions") return "async-github-actions";
  throw new MalwareConfigurationError(`Unknown malware scanner: ${selected}`);
}

export interface ScanDispatchInput {
  fileId: string;
  version: number;
  organizationId: string;
  projectId: string;
  taskId: string;
  storageKey: string;
  sha256: string;
}

export interface ScanDispatchResult {
  dispatched: boolean;
  reason?: string;
}

const DISPATCH_TIMEOUT_MS = 10_000;
const DISPATCH_URL_TTL_SECONDS = 900;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Dispatch one scan job to GitHub Actions via repository_dispatch.
 * Never throws and never logs a token or a presigned URL: every
 * failure is a structured log line plus { dispatched: false },
 * and the caller (upload route, retry cron) treats that as
 * "still pending, retry later". The presigned URL is short-lived
 * (900 s) and is the only file access the runner ever gets; no
 * database or storage credential leaves this process.
 */
export async function dispatchScanJob(input: ScanDispatchInput): Promise<ScanDispatchResult> {
  try {
    const downloadUrl = presignedDownloadUrl(input.storageKey, DISPATCH_URL_TTL_SECONDS);
    if (!downloadUrl) {
      console.error(JSON.stringify({ event: "scan.dispatch_skipped", reason: "no-presigned-url" }));
      return { dispatched: false, reason: "no-presigned-url" };
    }
    const token = process.env.NEXORA_GITHUB_DISPATCH_TOKEN?.trim() ?? "";
    const repo = process.env.NEXORA_SCAN_REPO?.trim() || "Gautam215/nexora";
    if (!token || !REPO_PATTERN.test(repo)) {
      console.error(JSON.stringify({ event: "scan.dispatch_skipped", reason: "dispatch-not-configured" }));
      return { dispatched: false, reason: "dispatch-not-configured" };
    }
    const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "nexora-scan-dispatch",
      },
      body: JSON.stringify({
        event_type: "nexora-scan",
        client_payload: {
          fileId: input.fileId,
          version: input.version,
          organizationId: input.organizationId,
          projectId: input.projectId,
          taskId: input.taskId,
          sha256: input.sha256,
          downloadUrl,
        },
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(
        JSON.stringify({ event: "scan.dispatch_failed", reason: "dispatch-rejected", status: response.status }),
      );
      return { dispatched: false, reason: "dispatch-rejected" };
    }
    return { dispatched: true };
  } catch {
    console.error(JSON.stringify({ event: "scan.dispatch_failed", reason: "dispatch-failed" }));
    return { dispatched: false, reason: "dispatch-failed" };
  }
}
