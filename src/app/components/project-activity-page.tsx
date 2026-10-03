"use client";

import { useEffect, useState } from "react";
import ProjectWorkNav from "./project-work-nav";

interface ActivityEvent {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
  target_name: string | null;
}

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

export default function ProjectActivityPage({
  organizationId,
  projectId,
}: {
  organizationId: string;
  projectId: string;
}) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const base = `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/activity`;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${base}?limit=50&offset=0`, { cache: "no-store" });
        const result = (await response.json().catch(() => null)) as ApiResult<{
          events: ActivityEvent[];
          pagination: { hasMore: boolean };
        }> | null;
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "Project activity could not be loaded.");
        if (!cancelled) {
          setEvents(result.data.events);
          setHasMore(result.data.pagination.hasMore);
          setOffset(result.data.events.length);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Project activity could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [base]);

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const response = await fetch(`${base}?limit=50&offset=${offset}`, { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        events: ActivityEvent[];
        pagination: { hasMore: boolean };
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      const page = result?.data;
      if (!response.ok || !page) throw new Error(result?.error?.message ?? "More activity could not be loaded.");
      setEvents((current) => [...current, ...page.events]);
      setOffset((current) => current + page.events.length);
      setHasMore(page.pagination.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "More activity could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <main className="project-work-layout">
      <div className="project-work-shell">
        <a className="secondary-link" href={`/organizations/${encodeURIComponent(organizationId)}`}>Back to workspace</a>
        <ProjectWorkNav organizationId={organizationId} projectId={projectId} current="activity" />
        <section className="project-panel project-activity-panel" aria-labelledby="project-activity-title">
          <p className="eyebrow">Project record</p>
          <h1 id="project-activity-title">Activity</h1>
          <p className="project-panel-copy">A chronological record of project, milestone, task, membership, and comment changes.</p>
          {loading ? <p className="workspace-loading" role="status">Loading project activity...</p>
            : error && !events.length ? <p className="form-message form-error" role="alert">{error}</p>
              : events.length ? (
                <ol className="project-activity-list">
                  {events.map((event) => (
                    <li className="project-activity-event" key={event.id}>
                      <span className="project-activity-marker" aria-hidden="true" />
                      <div>
                        <strong>{formatActivity(event)}</strong>
                        <p>{event.actor_name || "A project member"}{event.target_name ? ` · ${event.target_name}` : ""}</p>
                        <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : <p className="workspace-note">No activity has been recorded yet.</p>}
          {error && events.length > 0 && <p className="form-message form-error" role="alert">{error}</p>}
          {hasMore && (
            <button className="quiet-button activity-load-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading..." : "Load older activity"}
            </button>
          )}
        </section>
      </div>
    </main>
  );
}

function formatActivity(event: ActivityEvent): string {
  const labels: Record<string, string> = {
    "project.created": "Created the project",
    "project.updated": "Updated project details",
    "project.task_workflow.updated": "Updated the task workflow",
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
  return labels[event.action] ?? "Updated project work";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
