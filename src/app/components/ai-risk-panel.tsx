"use client";

import { useState } from "react";

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

interface AiRisk {
  title: string;
  detail: string;
  severity: "low" | "medium" | "high";
}

// AI risk analysis (PRD 21). Read-only: nothing is created or
// changed. Every finding is labelled AI-generated and worded as a
// possibility, never as a confirmed fact.
export default function AiRiskPanel({
  organizationId,
  projectId,
}: {
  organizationId: string;
  projectId: string;
}) {
  const [risks, setRisks] = useState<AiRisk[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function analyze() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/organizations/${encodeURIComponent(organizationId)}/ai/risk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{ risks: AiRisk[] }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.risks) {
        throw new Error(result?.error?.message ?? "The risk analysis could not be produced.");
      }
      setRisks(result.data.risks);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The risk analysis could not be produced.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="project-detail-section" aria-labelledby="ai-risk-title">
      <div className="project-section-heading">
        <div>
          <p className="eyebrow">AI-generated</p>
          <h3 id="ai-risk-title">AI risk analysis</h3>
        </div>
      </div>
      <p className="project-section-copy">
        Possible risks for this project — possibilities, not confirmed facts. Review them against the actual work
        before acting.
      </p>
      <button type="button" onClick={analyze} disabled={pending}>
        {pending ? "Analyzing…" : risks ? "Refresh analysis" : "Analyze risks"}
      </button>
      {risks ? (
        risks.length === 0 ? (
          <p className="project-section-copy">No risks identified in the current project data.</p>
        ) : (
          <ul>
            {risks.map((risk) => (
              <li key={risk.title}>
                <strong>{risk.title}</strong> ({risk.severity}) — {risk.detail}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {error ? (
        <p className="form-message form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
