"use client";

import { useState } from "react";

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

interface ExtractedTask {
  title: string;
  owner?: string | null;
  deadline?: string | null;
}

interface ExtractionDraft {
  tasks: ExtractedTask[];
  decisions: string[];
  followUps: string[];
  risks: string[];
}

interface CreatedTask {
  id: string;
  title: string;
}

// AI meeting-notes extraction (PRD 19). Two explicit steps: generate
// returns a draft and creates NOTHING; only the confirm button creates
// tasks in this project, after the user reviewed the draft. Owners and
// deadlines from the notes are text only — they are never resolved to
// users or parsed into dates the notes did not state. Decisions,
// follow-ups, and risks are informational: they are shown with the
// confirmation result but are not separate records.
export default function AiExtractionPanel({
  organizationId,
  projectId,
}: {
  organizationId: string;
  projectId: string;
}) {
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState<ExtractionDraft | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [pending, setPending] = useState<"generate" | "confirm" | "">("");
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    tasks: CreatedTask[];
    decisions: string[];
    followUps: string[];
    risks: string[];
  } | null>(null);

  async function generateDraft() {
    setPending("generate");
    setError("");
    setCreated(null);
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/ai/extraction/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ notes }),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<{
        draft: ExtractionDraft;
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.draft) {
        throw new Error(result?.error?.message ?? "The extraction could not be produced.");
      }
      setDraft(result.data.draft);
      setIdempotencyKey(crypto.randomUUID());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The extraction could not be produced.");
    } finally {
      setPending("");
    }
  }

  async function confirmDraft() {
    if (!draft) return;
    setPending("confirm");
    setError("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/ai/extraction/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify({ draft }),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<{
        tasks: CreatedTask[];
        decisions: string[];
        followUps: string[];
        risks: string[];
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) {
        throw new Error(result?.error?.message ?? "The tasks could not be created from the extraction.");
      }
      setCreated(result.data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The tasks could not be created from the extraction.");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="project-detail-section" aria-labelledby="ai-extraction-title">
      <div className="project-section-heading">
        <div>
          <p className="eyebrow">AI-generated</p>
          <h3 id="ai-extraction-title">AI meeting-notes extraction</h3>
        </div>
      </div>
      <p className="project-section-copy">
        Paste meeting notes and review the AI-generated draft before anything is created. Confirming creates the
        draft&apos;s tasks in this project.
      </p>
      <label className="form-field">
        <span>Meeting notes</span>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          minLength={10}
          maxLength={10000}
          rows={5}
          required
        />
      </label>
      <button type="button" onClick={generateDraft} disabled={pending !== "" || notes.trim().length < 10}>
        {pending === "generate" ? "Extracting…" : "Extract tasks"}
      </button>
      {draft ? (
        <div>
          <p className="project-section-copy">
            Draft — nothing has been created yet. Review it and confirm to create the tasks.
          </p>
          <h4>Tasks</h4>
          <ul>
            {draft.tasks.map((task) => (
              <li key={task.title}>
                {task.title}
                {task.owner ? ` (suggested owner: ${task.owner})` : ""}
                {task.deadline ? ` (suggested deadline: ${task.deadline})` : ""}
              </li>
            ))}
          </ul>
          {draft.decisions.length > 0 ? (
            <>
              <h4>Decisions</h4>
              <ul>
                {draft.decisions.map((decision) => (
                  <li key={decision}>{decision}</li>
                ))}
              </ul>
            </>
          ) : null}
          {draft.followUps.length > 0 ? (
            <>
              <h4>Follow-ups</h4>
              <ul>
                {draft.followUps.map((followUp) => (
                  <li key={followUp}>{followUp}</li>
                ))}
              </ul>
            </>
          ) : null}
          {draft.risks.length > 0 ? (
            <>
              <h4>Risks</h4>
              <ul>
                {draft.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </>
          ) : null}
          <button type="button" onClick={confirmDraft} disabled={pending !== ""}>
            {pending === "confirm" ? "Creating tasks…" : "Create tasks from draft"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="form-message form-error" role="alert">
          {error}
        </p>
      ) : null}
      {created ? (
        <div>
          <p className="form-message form-success" role="status">
            Created {created.tasks.length} task{created.tasks.length === 1 ? "" : "s"}:{" "}
            {created.tasks.map((task) => task.title).join(", ")}
          </p>
          {created.decisions.length > 0 ? (
            <p className="project-section-copy">Decisions noted: {created.decisions.join("; ")}</p>
          ) : null}
          {created.followUps.length > 0 ? (
            <p className="project-section-copy">Follow-ups noted: {created.followUps.join("; ")}</p>
          ) : null}
          {created.risks.length > 0 ? (
            <p className="project-section-copy">Risks noted: {created.risks.join("; ")}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
