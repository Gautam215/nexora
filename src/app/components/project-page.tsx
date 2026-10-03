"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  canTransitionProjectStatus,
  PROJECT_STATUSES,
  type ProjectStatus,
} from "../../security/project-status.ts";
import type { ProjectAnalytics } from "../../security/project-analytics.ts";
import ProjectWorkNav from "./project-work-nav";

interface Project {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  owner_user_id: string;
  owner_name: string | null;
  start_date: string | null;
  target_date: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  viewer_role: string | null;
  can_manage: boolean;
  active_member_count: number;
}

interface ProjectMember {
  user_id: string;
  display_name: string;
  role: string;
  status: string;
  created_at: string;
}

interface OrganizationMember {
  user_id: string;
  display_name: string;
  role: string;
  status: string;
}

interface ProjectDraft {
  name: string;
  description: string;
  status: ProjectStatus;
  startDate: string;
  targetDate: string;
}

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

export default function ProjectPage({
  organizationId,
  projectId,
}: {
  organizationId: string;
  projectId: string;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [analytics, setAnalytics] = useState<ProjectAnalytics | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<OrganizationMember[]>([]);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [currentUserId, setCurrentUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, setPending] = useState("");
  const [selectedMember, setSelectedMember] = useState("");
  const [newMemberRole, setNewMemberRole] = useState("member");
  const [error, setError] = useState("");
  const [analyticsError, setAnalyticsError] = useState("");
  const [memberError, setMemberError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    setAnalytics(null);
    setAnalyticsError("");
    setAnalyticsLoading(true);

    async function loadAnalytics() {
      try {
        const response = await fetch(
          `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/analytics`,
          { cache: "no-store" },
        );
        const result = (await response.json().catch(() => null)) as ApiResult<ProjectAnalytics> | null;
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!response.ok || !result?.data) {
          throw new Error(result?.error?.message ?? "Project analytics could not be loaded.");
        }
        if (!cancelled) {
          setAnalytics(result.data);
          setAnalyticsError("");
        }
      } catch (reason) {
        if (!cancelled) {
          setAnalyticsError(reason instanceof Error ? reason.message : "Project analytics could not be loaded.");
        }
      } finally {
        if (!cancelled) setAnalyticsLoading(false);
      }
    }

    async function loadProject() {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`,
          { cache: "no-store" },
        );
        const result = (await response.json().catch(() => null)) as ApiResult<{
          project: Project;
          members: ProjectMember[];
        }> | null;
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!response.ok || !result?.data) {
          throw new Error(result?.error?.message ?? "Project could not be loaded.");
        }
        if (cancelled) return;
        setProject(result.data.project);
        setDraft(toDraft(result.data.project));
        setMembers(result.data.members);
        void loadAnalytics();

        if (result.data.project.can_manage) {
          const [workspaceResponse, sessionResponse] = await Promise.all([
            fetch(`/api/organizations/${encodeURIComponent(organizationId)}/members`, { cache: "no-store" }),
            fetch("/api/auth/session", { cache: "no-store" }),
          ]);
          if (workspaceResponse.status === 401 || sessionResponse.status === 401) {
            window.location.assign("/login");
            return;
          }
          const [workspaceResult, sessionResult] = await Promise.all([
            workspaceResponse.json().catch(() => null),
            sessionResponse.json().catch(() => null),
          ]) as [
            ApiResult<{ members: OrganizationMember[] }> | null,
            ApiResult<{ user: { id: string } }> | null,
          ];
          if (!cancelled) {
            if (workspaceResponse.ok && workspaceResult?.data) {
              setWorkspaceMembers(workspaceResult.data.members);
              setMemberError("");
            } else {
              setMemberError(workspaceResult?.error?.message ?? "Workspace members could not be loaded.");
            }
            if (sessionResponse.ok && sessionResult?.data) {
              setCurrentUserId(sessionResult.data.user.id);
            }
          }
        } else if (!cancelled) {
          setWorkspaceMembers([]);
          setMemberError("");
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Project could not be loaded.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadProject();
    return () => {
      cancelled = true;
    };
  }, [organizationId, projectId, reloadKey]);

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !draft) return;
    setPending("project");
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: project.version,
            name: draft.name,
            description: draft.description || null,
            status: draft.status,
            startDate: draft.startDate || null,
            targetDate: draft.targetDate || null,
          }),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<{
        project: Project;
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) {
        setError(result?.error?.message ?? "Project details could not be saved.");
        if (response.status === 409) setReloadKey((value) => value + 1);
        return;
      }
      setProject(result.data.project);
      setDraft(toDraft(result.data.project));
      setMessage("Project details saved.");
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending("");
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMember) return;
    setPending("add-member");
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/members`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: selectedMember, role: newMemberRole }),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "Project member could not be added.");
        return;
      }
      setSelectedMember("");
      setNewMemberRole("member");
      setMessage("Project member added.");
      setReloadKey((value) => value + 1);
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending("");
    }
  }

  async function updateMember(userId: string, changes: { role?: string; status?: string }) {
    setPending(userId);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(changes),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "Project access could not be updated.");
        return;
      }
      setMessage("Project access updated.");
      setReloadKey((value) => value + 1);
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending("");
    }
  }

  const memberIds = new Set(members.map((member) => member.user_id));
  const availableMembers = workspaceMembers.filter(
    (member) => member.status === "active" && !memberIds.has(member.user_id),
  );
  const canManage = project?.can_manage === true;

  return (
    <main className="auth-layout workspace-layout">
      <aside className="auth-story">
        <a className="brand" href="/" aria-label="Nexora home">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>Nexora</span>
        </a>
        <div className="auth-story-copy">
          <p className="eyebrow">Project workspace</p>
          <h1>Make progress visible.</h1>
          <p>Keep the goal, ownership, and access for each piece of work in one focused place.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Private by design. Built for focused teams.</span>
        </div>
      </aside>

      <section className="auth-main" aria-label="Project details">
        <div className="workspace-card project-page-card" aria-busy={loading}>
          <a className="secondary-link" href={`/organizations/${encodeURIComponent(organizationId)}`}>
            Back to workspace
          </a>

          {loading && !project ? (
            <p className="workspace-loading" role="status">Loading project...</p>
          ) : error && !project ? (
            <p className="form-message form-error" role="alert">{error}</p>
          ) : project && draft ? (
            <>
              <p className="eyebrow workspace-greeting">Project overview</p>
              <div className="project-detail-heading">
                <div>
                  <h2>{project.name}</h2>
                  <p>Workspace project · version {project.version}</p>
                </div>
                <span className={`project-status project-status-${project.status.replaceAll("_", "-")}`}>
                  {formatStatus(project.status)}
                </span>
              </div>
              <p className="project-detail-description">
                {project.description || "No project description has been added."}
              </p>
              <ProjectWorkNav organizationId={organizationId} projectId={projectId} current="overview" />
              <div className="project-facts">
                <div><span>Owner</span><strong>{project.owner_name || "Project owner"}</strong></div>
                <div><span>Your access</span><strong>{project.viewer_role || "Workspace manager"}</strong></div>
                <div><span>People</span><strong>{project.active_member_count}</strong></div>
                <div><span>Target</span><strong>{project.target_date ? formatDate(project.target_date) : "Not set"}</strong></div>
              </div>

              <ProjectAnalyticsPanel
                organizationId={organizationId}
                projectId={projectId}
                analytics={analytics}
                loading={analyticsLoading}
                error={analyticsError}
              />

              <section className="project-detail-section" aria-labelledby="project-details-title">
                <div className="project-section-heading">
                  <div>
                    <p className="eyebrow">Plan and timing</p>
                    <h3 id="project-details-title">Project details</h3>
                  </div>
                </div>
                {canManage ? (
                  <form className="project-edit-form" onSubmit={saveProject}>
                    <label className="form-field project-field-wide">
                      <span>Project name</span>
                      <input
                        value={draft.name}
                        maxLength={160}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                        required
                        disabled={pending === "project"}
                      />
                    </label>
                    <label className="form-field project-field-wide">
                      <span>Description</span>
                      <textarea
                        value={draft.description}
                        maxLength={10_000}
                        rows={3}
                        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                        disabled={pending === "project"}
                      />
                    </label>
                    <label className="form-field">
                      <span>Status</span>
                      <select
                        value={draft.status}
                        onChange={(event) => setDraft({ ...draft, status: event.target.value as ProjectStatus })}
                        disabled={pending === "project"}
                      >
                        {PROJECT_STATUSES
                          .filter((status) => canTransitionProjectStatus(project.status, status))
                          .map((status) => <option key={status} value={status}>{formatStatus(status)}</option>)}
                      </select>
                    </label>
                    <span className="project-version-note">Saving checks version {project.version} to avoid overwriting newer changes.</span>
                    <label className="form-field">
                      <span>Start date</span>
                      <input
                        type="date"
                        value={draft.startDate}
                        onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
                        disabled={pending === "project"}
                      />
                    </label>
                    <label className="form-field">
                      <span>Target date</span>
                      <input
                        type="date"
                        min={draft.startDate || undefined}
                        value={draft.targetDate}
                        onChange={(event) => setDraft({ ...draft, targetDate: event.target.value })}
                        disabled={pending === "project"}
                      />
                    </label>
                    <div className="project-form-actions project-field-wide">
                      <button className="primary-button" type="submit" disabled={Boolean(pending)}>
                        {pending === "project" ? "Saving..." : "Save details"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="project-readonly-grid">
                    <div><span>Start date</span><strong>{project.start_date ? formatDate(project.start_date) : "Not set"}</strong></div>
                    <div><span>Target date</span><strong>{project.target_date ? formatDate(project.target_date) : "Not set"}</strong></div>
                    <p className="workspace-note">Your project role is {project.viewer_role}; only project managers can edit these details.</p>
                  </div>
                )}
              </section>

              <section className="project-detail-section" aria-labelledby="project-people-title">
                <div className="project-section-heading">
                  <div>
                    <p className="eyebrow">Scoped access</p>
                    <h3 id="project-people-title">Project people <span>{members.length}</span></h3>
                  </div>
                </div>
                {canManage && (
                  <>
                    <p className="project-section-copy">Only active workspace members can be assigned here. Removing project access does not remove workspace access.</p>
                    {availableMembers.length > 0 ? (
                      <form className="project-member-form" onSubmit={addMember}>
                        <label className="form-field">
                          <span>Add a workspace member</span>
                          <select
                            value={selectedMember}
                            onChange={(event) => setSelectedMember(event.target.value)}
                            required
                            disabled={Boolean(pending)}
                          >
                            <option value="">Choose a person</option>
                            {availableMembers.map((member) => (
                              <option key={member.user_id} value={member.user_id}>
                                {member.display_name} · {member.role}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="form-field">
                          <span>Project role</span>
                          <select
                            value={newMemberRole}
                            onChange={(event) => setNewMemberRole(event.target.value)}
                            disabled={Boolean(pending)}
                          >
                            <option value="manager">Manager</option>
                            <option value="member">Member</option>
                            <option value="viewer">Viewer</option>
                          </select>
                        </label>
                        <button className="primary-button" type="submit" disabled={Boolean(pending) || !selectedMember}>
                          {pending === "add-member" ? "Adding..." : "Add person"}
                        </button>
                      </form>
                    ) : memberError ? (
                      <p className="form-message form-error" role="alert">{memberError}</p>
                    ) : loading ? (
                      <p className="workspace-loading" role="status">Loading workspace members...</p>
                    ) : (
                      <p className="workspace-note">Everyone in the workspace is already assigned to this project.</p>
                    )}
                  </>
                )}

                {members.length ? (
                  <div className="team-list project-member-list">
                    {members.map((member) => {
                      const protectedMember = member.user_id === project.owner_user_id || member.user_id === currentUserId;
                      return (
                        <article className="team-row" key={member.user_id}>
                          <div className="member-avatar" aria-hidden="true">{member.display_name.slice(0, 1).toUpperCase()}</div>
                          <div className="member-identity">
                            <strong>{member.display_name}</strong>
                            <span>{member.status === "active" ? member.role : "Project access disabled"}</span>
                          </div>
                          {canManage && !protectedMember ? (
                            <div className="member-controls">
                              <select
                                aria-label={`Project role for ${member.display_name}`}
                                value={member.role}
                                disabled={Boolean(pending)}
                                onChange={(event) => void updateMember(member.user_id, { role: event.target.value })}
                              >
                                <option value="manager">Manager</option>
                                <option value="member">Member</option>
                                <option value="viewer">Viewer</option>
                              </select>
                              <button
                                className="quiet-button"
                                type="button"
                                disabled={Boolean(pending)}
                                onClick={() => void updateMember(member.user_id, {
                                  status: member.status === "active" ? "disabled" : "active",
                                })}
                              >
                                {member.status === "active" ? "Disable" : "Restore"}
                              </button>
                            </div>
                          ) : (
                            <span className={`role-pill ${member.status === "disabled" ? "status-disabled" : ""}`}>
                              {member.status === "active" ? member.role : "disabled"}
                            </span>
                          )}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="workspace-note">No project members are available.</p>
                )}
              </section>

              {error && <p className="form-message form-error" role="alert">{error}</p>}
              {message && <p className="form-message form-success" role="status" aria-live="polite">{message}</p>}
            </>
          ) : null}
        </div>
        <footer className="auth-footer">Nexora - A clearer way to move work forward</footer>
      </section>
    </main>
  );
}

function toDraft(project: Project): ProjectDraft {
  return {
    name: project.name,
    description: project.description ?? "",
    status: project.status,
    startDate: project.start_date ?? "",
    targetDate: project.target_date ?? "",
  };
}

function ProjectAnalyticsPanel({
  organizationId,
  projectId,
  analytics,
  loading,
  error,
}: {
  organizationId: string;
  projectId: string;
  analytics: ProjectAnalytics | null;
  loading: boolean;
  error: string;
}) {
  const projectBase = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`;

  return (
    <section className="project-analytics" aria-labelledby="project-analytics-title" aria-busy={loading}>
      <div className="project-analytics-heading">
        <div>
          <p className="eyebrow">Delivery snapshot</p>
          <h3 id="project-analytics-title">Project dashboard</h3>
        </div>
        {analytics && <span className="analytics-as-of">As of {formatDate(analytics.as_of_date)}</span>}
      </div>
      <p className="analytics-method-note">Calculated from project records. No AI-generated insights.</p>

      {loading && !analytics ? <p className="workspace-loading" role="status">Calculating project metrics...</p>
        : error && !analytics ? <p className="form-message form-error" role="alert">{error}</p>
          : analytics ? (
            <>
              <div className="analytics-kpis">
                <article className="analytics-kpi">
                  <span>Project progress</span>
                  <strong>{analytics.progress_percent === null ? "—" : `${analytics.progress_percent}%`}</strong>
                  <p>{analytics.tasks.total === 0
                    ? "No tasks yet"
                    : `${analytics.tasks.completed} of ${analytics.tasks.total} tasks complete`}</p>
                  {analytics.progress_percent !== null && (
                    <progress className="analytics-progress" aria-label="Project task progress"
                      value={analytics.progress_percent} max={100} />
                  )}
                </article>
                <article className="analytics-kpi">
                  <span>Overdue tasks</span>
                  <strong>{analytics.tasks.overdue}</strong>
                  <p>{analytics.tasks.overdue === 1 ? "Open task past its due date" : "Open tasks past their due date"}</p>
                  <a href={`${projectBase}/tasks?view=list`}>Review task list</a>
                </article>
                <article className="analytics-kpi">
                  <span>Milestones complete</span>
                  <strong>{analytics.milestones.completed}<small> / {analytics.milestones.total}</small></strong>
                  <p>{analytics.milestones.overdue
                    ? `${analytics.milestones.overdue} milestone${analytics.milestones.overdue === 1 ? "" : "s"} past end date`
                    : "Based on milestone status"}</p>
                  <a href={`${projectBase}/milestones`}>View milestones</a>
                </article>
                <article className="analytics-kpi">
                  <span>Project health</span>
                  <strong className={`analytics-health analytics-health-${analytics.health.status.replaceAll("_", "-")}`}>
                    {formatHealth(analytics.health.status)}
                  </strong>
                  <p>{analytics.health.reason}</p>
                </article>
              </div>

              <div className="analytics-grid">
                <section className="analytics-panel" aria-labelledby="analytics-milestones-title">
                  <div className="analytics-panel-heading">
                    <h4 id="analytics-milestones-title">Milestone progress</h4>
                    <a href={`${projectBase}/milestones`}>All milestones</a>
                  </div>
                  {analytics.milestones.items.length ? (
                    <ul className="analytics-milestone-list">
                      {analytics.milestones.items.map((milestone) => (
                        <li key={milestone.id}>
                          <div className="analytics-row-title">
                            <strong>{milestone.name}</strong>
                            <span>{milestone.status.replaceAll("_", " ")}</span>
                          </div>
                          <p>{milestone.progress_percent === null
                            ? "No linked tasks"
                            : `${milestone.completed_task_count} of ${milestone.task_count} linked tasks complete`}</p>
                          {milestone.progress_percent !== null && (
                            <progress className="analytics-progress" aria-label={`${milestone.name} progress`}
                              value={milestone.progress_percent} max={100} />
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="analytics-empty">No milestones have been created.</p>}
                  {analytics.milestones.total > analytics.milestones.items.length && (
                    <p className="analytics-footnote">Showing the next {analytics.milestones.items.length} of {analytics.milestones.total} milestones.</p>
                  )}
                </section>

                <section className="analytics-panel" aria-labelledby="analytics-workload-title">
                  <div className="analytics-panel-heading">
                    <h4 id="analytics-workload-title">Assigned workload</h4>
                    <span>{analytics.workload.members.length} people</span>
                  </div>
                  {analytics.workload.members.length ? (
                    <ul className="analytics-workload-list">
                      {analytics.workload.members.map((member) => (
                        <li key={member.user_id}>
                          <span className="analytics-person-mark" aria-hidden="true">{member.display_name.slice(0, 1).toUpperCase()}</span>
                          <div className="analytics-workload-person">
                            <strong>{member.display_name}</strong>
                            <span>{member.status === "active" ? "Active" : "Project access disabled"}</span>
                          </div>
                          <div className="analytics-workload-value">
                            <strong>{member.open_task_count} open</strong>
                            <span>{member.estimated_task_count === 0
                              ? "No estimates"
                              : `${formatHours(member.estimated_effort_hours)} estimated`}</span>
                            {member.unestimated_task_count > 0 && <span>{member.unestimated_task_count} without estimate</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="analytics-empty">No project members are available.</p>}
                  <p className="analytics-unassigned">
                    Unassigned: {analytics.workload.unassigned.open_task_count} open task{analytics.workload.unassigned.open_task_count === 1 ? "" : "s"}
                    {analytics.workload.unassigned.unestimated_task_count > 0
                      ? ` · ${analytics.workload.unassigned.unestimated_task_count} without effort estimate`
                      : ""}
                  </p>
                  <p className="analytics-footnote">Effort totals use estimates on open tasks; capacity targets are not stored.</p>
                </section>

                <section className="analytics-panel" aria-labelledby="analytics-deadlines-title">
                  <div className="analytics-panel-heading">
                    <h4 id="analytics-deadlines-title">Upcoming deadlines</h4>
                    <span>Next {analytics.deadlines.length}</span>
                  </div>
                  {analytics.deadlines.length ? (
                    <ul className="analytics-deadline-list">
                      {analytics.deadlines.map((deadline) => (
                        <li key={`${deadline.kind}-${deadline.id}`}>
                          <a href={deadline.kind === "task"
                            ? `${projectBase}/tasks?view=list`
                            : deadline.kind === "milestone" ? `${projectBase}/milestones` : projectBase}>
                            <span className="analytics-deadline-date">{formatDate(deadline.due_date)}</span>
                            <span className="analytics-deadline-name">{deadline.title}</span>
                            <span className="analytics-deadline-kind">{deadline.kind === "project" ? "target" : deadline.kind}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="analytics-empty">No open task or milestone deadlines are scheduled.</p>}
                </section>

                <section className="analytics-panel" aria-labelledby="analytics-activity-title">
                  <div className="analytics-panel-heading">
                    <h4 id="analytics-activity-title">Team activity</h4>
                    <span>{analytics.activity.last_7_days_count} in 7 days</span>
                  </div>
                  {analytics.activity.events.length ? (
                    <ul className="analytics-activity-list">
                      {analytics.activity.events.map((event) => (
                        <li key={event.id}>
                          <strong>{formatActivity(event.action)}</strong>
                          <span>{event.actor_name || "A project member"}{event.target_name ? ` · ${event.target_name}` : ""}</span>
                          <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="analytics-empty">No activity has been recorded in the last 7 days.</p>}
                  <a className="analytics-panel-link" href={`${projectBase}/activity`}>Open activity history</a>
                </section>
              </div>
              {error && <p className="form-message form-error" role="alert">{error}</p>}
            </>
          ) : null}
    </section>
  );
}

function formatStatus(status: ProjectStatus): string {
  return status.replaceAll("_", " ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(`${value.slice(0, 10)}T00:00:00`));
}

function formatHealth(status: ProjectAnalytics["health"]["status"]): string {
  const labels: Record<ProjectAnalytics["health"]["status"], string> = {
    on_track: "On track",
    at_risk: "At risk",
    no_target_date: "No target date",
    planned: "Planned",
    on_hold: "On hold",
    completed: "Complete",
    archived: "Archived",
  };
  return labels[status];
}

function formatHours(value: string): string {
  const hours = Number(value);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(hours)} h`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(value));
}

function formatActivity(action: string): string {
  const labels: Record<string, string> = {
    "project.created": "Created the project",
    "project.updated": "Updated project details",
    "project.member.added": "Added a project member",
    "project.member.updated": "Updated project access",
    "milestone.created": "Created a milestone",
    "milestone.updated": "Updated a milestone",
    "milestone.completed": "Completed a milestone",
    "milestone.reopened": "Reopened a milestone",
    "task.created": "Created a task",
    "task.updated": "Updated a task",
    "task.assigned": "Changed a task assignment",
    "task.status_changed": "Changed a task status",
    "task.archived": "Archived a task",
    "task.comment_created": "Added a task comment",
    "task.file_uploaded": "Attached a task file",
    "task.file_replaced": "Replaced a task file",
    "task.file_deleted": "Removed a task file",
  };
  return labels[action] ?? "Updated project work";
}
