"use client";

import { useState } from "react";
import { SparklesIcon } from "./button-icons";

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

interface PlanningTask {
  title: string;
  description?: string;
  subtasks?: string[];
}

interface PlanningMilestone {
  name: string;
  description?: string;
  tasks: PlanningTask[];
}

interface PlanningDraft {
  milestones: PlanningMilestone[];
  dependencies?: { from: string; to: string }[];
}

interface CreatedProject {
  id: string;
  name: string;
}

// AI project planning. Two explicit steps, never one:
// generate returns a draft and creates NOTHING; only the confirm
// button creates the project, and only after the user reviewed the
// draft and named the project. The confirm carries a client-generated
// idempotency key so a retried click replays instead of duplicating
// the project.
export default function AiPlanningPanel({ organizationId }: { organizationId: string }) {
  const [goal, setGoal] = useState("");
  const [draft, setDraft] = useState<PlanningDraft | null>(null);
  const [projectName, setProjectName] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [pending, setPending] = useState<"generate" | "confirm" | "">("");
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedProject | null>(null);

  async function generatePlan() {
    setPending("generate");
    setError("");
    setCreated(null);
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/ai/planning/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal }),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<{
        draft: PlanningDraft;
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.draft) {
        throw new Error(result?.error?.message ?? "The AI plan could not be produced.");
      }
      setDraft(result.data.draft);
      setIdempotencyKey(crypto.randomUUID());
      setProjectName("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The AI plan could not be produced.");
    } finally {
      setPending("");
    }
  }

  async function confirmPlan() {
    if (!draft) return;
    setPending("confirm");
    setError("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/ai/planning/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify({ projectName, draft }),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<{
        project: CreatedProject;
        milestoneCount: number;
        taskCount: number;
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.project) {
        throw new Error(result?.error?.message ?? "The project could not be created from the plan.");
      }
      setCreated(result.data.project);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The project could not be created from the plan.");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="project-detail-section" aria-labelledby="ai-planning-title">
      <div className="project-section-heading">
        <div>
          <h3 id="ai-planning-title">AI project planning</h3>
        </div>
      </div>
      <p className="project-section-copy">
        Describe a goal and review the draft before anything is created. Confirming creates a new
        project with the draft&apos;s milestones, tasks, subtasks, and dependencies.
      </p>
      <label className="form-field">
        <span>Project goal</span>
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          minLength={10}
          maxLength={2000}
          rows={3}
          required
        />
      </label>
      <button type="button" onClick={generatePlan} disabled={pending !== "" || goal.trim().length < 10}><SparklesIcon />
        {pending === "generate" ? "Generating plan…" : "Generate plan"}
      </button>
      {draft ? (
        <div>
          <p className="project-section-copy">
            Draft — nothing has been created yet. Review it, name the project, and confirm.
          </p>
          {draft.milestones.map((milestone) => (
            <div key={milestone.name}>
              <h4>{milestone.name}</h4>
              {milestone.description ? <p className="project-section-copy">{milestone.description}</p> : null}
              <ul>
                {milestone.tasks.map((task) => (
                  <li key={task.title}>
                    {task.title}
                    {task.subtasks && task.subtasks.length > 0 ? (
                      <ul>
                        {task.subtasks.map((subtask) => (
                          <li key={subtask}>{subtask}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {draft.dependencies && draft.dependencies.length > 0 ? (
            <p className="project-section-copy">
              Dependencies: {draft.dependencies.map((edge) => `${edge.from} → ${edge.to}`).join("; ")}
            </p>
          ) : null}
          <label className="form-field">
            <span>Project name</span>
            <input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              minLength={1}
              maxLength={160}
              required
            />
          </label>
          <button
            type="button"
            onClick={confirmPlan}
            disabled={pending !== "" || projectName.trim().length === 0}
          ><SparklesIcon />
            {pending === "confirm" ? "Creating project…" : "Create project from plan"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="form-message form-error" role="alert">
          {error}
        </p>
      ) : null}
      {created ? (
        <p className="form-message form-success" role="status">
          Project created:{" "}
          <a href={`/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(created.id)}`}>
            {created.name}
          </a>
        </p>
      ) : null}
    </section>
  );
}
