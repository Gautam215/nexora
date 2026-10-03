"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ProjectStatus } from "../../security/project-status.ts";

interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  owner_name: string | null;
  start_date: string | null;
  target_date: string | null;
  viewer_role: string | null;
  can_manage: boolean;
  active_member_count: number;
}

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

const API_LIMIT = 50;

export default function OrganizationProjects({
  organizationId,
  canCreate,
}: {
  organizationId: string;
  canCreate: boolean;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadProjects() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/organizations/${encodeURIComponent(organizationId)}/projects?limit=${API_LIMIT}&offset=0`,
          { cache: "no-store" },
        );
        const result = (await response.json().catch(() => null)) as ApiResult<{
          projects: ProjectSummary[];
          pagination: { hasMore: boolean };
        }> | null;
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!response.ok || !result?.data) {
          throw new Error(result?.error?.message ?? "Projects could not be loaded.");
        }
        if (!cancelled) {
          setProjects(result.data.projects);
          setHasMore(result.data.pagination.hasMore);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Projects could not be loaded.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadProjects();
    return () => {
      cancelled = true;
    };
  }, [organizationId, refreshKey]);

  async function loadMore() {
    setLoadingMore(true);
    setError("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/projects?limit=${API_LIMIT}&offset=${projects.length}`,
        { cache: "no-store" },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<{
        projects: ProjectSummary[];
        pagination: { hasMore: boolean };
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) {
        throw new Error(result?.error?.message ?? "More projects could not be loaded.");
      }
      setProjects((current) => [...current, ...result.data!.projects]);
      setHasMore(result.data.pagination.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "More projects could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/projects`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            description: description || undefined,
            startDate: startDate || undefined,
            targetDate: targetDate || undefined,
          }),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "Project could not be created.");
        return;
      }
      setName("");
      setDescription("");
      setStartDate("");
      setTargetDate("");
      setShowForm(false);
      setMessage("Project created.");
      setRefreshKey((value) => value + 1);
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="projects-section" aria-labelledby="projects-title">
      <div className="project-section-heading">
        <div>
          <p className="eyebrow">Work in this space</p>
          <h3 id="projects-title">Projects <span>{projects.length}</span></h3>
        </div>
        {canCreate && (
          <button
            className="primary-button project-add-button"
            type="button"
            onClick={() => {
              setShowForm((visible) => !visible);
              setError("");
            }}
          >
            {showForm ? "Close" : "New project"}
          </button>
        )}
      </div>

      {showForm && canCreate && (
        <form className="project-create-form" onSubmit={createProject}>
          <label className="form-field project-field-wide">
            <span>Project name</span>
            <input
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={160}
              autoComplete="off"
              required
              disabled={pending}
            />
          </label>
          <label className="form-field project-field-wide">
            <span>Description <small>Optional</small></span>
            <textarea
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={10_000}
              rows={3}
              disabled={pending}
            />
          </label>
          <label className="form-field">
            <span>Start date <small>Optional</small></span>
            <input
              name="startDate"
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              disabled={pending}
            />
          </label>
          <label className="form-field">
            <span>Target date <small>Optional</small></span>
            <input
              name="targetDate"
              type="date"
              min={startDate || undefined}
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
              disabled={pending}
            />
          </label>
          <div className="project-form-actions project-field-wide">
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create project"}
            </button>
            <span className="workspace-note">You’ll be added as this project’s manager.</span>
          </div>
        </form>
      )}

      {loading ? (
        <p className="workspace-loading" role="status">Loading projects...</p>
      ) : projects.length ? (
        <div className="project-list">
          {projects.map((project) => (
            <a
              className="project-card"
              href={`/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(project.id)}`}
              key={project.id}
              aria-label={`Open project ${project.name}`}
            >
              <span className="project-icon" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
              <div className="project-card-copy">
                <div className="project-card-title">
                  <h4>{project.name}</h4>
                  <span className={`project-status project-status-${project.status.replaceAll("_", "-")}`}>
                    {formatStatus(project.status)}
                  </span>
                </div>
                <p>{project.description || "No description yet."}</p>
                <div className="project-card-meta">
                  <span>{project.viewer_role ?? "Project"}</span>
                  <span aria-hidden="true">/</span>
                  <span>Led by {project.owner_name || "project owner"}</span>
                  {project.target_date && <span>Target {formatDate(project.target_date)}</span>}
                </div>
              </div>
              <span className="project-member-count">
                {project.active_member_count} {project.active_member_count === 1 ? "person" : "people"}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <div className="project-empty">
          <span className="empty-mark" aria-hidden="true">+</span>
          <h4>{canCreate ? "A clear plan starts with one project." : "No projects have been shared with you yet."}</h4>
          <p>{canCreate
            ? "Create a project to give this workspace a focused place for goals and progress."
            : "A workspace manager can add you to a project when you need access."}</p>
        </div>
      )}

      {hasMore && !loading && (
        <button
          className="quiet-button project-load-more"
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading..." : "Load more projects"}
        </button>
      )}
      {error && <p className="form-message form-error" role="alert">{error}</p>}
      {message && <p className="form-message form-success" role="status" aria-live="polite">{message}</p>}
    </section>
  );
}

function formatStatus(status: ProjectStatus): string {
  return status.replaceAll("_", " ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(`${value}T00:00:00`));
}
