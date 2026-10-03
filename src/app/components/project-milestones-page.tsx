"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  canTransitionMilestoneStatus,
  MILESTONE_STATUSES,
  type MilestoneStatus,
} from "../../security/milestone-status.ts";
import ProjectWorkNav from "./project-work-nav";

interface MilestoneDependency {
  id: string;
  name: string;
  status: MilestoneStatus;
}

interface Milestone {
  id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: MilestoneStatus;
  version: number;
  completed_at: string | null;
  task_count: number;
  completed_task_count: number;
  progress_percent: number;
  dependencies: MilestoneDependency[];
}

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

export default function ProjectMilestonesPage({
  organizationId,
  projectId,
}: {
  organizationId: string;
  projectId: string;
}) {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, setPending] = useState("");
  const [createKey, setCreateKey] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const base = `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/milestones`;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(base, { cache: "no-store" });
        const result = (await response.json().catch(() => null)) as ApiResult<{
          can_manage: boolean;
          milestones: Milestone[];
        }> | null;
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!response.ok || !result?.data) {
          throw new Error(result?.error?.message ?? "Milestones could not be loaded.");
        }
        if (!cancelled) {
          setCanManage(result.data.can_manage);
          setMilestones(result.data.milestones);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Milestones could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [base, reloadKey]);

  async function createMilestone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const key = createKey || `milestone-${crypto.randomUUID()}`;
    setCreateKey(key);
    setPending("create");
    setError("");
    setMessage("");
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({
          name: String(formData.get("name") ?? ""),
          description: String(formData.get("description") ?? "") || null,
          startDate: String(formData.get("startDate") ?? "") || null,
          endDate: String(formData.get("endDate") ?? "") || null,
          dependencies: formData.getAll("dependencies").map(String),
        }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "Milestone could not be created.");
        return;
      }
      form.reset();
      setCreateKey("");
      setMessage("Milestone created.");
      setReloadKey((value) => value + 1);
    } catch {
      setError("The service could not be reached. Retry to safely finish this milestone creation.");
    } finally {
      setPending("");
    }
  }

  async function updateMilestone(
    milestone: Milestone,
    changes: Record<string, unknown>,
  ): Promise<boolean> {
    setPending(milestone.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${base}/${encodeURIComponent(milestone.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: milestone.version, ...changes }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return false;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "Milestone could not be updated.");
        if (response.status === 409) setReloadKey((value) => value + 1);
        return false;
      }
      setMessage("Milestone updated.");
      setReloadKey((value) => value + 1);
      return true;
    } catch {
      setError("The service could not be reached. Try again in a moment.");
      return false;
    } finally {
      setPending("");
    }
  }

  async function saveMilestone(event: FormEvent<HTMLFormElement>, milestone: Milestone) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await updateMilestone(milestone, {
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? "") || null,
      startDate: String(formData.get("startDate") ?? "") || null,
      endDate: String(formData.get("endDate") ?? "") || null,
      status: String(formData.get("status") ?? milestone.status),
      dependencies: formData.getAll("dependencies").map(String),
    });
  }

  return (
    <main className="auth-layout workspace-layout">
      <aside className="auth-story">
        <a className="brand" href="/" aria-label="Nexora home">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>Nexora</span>
        </a>
        <div className="auth-story-copy">
          <p className="eyebrow">Project planning</p>
          <h1>Make the next finish line clear.</h1>
          <p>Break the project into outcomes with dates, prerequisites, and progress tied to real tasks.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Private by design. Built for focused teams.</span>
        </div>
      </aside>

      <section className="auth-main" aria-label="Project milestones">
        <div className="workspace-card project-page-card milestone-page-card" aria-busy={loading}>
          <a className="secondary-link" href={`/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`}>
            Back to project
          </a>
          <p className="eyebrow workspace-greeting">Delivery plan</p>
          <div className="project-detail-heading">
            <div>
              <h2>Milestones</h2>
              <p>{milestones.length ? `${milestones.length} project checkpoints` : "Sequence outcomes and track completion."}</p>
            </div>
            <span className="project-status project-status-active">Project plan</span>
          </div>
          <ProjectWorkNav organizationId={organizationId} projectId={projectId} current="milestones" />

          {canManage && (
            <section className="project-detail-section" aria-labelledby="new-milestone-title">
              <div className="project-section-heading">
                <div>
                  <p className="eyebrow">Shape the delivery</p>
                  <h3 id="new-milestone-title">New milestone</h3>
                </div>
              </div>
              <form className="milestone-form" onSubmit={createMilestone}>
                <label className="form-field milestone-field-wide">
                  <span>Name</span>
                  <input name="name" maxLength={160} required disabled={Boolean(pending)} />
                </label>
                <label className="form-field milestone-field-wide">
                  <span>Description <small>Optional</small></span>
                  <textarea name="description" maxLength={10_000} rows={2} disabled={Boolean(pending)} />
                </label>
                <label className="form-field">
                  <span>Start date <small>Optional</small></span>
                  <input name="startDate" type="date" disabled={Boolean(pending)} />
                </label>
                <label className="form-field">
                  <span>End date <small>Optional</small></span>
                  <input name="endDate" type="date" disabled={Boolean(pending)} />
                </label>
                {milestones.length > 0 && (
                  <fieldset className="milestone-dependency-fieldset milestone-field-wide">
                    <legend>Prerequisite milestones <small>Optional</small></legend>
                    <div className="milestone-dependency-options">
                      {milestones.map((item) => (
                        <label className="check-option" key={item.id}>
                          <input name="dependencies" type="checkbox" value={item.id} disabled={Boolean(pending)} />
                          <span>{item.name}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
                <div className="project-form-actions milestone-field-wide">
                  <button className="primary-button" type="submit" disabled={Boolean(pending)}>
                    {pending === "create" ? "Creating..." : "Create milestone"}
                  </button>
                  <span className="workspace-note">Milestone creation is safe to retry if the connection drops.</span>
                </div>
              </form>
            </section>
          )}

          <section className="project-detail-section" aria-labelledby="milestone-list-title">
            <div className="project-section-heading">
              <div>
                <p className="eyebrow">Project sequence</p>
                <h3 id="milestone-list-title">Delivery checkpoints <span>{milestones.length}</span></h3>
              </div>
            </div>
            {loading ? (
              <p className="workspace-loading" role="status">Loading milestones...</p>
            ) : milestones.length ? (
              <div className="milestone-list">
                {milestones.map((milestone, index) => (
                  <article className="milestone-card" key={milestone.id}>
                    <div className="milestone-card-heading">
                      <div className="milestone-card-title">
                        <span className="milestone-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <h4>{milestone.name}</h4>
                          <p>{milestone.description || "No description has been added."}</p>
                        </div>
                      </div>
                      {canManage ? (
                        <label className="milestone-status-control">
                          <span className="sr-only">Status for {milestone.name}</span>
                          <select
                            value={milestone.status}
                            disabled={Boolean(pending)}
                            onChange={(event) => void updateMilestone(milestone, { status: event.target.value })}
                          >
                            {MILESTONE_STATUSES
                              .filter((status) => canTransitionMilestoneStatus(milestone.status, status))
                              .map((status) => <option key={status} value={status}>{formatStatus(status)}</option>)}
                          </select>
                        </label>
                      ) : (
                        <span className={`project-status project-status-${milestone.status.replaceAll("_", "-")}`}>
                          {formatStatus(milestone.status)}
                        </span>
                      )}
                    </div>

                    <div className="milestone-meta">
                      <span>{milestone.start_date ? `Starts ${formatDate(milestone.start_date)}` : "Start date not set"}</span>
                      <span>{milestone.end_date ? `Due ${formatDate(milestone.end_date)}` : "No end date"}</span>
                      <span>{milestone.task_count ? `${milestone.completed_task_count} of ${milestone.task_count} tasks complete` : "No linked tasks"}</span>
                    </div>
                    <progress
                      className="milestone-progress"
                      aria-label={`${milestone.name} task progress`}
                      value={milestone.progress_percent}
                      max={100}
                    />
                    {milestone.dependencies.length > 0 && (
                      <div className="milestone-prerequisites" aria-label="Prerequisite milestones">
                        <span>Depends on</span>
                        {milestone.dependencies.map((dependency) => (
                          <span className="milestone-prerequisite" key={dependency.id}>
                            {dependency.name} · {formatStatus(dependency.status)}
                          </span>
                        ))}
                      </div>
                    )}

                    {canManage && (
                      <details className="milestone-editor">
                        <summary>Edit milestone details</summary>
                        <form className="milestone-form" onSubmit={(event) => void saveMilestone(event, milestone)}>
                          <label className="form-field milestone-field-wide">
                            <span>Name</span>
                            <input name="name" defaultValue={milestone.name} maxLength={160} required disabled={Boolean(pending)} />
                          </label>
                          <label className="form-field milestone-field-wide">
                            <span>Description <small>Optional</small></span>
                            <textarea name="description" defaultValue={milestone.description ?? ""} maxLength={10_000} rows={2} disabled={Boolean(pending)} />
                          </label>
                          <label className="form-field">
                            <span>Start date</span>
                            <input name="startDate" type="date" defaultValue={milestone.start_date ?? ""} disabled={Boolean(pending)} />
                          </label>
                          <label className="form-field">
                            <span>End date</span>
                            <input name="endDate" type="date" defaultValue={milestone.end_date ?? ""} disabled={Boolean(pending)} />
                          </label>
                          <label className="form-field">
                            <span>Status</span>
                            <select name="status" defaultValue={milestone.status} disabled={Boolean(pending)}>
                              {MILESTONE_STATUSES
                                .filter((status) => canTransitionMilestoneStatus(milestone.status, status))
                                .map((status) => <option key={status} value={status}>{formatStatus(status)}</option>)}
                            </select>
                          </label>
                          {milestones.length > 1 && (
                            <fieldset className="milestone-dependency-fieldset milestone-field-wide">
                              <legend>Prerequisite milestones</legend>
                              <div className="milestone-dependency-options">
                                {milestones.filter((item) => item.id !== milestone.id).map((item) => (
                                  <label className="check-option" key={item.id}>
                                    <input
                                      name="dependencies"
                                      type="checkbox"
                                      value={item.id}
                                      defaultChecked={milestone.dependencies.some((dependency) => dependency.id === item.id)}
                                      disabled={Boolean(pending)}
                                    />
                                    <span>{item.name}</span>
                                  </label>
                                ))}
                              </div>
                            </fieldset>
                          )}
                          <div className="project-form-actions milestone-field-wide">
                            <button className="primary-button" type="submit" disabled={Boolean(pending)}>
                              {pending === milestone.id ? "Saving..." : "Save changes"}
                            </button>
                            <span className="project-version-note">Save checks version {milestone.version}.</span>
                          </div>
                        </form>
                      </details>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="project-empty">
                <span className="empty-mark" aria-hidden="true">◎</span>
                <h4>{canManage ? "Give the project a first checkpoint." : "No milestones are set yet."}</h4>
                <p>{canManage
                  ? "Create a milestone above, then connect tasks to turn progress into a live measure."
                  : "A project manager can add milestones and link the work that moves them forward."}</p>
              </div>
            )}
          </section>

          {error && <p className="form-message form-error" role="alert">{error}</p>}
          {message && <p className="form-message form-success" role="status" aria-live="polite">{message}</p>}
        </div>
        <footer className="auth-footer">Nexora - A clearer way to move work forward</footer>
      </section>
    </main>
  );
}

function formatStatus(status: MilestoneStatus): string {
  return status.replaceAll("_", " ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(`${value.slice(0, 10)}T00:00:00`));
}
