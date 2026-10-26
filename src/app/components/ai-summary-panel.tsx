"use client";

import { useState } from "react";

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

interface AiSummary {
  summary: string;
  aiGenerated: boolean;
}

// AI summary panel (PRD 20, 21). The summary is generated on demand
// from project data the signed-in user can already access, and it is
// always rendered under an explicit "AI-generated" label — never
// presented as a calculated metric like the analytics panel above it.
// When no provider is configured the server answers 503 and the panel
// says so, rather than showing a fabricated summary.
export default function AiSummaryPanel({
  organizationId,
  projectId,
}: {
  organizationId: string;
  projectId: string;
}) {
  const [summary, setSummary] = useState<AiSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function generateSummary() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/ai/summarize`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId }),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<AiSummary> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) {
        throw new Error(result?.error?.message ?? "The AI summary could not be produced.");
      }
      setSummary(result.data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The AI summary could not be produced.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="project-detail-section" aria-labelledby="ai-summary-title">
      <div className="project-section-heading">
        <div>
          <p className="eyebrow">AI-generated</p>
          <h3 id="ai-summary-title">AI summary</h3>
        </div>
      </div>
      <p className="project-section-copy">
        A summary generated from this project&apos;s tasks, milestones, activity, and comments you can access.
      </p>
      {summary ? (
        <p className="project-section-copy">{summary.summary}</p>
      ) : (
        <p className="project-section-copy">No summary generated yet.</p>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" onClick={generateSummary} disabled={pending}>
        {pending ? "Generating summary…" : summary ? "Regenerate summary" : "Generate AI summary"}
      </button>
    </section>
  );
}
