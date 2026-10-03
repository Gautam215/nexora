"use client";

import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import ProjectWorkNav from "./project-work-nav";

type TaskPriority = "low" | "medium" | "high" | "urgent";
type TaskView = "board" | "list";

interface TaskDependency {
  id: string;
  title: string;
  status_name: string;
  is_done: boolean;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  workflow_status_id: string;
  status_name: string;
  status_sort_order: number;
  status_is_done: boolean;
  priority: TaskPriority;
  assignee_user_id: string | null;
  assignee_name: string | null;
  creator_name: string | null;
  milestone_id: string | null;
  milestone_name: string | null;
  milestone_status: string | null;
  parent_task_id: string | null;
  parent_title: string | null;
  labels: string[];
  due_date: string | null;
  estimated_effort_hours: string | null;
  position: number;
  version: number;
  completed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  subtask_count: number;
  completed_subtask_count: number;
  dependencies: TaskDependency[];
  unresolved_dependency_count: number;
}

interface TaskStatus {
  id: string;
  name: string;
  sort_order: number;
  is_done: boolean;
  task_count: number;
  total_task_count: number;
}

interface Member {
  user_id: string;
  display_name: string;
  role: string;
  status: string;
}

interface Milestone {
  id: string;
  name: string;
  status: string;
}

interface TaskActivity {
  id: string;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
}

interface TaskComment {
  id: string;
  body: string;
  created_at: string;
  author_name: string | null;
  mentions: Array<{ user_id: string; display_name: string }>;
}

interface TaskFile {
  id: string;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  uploaded_by_name: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

interface TaskFilters {
  q: string;
  statusId: string;
  priority: string;
  assigneeId: string;
  milestoneId: string;
  label: string;
}

interface WorkflowDraft {
  id?: string;
  name: string;
  isDone: boolean;
}

const EMPTY_FILTERS: TaskFilters = {
  q: "",
  statusId: "",
  priority: "",
  assigneeId: "",
  milestoneId: "",
  label: "",
};

const PRIORITIES: TaskPriority[] = ["urgent", "high", "medium", "low"];

export default function ProjectTasksPage({
  organizationId,
  projectId,
  initialView,
  initialQuery,
}: {
  organizationId: string;
  projectId: string;
  initialView: TaskView;
  initialQuery?: string;
}) {
  const [view] = useState<TaskView>(initialView);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [statuses, setStatuses] = useState<TaskStatus[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [canWork, setCanWork] = useState(false);
  const [projectStatus, setProjectStatus] = useState("planned");
  const [workflowVersion, setWorkflowVersion] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [filters, setFilters] = useState<TaskFilters>(() => ({ ...EMPTY_FILTERS, q: initialQuery ?? "" }));
  const [filterDraft, setFilterDraft] = useState<TaskFilters>(() => ({ ...EMPTY_FILTERS, q: initialQuery ?? "" }));
  const [sort, setSort] = useState("updatedAt");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createKey, setCreateKey] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraft[]>([]);

  const base = `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/tasks`;
  const milestoneBase = `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/milestones`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  if (view === "list") {
    query.set("sort", sort);
    query.set("direction", ["updatedAt", "createdAt"].includes(sort) ? "desc" : "asc");
  }
  query.set("limit", "100");
  const queryString = query.toString();
  const workAllowed = canWork && !["completed", "archived"].includes(projectStatus);
  const canReorder = workAllowed && view === "board" && !hasMore && !Object.values(filters).some(Boolean);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      setSelectedIds([]);
      try {
        const [taskResponse, milestoneResponse] = await Promise.all([
          fetch(`${base}?${queryString}`, { cache: "no-store" }),
          fetch(milestoneBase, { cache: "no-store" }),
        ]);
        if (taskResponse.status === 401 || milestoneResponse.status === 401) {
          window.location.assign("/login");
          return;
        }
        const [taskResult, milestoneResult] = await Promise.all([
          taskResponse.json().catch(() => null),
          milestoneResponse.json().catch(() => null),
        ]) as [ApiResult<{
          can_manage: boolean;
          can_work: boolean;
          project_status: string;
          workflow_version: number;
          statuses: TaskStatus[];
          members: Member[];
          tasks: Task[];
          pagination: { hasMore: boolean };
        }> | null, ApiResult<{ milestones: Milestone[] }> | null];
        if (!taskResponse.ok || !taskResult?.data) {
          throw new Error(taskResult?.error?.message ?? "Tasks could not be loaded.");
        }
        if (!milestoneResponse.ok || !milestoneResult?.data) {
          throw new Error(milestoneResult?.error?.message ?? "Milestones could not be loaded.");
        }
        if (!cancelled) {
          setCanManage(taskResult.data.can_manage);
          setCanWork(taskResult.data.can_work);
          setProjectStatus(taskResult.data.project_status);
          setWorkflowVersion(taskResult.data.workflow_version);
          setStatuses(taskResult.data.statuses);
          setMembers(taskResult.data.members);
          setTasks(taskResult.data.tasks);
          setMilestones(milestoneResult.data.milestones);
          setHasMore(taskResult.data.pagination.hasMore);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Tasks could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [base, milestoneBase, queryString, reloadKey]);

  async function loadMore() {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const nextQuery = new URLSearchParams(queryString);
      nextQuery.set("offset", String(tasks.length));
      const response = await fetch(`${base}?${nextQuery}`, { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        tasks: Task[];
        pagination: { hasMore: boolean };
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "More tasks could not be loaded.");
      setTasks((current) => [...current, ...result.data!.tasks]);
      setHasMore(result.data.pagination.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "More tasks could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = readTaskDraft(new FormData(form));
    const key = createKey || `task-${crypto.randomUUID()}`;
    setCreateKey(key);
    setPending("create");
    setError("");
    setMessage("");
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "Task could not be created.");
        return;
      }
      form.reset();
      setCreating(false);
      setCreateKey("");
      setMessage("Task created.");
      setReloadKey((value) => value + 1);
    } catch {
      setError("The service could not be reached. Retry with the same details to safely finish this task creation.");
    } finally {
      setPending("");
    }
  }

  async function updateTask(task: Task, changes: Record<string, unknown>) {
    setPending(task.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${base}/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: task.version, ...changes }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return false;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "Task could not be updated.");
        if (response.status === 409) setReloadKey((value) => value + 1);
        return false;
      }
      setMessage("Task updated.");
      setReloadKey((value) => value + 1);
      return true;
    } catch {
      setError("The service could not be reached. Try again in a moment.");
      return false;
    } finally {
      setPending("");
    }
  }

  async function saveTask(event: FormEvent<HTMLFormElement>, task: Task | null) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = readTaskDraft(new FormData(form));
    if (!task) {
      await createTask(event);
      return;
    }
    const saved = await updateTask(task, payload);
    if (saved) form.reset();
  }

  async function archiveTask(task: Task) {
    if (!window.confirm(`Archive "${task.title}"? It will leave the active project views.`)) return;
    setPending(task.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${base}/${encodeURIComponent(task.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: task.version }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "Task could not be archived.");
        if (response.status === 409) setReloadKey((value) => value + 1);
        return;
      }
      setMessage("Task archived.");
      setReloadKey((value) => value + 1);
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending("");
    }
  }

  async function updatePriorityForSelection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const priority = String(formData.get("priority") ?? "") as TaskPriority;
    const selected = tasks.filter((task) => selectedIds.includes(task.id));
    if (!selected.length) return;
    setPending("bulk");
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${base}/bulk`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tasks: selected.map((task) => ({ id: task.id, expectedVersion: task.version })),
          priority,
        }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "The selected tasks could not be updated.");
        if (response.status === 409) setReloadKey((value) => value + 1);
        return;
      }
      setSelectedIds([]);
      setMessage(`${selected.length} task${selected.length === 1 ? "" : "s"} updated.`);
      setReloadKey((value) => value + 1);
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending("");
    }
  }

  async function updateWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedNames = workflowDraft.map((item) => item.name.trim().toLocaleLowerCase("en-US"));
    if (workflowDraft.length < 2 || workflowDraft.filter((item) => item.isDone).length !== 1) {
      setError("Keep at least two columns and choose exactly one completion column.");
      return;
    }
    if (workflowDraft.some((item) => !item.name.trim()) || new Set(normalizedNames).size !== normalizedNames.length) {
      setError("Column names must be filled in and unique.");
      return;
    }
    setPending("workflow");
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${base}/workflow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: workflowVersion, statuses: workflowDraft }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setError(result?.error?.message ?? "Workflow columns could not be saved.");
        if (response.status === 409) setReloadKey((value) => value + 1);
        return;
      }
      setWorkflowOpen(false);
      setMessage("Workflow columns saved.");
      setReloadKey((value) => value + 1);
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending("");
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters({ ...filterDraft });
  }

  function clearFilters() {
    setFilterDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  }

  function beginWorkflowEdit() {
    setWorkflowDraft(statuses.map(({ id, name, is_done }) => ({ id, name, isDone: is_done })));
    setWorkflowOpen((open) => !open);
  }

  function updateWorkflowDraft(index: number, changes: Partial<WorkflowDraft>) {
    setWorkflowDraft((current) => current.map((status, itemIndex) => {
      if (changes.isDone) return { ...status, isDone: itemIndex === index };
      return itemIndex === index ? { ...status, ...changes } : status;
    }));
  }

  function moveWorkflowStatus(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= workflowDraft.length) return;
    setWorkflowDraft((current) => {
      const reordered = [...current];
      [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
      return reordered;
    });
  }

  function dropTask(draggedId: string, statusId: string, beforeTaskId?: string) {
    if (!canReorder || draggedId === beforeTaskId) return;
    const dragged = tasks.find((task) => task.id === draggedId);
    if (!dragged || dragged.milestone_status === "completed") return;
    const destination = tasks
      .filter((task) => task.workflow_status_id === statusId && task.id !== draggedId)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const beforeIndex = beforeTaskId ? destination.findIndex((task) => task.id === beforeTaskId) : -1;
    const position = beforeIndex < 0 ? destination.length : beforeIndex;
    void updateTask(dragged, { statusId, position });
  }

  const selectedCount = selectedIds.length;
  const projectBase = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`;

  return (
    <main className="auth-layout workspace-layout">
      <aside className="auth-story">
        <a className="brand" href="/" aria-label="Nexora home">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>Nexora</span>
        </a>
        <div className="auth-story-copy">
          <p className="eyebrow">Project execution</p>
          <h1>Turn commitments into the next clear action.</h1>
          <p>Give each task an owner, a place in the workflow, and a visible path through the work.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Private by design. Built for focused teams.</span>
        </div>
      </aside>

      <section className="auth-main" aria-label="Project tasks">
        <div className="workspace-card project-page-card task-page-card" aria-busy={loading}>
          <a className="secondary-link" href={projectBase}>Back to project</a>
          <p className="eyebrow workspace-greeting">Project execution</p>
          <div className="project-detail-heading">
            <div>
              <h2>Tasks</h2>
              <p>{tasks.length ? `${tasks.length}${hasMore ? "+" : ""} visible tasks` : "Plan the work and keep ownership clear."}</p>
            </div>
            <span className={`project-status project-status-${projectStatus.replaceAll("_", "-")}`}>
              {formatStatus(projectStatus)}
            </span>
          </div>
          <ProjectWorkNav organizationId={organizationId} projectId={projectId} current={view} />

          {canManage && workAllowed && (
            <section className="task-workflow-section" aria-labelledby="workflow-heading">
              <div className="task-workflow-heading">
                <div>
                  <p className="eyebrow">Project workflow</p>
                  <h3 id="workflow-heading">{statuses.length} columns</h3>
                </div>
                <button className="quiet-button" type="button" onClick={beginWorkflowEdit} disabled={Boolean(pending)}>
                  {workflowOpen ? "Close settings" : "Configure columns"}
                </button>
              </div>
              {workflowOpen && (
                <form className="task-workflow-form" onSubmit={updateWorkflow}>
                  <p className="workspace-note">Column names and order are project-specific. A column with task history cannot be removed or changed from/to the completion column.</p>
                  <div className="task-workflow-list">
                    {workflowDraft.map((status, index) => {
                      const savedStatus = statuses.find((item) => item.id === status.id);
                      const hasHistory = (savedStatus?.total_task_count ?? 0) > 0;
                      return (
                        <div className="task-workflow-row" key={status.id ?? `new-${index}`}>
                          <label className="form-field">
                            <span>Column {index + 1}</span>
                            <input
                              value={status.name}
                              maxLength={60}
                              onChange={(event) => updateWorkflowDraft(index, { name: event.target.value })}
                              disabled={Boolean(pending)}
                              required
                            />
                            {savedStatus && <small>{savedStatus.task_count} active tasks</small>}
                          </label>
                          <label className="task-done-choice">
                            <input
                              type="radio"
                              name="doneStatus"
                              checked={status.isDone}
                              onChange={() => updateWorkflowDraft(index, { isDone: true })}
                              disabled={Boolean(pending) || (hasHistory && !status.isDone)}
                            />
                            <span>Completion column</span>
                          </label>
                          <div className="task-workflow-actions">
                            <button className="quiet-button" type="button" aria-label={`Move ${status.name} up`} onClick={() => moveWorkflowStatus(index, -1)} disabled={Boolean(pending) || index === 0}>Up</button>
                            <button className="quiet-button" type="button" aria-label={`Move ${status.name} down`} onClick={() => moveWorkflowStatus(index, 1)} disabled={Boolean(pending) || index === workflowDraft.length - 1}>Down</button>
                            <button
                              className="quiet-button"
                              type="button"
                              onClick={() => setWorkflowDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                              disabled={Boolean(pending) || workflowDraft.length <= 2 || hasHistory}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="project-form-actions">
                    <button className="primary-button" type="submit" disabled={Boolean(pending)}>
                      {pending === "workflow" ? "Saving..." : "Save columns"}
                    </button>
                    <button className="quiet-button" type="button" onClick={() => setWorkflowDraft((current) => [...current, { name: "New column", isDone: false }])} disabled={Boolean(pending) || workflowDraft.length >= 12}>
                      Add a column
                    </button>
                    <span className="project-version-note">Workflow version {workflowVersion}</span>
                  </div>
                </form>
              )}
            </section>
          )}

          {workAllowed && (
            <section className="task-create-section" aria-labelledby="task-create-heading">
              <div className="task-workflow-heading">
                <div>
                  <p className="eyebrow">Move the work forward</p>
                  <h3 id="task-create-heading">Create a task</h3>
                </div>
                <button className="primary-button project-add-button" type="button" onClick={() => setCreating((open) => !open)} disabled={Boolean(pending)}>
                  {creating ? "Close form" : "New task"}
                </button>
              </div>
              {creating && (
                <TaskEditorForm
                  tasks={tasks}
                  statuses={statuses}
                  members={members}
                  milestones={milestones}
                  disabled={Boolean(pending)}
                  submitLabel={pending === "create" ? "Creating..." : "Create task"}
                  onSubmit={(event) => void saveTask(event, null)}
                  onChange={() => setCreateKey("")}
                />
              )}
            </section>
          )}

          <section className="task-list-section" aria-labelledby="task-list-heading">
            <div className="project-section-heading">
              <div>
                <p className="eyebrow">The active work</p>
                <h3 id="task-list-heading">{view === "board" ? "Workflow board" : "Task list"}<span>{statuses.reduce((total, status) => total + status.task_count, 0)}</span></h3>
              </div>
            </div>

            <form className="task-filter-form" onSubmit={applyFilters}>
              <label className="form-field task-filter-search">
                <span>Search tasks</span>
                <input
                  value={filterDraft.q}
                  maxLength={120}
                  placeholder="Title or description"
                  onChange={(event) => setFilterDraft({ ...filterDraft, q: event.target.value })}
                />
              </label>
              {view === "list" && (
                <label className="form-field">
                  <span>Workflow column</span>
                  <select value={filterDraft.statusId} onChange={(event) => setFilterDraft({ ...filterDraft, statusId: event.target.value })}>
                    <option value="">All columns</option>
                    {statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
                  </select>
                </label>
              )}
              <label className="form-field">
                <span>Priority</span>
                <select value={filterDraft.priority} onChange={(event) => setFilterDraft({ ...filterDraft, priority: event.target.value })}>
                  <option value="">All priorities</option>
                  {PRIORITIES.map((priority) => <option key={priority} value={priority}>{formatStatus(priority)}</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>Assignee</span>
                <select value={filterDraft.assigneeId} onChange={(event) => setFilterDraft({ ...filterDraft, assigneeId: event.target.value })}>
                  <option value="">Anyone</option>
                  <option value="unassigned">Unassigned</option>
                  {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>Milestone</span>
                <select value={filterDraft.milestoneId} onChange={(event) => setFilterDraft({ ...filterDraft, milestoneId: event.target.value })}>
                  <option value="">All milestones</option>
                  {milestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.name}</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>Label</span>
                <input value={filterDraft.label} maxLength={24} placeholder="Exact label" onChange={(event) => setFilterDraft({ ...filterDraft, label: event.target.value })} />
              </label>
              {view === "list" && (
                <label className="form-field">
                  <span>Sort by</span>
                  <select value={sort} onChange={(event) => setSort(event.target.value)}>
                    <option value="updatedAt">Recently updated</option>
                    <option value="createdAt">Recently created</option>
                    <option value="dueDate">Due date</option>
                    <option value="title">Title</option>
                    <option value="priority">Priority</option>
                    <option value="position">Workflow order</option>
                  </select>
                </label>
              )}
              <div className="task-filter-actions">
                <button className="primary-button" type="submit" disabled={Boolean(pending)}>Apply filters</button>
                <button className="quiet-button" type="button" onClick={clearFilters} disabled={Boolean(pending)}>Clear</button>
              </div>
            </form>

            {workAllowed && selectedCount > 0 && (
              <form className="task-bulk-toolbar" onSubmit={updatePriorityForSelection}>
                <span>{selectedCount} selected</span>
                <label className="sr-only" htmlFor="bulk-priority">Set priority for selected tasks</label>
                <select id="bulk-priority" name="priority" defaultValue="high" disabled={Boolean(pending)}>
                  {PRIORITIES.map((priority) => <option key={priority} value={priority}>{formatStatus(priority)}</option>)}
                </select>
                <button className="primary-button" type="submit" disabled={Boolean(pending)}>
                  {pending === "bulk" ? "Updating..." : "Update priority"}
                </button>
                <button className="quiet-button" type="button" onClick={() => setSelectedIds([])} disabled={Boolean(pending)}>Cancel</button>
              </form>
            )}

            {loading && !tasks.length ? (
              <p className="workspace-loading" role="status">Loading tasks...</p>
            ) : view === "board" && statuses.length ? (
              <div className="task-board" aria-label="Task workflow board">
                {statuses.map((status) => {
                  const columnTasks = tasks
                    .filter((task) => task.workflow_status_id === status.id)
                    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
                  return (
                    <section
                      className="task-column"
                      key={status.id}
                      aria-label={`${status.name}, ${status.task_count} tasks`}
                      onDragOver={(event) => { if (canReorder) event.preventDefault(); }}
                      onDrop={(event) => {
                        if (!canReorder) return;
                        event.preventDefault();
                        dropTask(event.dataTransfer.getData("text/plain"), status.id);
                      }}
                    >
                      <div className="task-column-heading">
                        <span className="task-column-mark" data-done={status.is_done || undefined} aria-hidden="true" />
                        <h4>{status.name}</h4>
                        <span>{status.task_count}</span>
                      </div>
                      {columnTasks.map((task) => (
                        <TaskCard
                          key={`${task.id}:${task.version}`}
                          task={task}
                          statuses={statuses}
                          tasks={tasks}
                          members={members}
                          milestones={milestones}
                          base={base}
                          canWork={workAllowed}
                          selected={selectedIds.includes(task.id)}
                          selectionDisabled={selectedCount >= 50 && !selectedIds.includes(task.id)}
                          pending={Boolean(pending)}
                          draggable={canReorder && task.milestone_status !== "completed"}
                          onSelect={(checked) => setSelectedIds((current) => checked
                            ? [...current, task.id]
                            : current.filter((id) => id !== task.id))}
                          onSubmit={(event, item) => void saveTask(event, item)}
                          onStatusChange={(statusId) => void updateTask(task, { statusId })}
                          onArchive={() => void archiveTask(task)}
                          onDropped={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            dropTask(event.dataTransfer.getData("text/plain"), status.id, task.id);
                          }}
                          onDragOver={(event) => { if (canReorder) event.preventDefault(); }}
                        />
                      ))}
                      {!columnTasks.length && <p className="task-column-empty">Drop a task here or change its column from the task card.</p>}
                    </section>
                  );
                })}
              </div>
            ) : tasks.length ? (
              <div className="task-list" aria-label="Project task list">
                {tasks.map((task) => (
                  <TaskCard
                    key={`${task.id}:${task.version}`}
                    task={task}
                    statuses={statuses}
                    tasks={tasks}
                    members={members}
                    milestones={milestones}
                    base={base}
                    canWork={workAllowed}
                    selected={selectedIds.includes(task.id)}
                    selectionDisabled={selectedCount >= 50 && !selectedIds.includes(task.id)}
                    pending={Boolean(pending)}
                    draggable={false}
                    variant="list"
                    onSelect={(checked) => setSelectedIds((current) => checked
                      ? [...current, task.id]
                      : current.filter((id) => id !== task.id))}
                    onSubmit={(event, item) => void saveTask(event, item)}
                    onStatusChange={(statusId) => void updateTask(task, { statusId })}
                    onArchive={() => void archiveTask(task)}
                    onDropped={() => undefined}
                    onDragOver={() => undefined}
                  />
                ))}
              </div>
            ) : (
              <div className="project-empty task-empty">
                <span className="empty-mark" aria-hidden="true">+</span>
                <h4>{Object.values(filters).some(Boolean) ? "No tasks match these filters." : "Start with one clear next step."}</h4>
                <p>{Object.values(filters).some(Boolean)
                  ? "Adjust the filters or search another phrase."
                  : workAllowed ? "Create a task, assign an owner, then move it across the workflow as work progresses." : "A project member can add tasks and keep the workflow moving."}</p>
              </div>
            )}

            {hasMore && (
              <button className="quiet-button project-load-more" type="button" onClick={() => void loadMore()} disabled={loadingMore || Boolean(pending)}>
                {loadingMore ? "Loading..." : "Load more tasks"}
              </button>
            )}
            {!loading && tasks.length > 0 && <p className="task-page-note">Showing {tasks.length}{hasMore ? " or more" : ""} tasks. Workflow counts include every active task in the project.</p>}
          </section>

          {error && <p className="form-message form-error" role="alert">{error}</p>}
          {message && <p className="form-message form-success" role="status" aria-live="polite">{message}</p>}
        </div>
        <footer className="auth-footer">Nexora - A clearer way to move work forward</footer>
      </section>
    </main>
  );

}

function TaskCard({
  task,
  statuses,
  tasks,
  members,
  milestones,
  base,
  canWork,
  selected,
  selectionDisabled,
  pending,
  draggable,
  variant = "board",
  onSelect,
  onSubmit,
  onStatusChange,
  onArchive,
  onDropped,
  onDragOver,
}: {
  task: Task;
  statuses: TaskStatus[];
  tasks: Task[];
  members: Member[];
  milestones: Milestone[];
  base: string;
  canWork: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  pending: boolean;
  draggable: boolean;
  variant?: "board" | "list";
  onSelect: (checked: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>, task: Task) => void;
  onStatusChange: (statusId: string) => void;
  onArchive: () => void;
  onDropped: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
}) {
  const [activity, setActivity] = useState<TaskActivity[] | null>(null);
  const [activityError, setActivityError] = useState("");
  const [activityLoading, setActivityLoading] = useState(false);
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [commentsError, setCommentsError] = useState("");
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [mentionMemberId, setMentionMemberId] = useState("");
  const [commentKey, setCommentKey] = useState("");
  const [commentPending, setCommentPending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const editable = canWork && task.milestone_status !== "completed";

  async function loadActivity() {
    if (activity !== null || activityLoading) return;
    setActivityLoading(true);
    setActivityError("");
    try {
      const response = await fetch(`${base}/${encodeURIComponent(task.id)}`, { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as ApiResult<{ activity: TaskActivity[] }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "Recent activity could not be loaded.");
      setActivity(result.data.activity);
    } catch (reason) {
      setActivityError(reason instanceof Error ? reason.message : "Recent activity could not be loaded.");
    } finally {
      setActivityLoading(false);
    }
  }

  async function loadComments() {
    if (comments !== null || commentsLoading) return;
    setCommentsLoading(true);
    setCommentsError("");
    try {
      const response = await fetch(`${base}/${encodeURIComponent(task.id)}/comments`, { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as ApiResult<{ comments: TaskComment[]; hasMore: boolean }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "Comments could not be loaded.");
      setComments(result.data.comments);
    } catch (reason) {
      setCommentsError(reason instanceof Error ? reason.message : "Comments could not be loaded.");
    } finally {
      setCommentsLoading(false);
    }
  }

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || !commentDraft.trim() || commentPending || comments === null) return;
    const body = commentDraft;
    const key = commentKey || `comment-${crypto.randomUUID()}`;
    setCommentKey(key);
    setCommentPending(true);
    setCommentsError("");
    try {
      const response = await fetch(`${base}/${encodeURIComponent(task.id)}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ body }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{ comment: TaskComment }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "Comment could not be posted.");
      setComments((current) => current?.some((comment) => comment.id === result.data?.comment.id)
        ? current
        : [...(current ?? []), result.data!.comment]);
      setCommentDraft("");
      setCommentKey("");
    } catch (reason) {
      setCommentsError(reason instanceof Error ? reason.message : "Comment could not be posted.");
    } finally {
      setCommentPending(false);
    }
  }

  function insertMention() {
    const member = members.find((candidate) => candidate.user_id === mentionMemberId && candidate.status === "active");
    if (!member) return;
    setCommentDraft((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}@[${member.user_id}] `);
    setCommentKey("");
    setMentionMemberId("");
  }

  return (
    <article
      className={`task-card task-card-${variant} ${selected ? "is-selected" : ""}`}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
      }}
      onDragOver={onDragOver}
      onDrop={onDropped}
    >
      <div className="task-card-topline">
        <label className="task-select-control">
          <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} disabled={!editable || selectionDisabled || pending} />
          <span className="sr-only">Select {task.title}</span>
        </label>
        <span className={`task-priority task-priority-${task.priority}`}>{formatStatus(task.priority)}</span>
      </div>
      <div className="task-card-title-row">
        <h4>{task.title}</h4>
        {task.status_is_done && <span className="task-complete-mark" aria-label="Complete">Done</span>}
      </div>
      {task.description && <p className="task-card-description">{task.description}</p>}
      <div className="task-card-meta">
        <span>{task.assignee_name || "Unassigned"}</span>
        {task.milestone_name && <span>{task.milestone_name}</span>}
        {task.due_date && <span>Due {formatDate(task.due_date)}</span>}
      </div>
      {task.labels.length > 0 && (
        <div className="task-label-list" aria-label="Labels">
          {task.labels.map((label) => <span className="task-label" key={label}>{label}</span>)}
        </div>
      )}
      {(task.subtask_count > 0 || task.dependencies.length > 0) && (
        <div className="task-card-signals">
          {task.subtask_count > 0 && <span>{task.completed_subtask_count}/{task.subtask_count} subtasks</span>}
          {task.unresolved_dependency_count > 0 && <span>{task.unresolved_dependency_count} prerequisite{task.unresolved_dependency_count === 1 ? "" : "s"} open</span>}
        </div>
      )}
      <div className="task-card-controls">
        {editable ? (
          <label className="task-status-control">
            <span className="sr-only">Workflow column for {task.title}</span>
            <select value={task.workflow_status_id} onChange={(event) => onStatusChange(event.target.value)} disabled={pending}>
              {statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
            </select>
          </label>
        ) : (
          <span className="task-status-readonly">{task.status_name}</span>
        )}
        <details className="task-card-details" onToggle={(event) => {
          setDetailsOpen(event.currentTarget.open);
          if (event.currentTarget.open) {
            void loadActivity();
            void loadComments();
          }
        }}>
          <summary>Details</summary>
          {editable ? (
            <TaskEditorForm
              task={task}
              tasks={tasks}
              statuses={statuses}
              members={members}
              milestones={milestones}
              disabled={pending}
              submitLabel={pending ? "Saving..." : "Save task"}
              onSubmit={(event) => onSubmit(event, task)}
            />
          ) : (
            <div className="task-readonly-details">
              <p>{task.description || "No task description."}</p>
              <p>Created by {task.creator_name || "a project member"}.</p>
              {task.parent_title && <p>Subtask of {task.parent_title}</p>}
              {task.dependencies.length > 0 && <p>Prerequisites: {task.dependencies.map((dependency) => dependency.title).join(", ")}</p>}
            </div>
          )}
          {editable && <button className="quiet-button task-archive-button" type="button" onClick={onArchive} disabled={pending}>Archive task</button>}
          <section className="task-activity task-comments" aria-label={`Comments for ${task.title}`}>
            <h5>Comments</h5>
            {commentsLoading && <p className="workspace-note" role="status">Loading comments...</p>}
            {commentsError && (
              <p className="form-message form-error" role="alert">
                {commentsError} {comments === null && <button type="button" className="quiet-button" onClick={() => void loadComments()}>Retry</button>}
              </p>
            )}
            {comments?.length ? (
              <ol className="task-comment-list">
                {comments.map((comment) => (
                  <li className="task-comment" key={comment.id}>
                    <p>{renderCommentBody(comment)}</p>
                    <small>{comment.author_name || "Project member"} - {formatDateTime(comment.created_at)}</small>
                  </li>
                ))}
              </ol>
            ) : comments && <p className="workspace-note">No comments yet.</p>}
            {comments?.length === 100 && <p className="workspace-note">Showing the latest 100 comments.</p>}
            {editable && (
              <form className="task-comment-form" onSubmit={submitComment}>
                <div className="task-mention-picker">
                  <label className="form-field">
                    <span>Mention a project member</span>
                    <select value={mentionMemberId} onChange={(event) => setMentionMemberId(event.target.value)} disabled={comments === null || commentPending || pending}>
                      <option value="">Choose a member</option>
                      {members.filter((member) => member.status === "active").map((member) => (
                        <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
                      ))}
                    </select>
                  </label>
                  <button className="quiet-button" type="button" onClick={insertMention} disabled={!mentionMemberId || comments === null || commentPending || pending}>
                    Insert mention
                  </button>
                </div>
                <label className="form-field">
                  <span>Add a comment</span>
                  <textarea
                    value={commentDraft}
                    onChange={(event) => {
                      setCommentDraft(event.target.value);
                      setCommentKey("");
                    }}
                    maxLength={4000}
                    rows={3}
                    required
                    disabled={comments === null || commentPending || pending}
                  />
                </label>
                <button className="primary-button" type="submit" disabled={comments === null || commentPending || pending || !commentDraft.trim()}>
                  {commentPending ? "Posting..." : "Post comment"}
                </button>
              </form>
            )}
          </section>
          <TaskFilesPanel
            collectionUrl={`${base}/${encodeURIComponent(task.id)}/files`}
            canEdit={editable}
            open={detailsOpen}
          />
          <section className="task-activity" aria-label={`Recent activity for ${task.title}`}>
            <h5>Recent activity</h5>
            {activityLoading ? <p className="workspace-note" role="status">Loading activity...</p>
              : activityError ? <p className="form-message form-error" role="alert">{activityError}</p>
                : activity?.length ? (
                  <ol>
                    {activity.map((item) => (
                      <li key={item.id}>
                        <span>{formatActivity(item)}</span>
                        <small>{item.actor_name || "Project member"} - {formatDateTime(item.created_at)}</small>
                      </li>
                    ))}
                  </ol>
                ) : activity ? <p className="workspace-note">No activity has been recorded yet.</p> : null}
          </section>
        </details>
      </div>
    </article>
  );
}

function TaskFilesPanel({ collectionUrl, canEdit, open }: {
  collectionUrl: string;
  canEdit: boolean;
  open: boolean;
}) {
  const [files, setFiles] = useState<TaskFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState("");

  useEffect(() => {
    if (!open || files !== null || loading || error) return;
    let cancelled = false;
    async function loadFiles() {
      setLoading(true);
      try {
        const response = await fetch(collectionUrl, { cache: "no-store" });
        const result = (await response.json().catch(() => null)) as ApiResult<{ files: TaskFile[] }> | null;
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "Attachments could not be loaded.");
        if (!cancelled) setFiles(result.data.files);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Attachments could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadFiles();
    return () => { cancelled = true; };
  }, [collectionUrl, error, files, open]);

  async function transferFile(file: File, existing?: TaskFile) {
    if (file.size > 10 * 1024 * 1024) {
      setError("Files must be 10 MB or smaller.");
      return;
    }
    const mimeType = taskFileMimeType(file.name);
    if (!mimeType) {
      setError("Choose a PDF, text, CSV, JSON, PNG, JPEG, GIF, or WebP file.");
      return;
    }
    const idempotencyKey = crypto.randomUUID();
    const target = existing ? `${collectionUrl}/${encodeURIComponent(existing.id)}` : collectionUrl;
    setPending(existing ? `replace:${existing.id}` : "upload");
    setError("");
    setMessage("");
    try {
      const response = await fetch(target, {
        method: existing ? "PUT" : "POST",
        headers: {
          "content-type": mimeType,
          "x-file-name": encodeURIComponent(file.name),
          ...(existing ? { "if-match": String(existing.version) } : { "idempotency-key": idempotencyKey }),
        },
        body: file,
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{ file: TaskFile }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "The attachment could not be saved.");
      setFiles((current) => {
        if (!current) return [result.data!.file];
        return existing
          ? current.map((item) => item.id === existing.id ? result.data!.file : item)
          : [result.data!.file, ...current];
      });
      setMessage(existing ? "Attachment replaced." : "Attachment uploaded.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The attachment could not be saved.");
    } finally {
      setPending("");
    }
  }

  async function deleteFile(file: TaskFile) {
    if (!window.confirm(`Remove ${file.original_filename}? It will be permanently removed after 30 days.`)) return;
    setPending(`delete:${file.id}`);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${collectionUrl}/${encodeURIComponent(file.id)}`, { method: "DELETE" });
      const result = (await response.json().catch(() => null)) as ApiResult<{ deleted: boolean }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.deleted) throw new Error(result?.error?.message ?? "The attachment could not be removed.");
      setFiles((current) => current?.filter((item) => item.id !== file.id) ?? []);
      setMessage("Attachment removed. Permanent cleanup runs after 30 days when the administrator has configured the retention job.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The attachment could not be removed.");
    } finally {
      setPending("");
    }
  }

  async function downloadFile(file: TaskFile) {
    setPending(`download:${file.id}`);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${collectionUrl}/${encodeURIComponent(file.id)}`, { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as ApiResult<{ url: string }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.url || !result.data.url.startsWith("/api/organizations/")) {
        throw new Error(result?.error?.message ?? "A secure download link could not be created.");
      }
      window.location.assign(new URL(result.data.url, window.location.origin));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "A secure download link could not be created.");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="task-activity task-files" aria-label="Task attachments">
      <h5>Attachments</h5>
      <p className="task-file-note">Private files up to 10 MB each; 20 files and 100 MB per task. PDFs, text, CSV, JSON, PNG, JPEG, GIF, and WebP.</p>
      {loading && <p className="workspace-note" role="status">Loading attachments...</p>}
      {error && (
        <p className="form-message form-error" role="alert">
          {error} {files === null && <button type="button" className="quiet-button" onClick={() => setError("")}>Retry</button>}
        </p>
      )}
      {files?.length ? (
        <ul className="task-file-list">
          {files.map((file) => (
            <li className="task-file" key={file.id}>
              <div className="task-file-info">
                <strong>{file.original_filename}</strong>
                <small>{formatFileSize(file.byte_size)} · {file.uploaded_by_name || "Project member"} · {formatDateTime(file.created_at)}</small>
              </div>
              <div className="task-file-actions">
                <button type="button" className="quiet-button" onClick={() => void downloadFile(file)} disabled={Boolean(pending)}>
                  {pending === `download:${file.id}` ? "Preparing..." : "Download"}
                </button>
                {canEdit && (
                  <>
                    <label className="quiet-button task-file-replace" aria-label={`Replace ${file.original_filename}`}>
                      Replace
                      <input type="file" accept=".pdf,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.gif,.webp" disabled={Boolean(pending)} onChange={(event) => {
                        const nextFile = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (nextFile) void transferFile(nextFile, file);
                      }} />
                    </label>
                    <button type="button" className="quiet-button task-file-delete" aria-label={`Remove ${file.original_filename}`} onClick={() => void deleteFile(file)} disabled={Boolean(pending)}>
                      {pending === `delete:${file.id}` ? "Removing..." : "Remove"}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : files && <p className="workspace-note">No attachments yet.</p>}
      {canEdit && (
        <label className="primary-button task-file-upload">
          {pending === "upload" ? "Uploading..." : "Attach a file"}
          <input type="file" accept=".pdf,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.gif,.webp" disabled={Boolean(pending)} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void transferFile(file);
          }} />
        </label>
      )}
      {message && <p className="form-message form-success" role="status" aria-live="polite">{message}</p>}
    </section>
  );
}

function taskFileMimeType(filename: string): string | null {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    csv: "text/csv",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    pdf: "application/pdf",
    png: "image/png",
    txt: "text/plain",
    webp: "image/webp",
  };
  return extension ? types[extension] ?? null : null;
}

function formatFileSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function TaskEditorForm({
  task = null,
  tasks,
  statuses,
  members,
  milestones,
  disabled,
  submitLabel,
  onSubmit,
  onChange,
}: {
  task?: Task | null;
  tasks: Task[];
  statuses: TaskStatus[];
  members: Member[];
  milestones: Milestone[];
  disabled: boolean;
  submitLabel: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChange?: () => void;
}) {
  const parentTasks = tasks.filter((item) => item.id !== task?.id
    && item.parent_task_id === null
    && item.archived_at === null
    && !item.status_is_done);
  const dependencyTasks = tasks.filter((item) => item.id !== task?.id && item.archived_at === null);
  const existingDependencies = task?.dependencies ?? [];
  const knownDependencyIds = new Set(dependencyTasks.map((item) => item.id));

  return (
    <form className="task-editor-form" onSubmit={onSubmit} onChange={onChange}>
      <label className="form-field task-field-wide">
        <span>Task title</span>
        <input name="title" defaultValue={task?.title ?? ""} maxLength={200} required disabled={disabled} />
      </label>
      <label className="form-field task-field-wide">
        <span>Description <small>Optional</small></span>
        <textarea name="description" defaultValue={task?.description ?? ""} maxLength={20_000} rows={2} disabled={disabled} />
      </label>
      <label className="form-field">
        <span>Workflow column</span>
        <select name="statusId" defaultValue={task?.workflow_status_id ?? statuses[0]?.id ?? ""} disabled={disabled} required>
          {statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>Priority</span>
        <select name="priority" defaultValue={task?.priority ?? "medium"} disabled={disabled}>
          {PRIORITIES.map((priority) => <option key={priority} value={priority}>{formatStatus(priority)}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>Assignee</span>
        <select name="assigneeId" defaultValue={task?.assignee_user_id ?? ""} disabled={disabled}>
          <option value="">Unassigned</option>
          {members.filter((member) => member.status === "active").map((member) => (
            <option key={member.user_id} value={member.user_id}>{member.display_name}</option>
          ))}
        </select>
      </label>
      {(task?.subtask_count ?? 0) > 0 && (
        <input type="hidden" name="milestoneId" value={task?.milestone_id ?? ""} />
      )}
      <label className="form-field">
        <span>Milestone</span>
        <select name="milestoneId" defaultValue={task?.milestone_id ?? ""} disabled={disabled || (task?.subtask_count ?? 0) > 0}>
          <option value="">No milestone</option>
          {milestones.filter((milestone) => milestone.status !== "completed" || milestone.id === task?.milestone_id).map((milestone) => (
            <option key={milestone.id} value={milestone.id}>{milestone.name}</option>
          ))}
        </select>
      </label>
      {(task?.subtask_count ?? 0) > 0 && (
        <input type="hidden" name="parentTaskId" value={task?.parent_task_id ?? ""} />
      )}
      <label className="form-field">
        <span>Parent task <small>Optional</small></span>
        <select name="parentTaskId" defaultValue={task?.parent_task_id ?? ""} disabled={disabled || (task?.subtask_count ?? 0) > 0}>
          <option value="">No parent task</option>
          {task?.parent_task_id && !parentTasks.some((item) => item.id === task.parent_task_id) && (
            <option value={task.parent_task_id}>{task.parent_title || "Current parent task"}</option>
          )}
          {parentTasks.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>Due date <small>Optional</small></span>
        <input name="dueDate" type="date" defaultValue={dateInputValue(task?.due_date)} disabled={disabled} />
      </label>
      <label className="form-field">
        <span>Effort estimate <small>Hours</small></span>
        <input name="estimatedEffortHours" type="number" min="0" max="99999.99" step="0.25" defaultValue={task?.estimated_effort_hours ?? ""} disabled={disabled} />
      </label>
      <label className="form-field task-field-wide">
        <span>Labels <small>Separate with commas, up to 12</small></span>
        <input name="labels" defaultValue={task?.labels.join(", ") ?? ""} maxLength={350} placeholder="Design, Launch" disabled={disabled} />
      </label>
      <label className="form-field task-field-wide">
        <span>Prerequisite tasks <small>Optional - complete these first</small></span>
        <select name="dependencies" multiple size={Math.min(5, Math.max(3, dependencyTasks.length + existingDependencies.length))} defaultValue={existingDependencies.map((item) => item.id)} disabled={disabled}>
          {existingDependencies.filter((item) => !knownDependencyIds.has(item.id)).map((item) => (
            <option key={item.id} value={item.id}>{item.title} - {item.status_name}</option>
          ))}
          {dependencyTasks.map((item) => <option key={item.id} value={item.id}>{item.title} - {item.status_name}</option>)}
        </select>
        {!dependencyTasks.length && <small className="form-hint">Create another active task first to add a prerequisite.</small>}
      </label>
      <div className="project-form-actions task-field-wide">
        <button className="primary-button" type="submit" disabled={disabled || !statuses.length}>{submitLabel}</button>
        {task && <span className="project-version-note">Saving checks task version {task.version}.</span>}
      </div>
    </form>
  );
}

function readTaskDraft(formData: FormData) {
  const statusId = String(formData.get("statusId") ?? "");
  const effortValue = String(formData.get("estimatedEffortHours") ?? "").trim();
  return {
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? "") || null,
    ...(statusId ? { statusId } : {}),
    priority: String(formData.get("priority") ?? "medium"),
    assigneeId: String(formData.get("assigneeId") ?? "") || null,
    milestoneId: String(formData.get("milestoneId") ?? "") || null,
    parentTaskId: String(formData.get("parentTaskId") ?? "") || null,
    labels: String(formData.get("labels") ?? "").split(",").map((label) => label.trim()).filter(Boolean),
    dueDate: String(formData.get("dueDate") ?? "") || null,
    estimatedEffortHours: effortValue ? Number(effortValue) : null,
    dependencies: formData.getAll("dependencies").map(String),
  };
}

function formatStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function dateInputValue(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(`${dateInputValue(value)}T00:00:00`));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatActivity(activity: TaskActivity): string {
  if (activity.action === "task.created") return "Created this task";
  if (activity.action === "task.comment_created") return "Added a comment";
  if (activity.action === "task.file_uploaded") return "Attached a file";
  if (activity.action === "task.file_replaced") return "Replaced an attachment";
  if (activity.action === "task.file_deleted") return "Removed an attachment";
  if (activity.action === "task.status_changed") return "Changed the workflow column";
  if (activity.action === "task.assigned") return "Changed the task assignment";
  if (activity.action === "task.archived") return "Archived this task";
  const fields = Array.isArray(activity.details.changedFields)
    ? activity.details.changedFields.filter((field): field is string => typeof field === "string")
    : [];
  return fields.length ? `Updated ${fields.join(", ")}` : "Updated this task";
}

function renderCommentBody(comment: TaskComment) {
  const tokenPattern = /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of comment.body.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const userId = match[1]?.toLowerCase();
    if (index > cursor) nodes.push(comment.body.slice(cursor, index));
    const mention = comment.mentions.find((item) => item.user_id.toLowerCase() === userId);
    nodes.push(<strong className="task-comment-mention" key={`${comment.id}-${index}`}>@{mention?.display_name ?? "Former project member"}</strong>);
    cursor = index + match[0].length;
  }
  if (cursor < comment.body.length) nodes.push(comment.body.slice(cursor));
  return nodes;
}
