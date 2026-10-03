import "server-only";
import type { DatabaseTransaction } from "./db.ts";

export interface ProjectTaskRow {
  id: string;
  organization_id: string;
  project_id: string;
  title: string;
  description: string | null;
  workflow_status_id: string;
  status_name: string;
  status_sort_order: number;
  status_is_done: boolean;
  priority: string;
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
  completed_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  subtask_count: number;
  completed_subtask_count: number;
  dependencies: Array<{
    id: string;
    title: string;
    status_name: string;
    is_done: boolean;
  }>;
  unresolved_dependency_count: number;
}

export interface ProjectTaskStatusRow {
  id: string;
  name: string;
  sort_order: number;
  is_done: boolean;
  task_count: number;
  total_task_count: number;
}

export interface ProjectMemberRow {
  user_id: string;
  display_name: string;
  role: string;
  status: string;
}

export async function lockProjectTaskGraph(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
): Promise<void> {
  await transaction.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
    [`project-task-graph:${organizationId.toLowerCase()}:${projectId.toLowerCase()}`],
  );
}

export async function lockProjectForWork(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
): Promise<void> {
  await transaction.query(
    "SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1, 0))",
    [`project-lifecycle:${organizationId.toLowerCase()}:${projectId.toLowerCase()}`],
  );
}

export async function lockProjectLifecycle(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
): Promise<void> {
  await transaction.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
    [`project-lifecycle:${organizationId.toLowerCase()}:${projectId.toLowerCase()}`],
  );
}

export async function readProjectTask(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  taskId: string,
): Promise<ProjectTaskRow | null> {
  const result = await transaction.query<ProjectTaskRow>(
    `SELECT task.id,
            task.organization_id,
            task.project_id,
            task.title,
            task.description,
            task.workflow_status_id,
            workflow.name AS status_name,
            workflow.sort_order AS status_sort_order,
            workflow.is_done AS status_is_done,
            task.priority::text AS priority,
            task.assignee_user_id,
            assignee.display_name AS assignee_name,
            creator.display_name AS creator_name,
            task.milestone_id,
            milestone.name AS milestone_name,
            milestone.status::text AS milestone_status,
            task.parent_task_id,
            parent.title AS parent_title,
            task.labels,
            task.due_date::text AS due_date,
            task.estimated_effort_hours::text AS estimated_effort_hours,
            task.position,
            task.version,
            task.completed_at,
            task.archived_at,
            task.created_at,
            task.updated_at,
            COALESCE(subtasks.subtask_count, 0)::integer AS subtask_count,
            COALESCE(subtasks.completed_subtask_count, 0)::integer AS completed_subtask_count,
            COALESCE(task_dependencies.dependencies, '[]'::jsonb) AS dependencies,
            COALESCE(task_dependencies.unresolved_dependency_count, 0)::integer AS unresolved_dependency_count
     FROM nexora.tasks AS task
     JOIN nexora.project_task_statuses AS workflow
       ON workflow.organization_id = task.organization_id
      AND workflow.project_id = task.project_id
      AND workflow.id = task.workflow_status_id
     LEFT JOIN nexora.milestones AS milestone
       ON milestone.organization_id = task.organization_id
      AND milestone.project_id = task.project_id
      AND milestone.id = task.milestone_id
     LEFT JOIN nexora.tasks AS parent
       ON parent.organization_id = task.organization_id
      AND parent.project_id = task.project_id
      AND parent.id = task.parent_task_id
     LEFT JOIN LATERAL (
       SELECT member.display_name
       FROM nexora.list_current_project_members(task.organization_id, task.project_id) AS member
       WHERE member.user_id = task.assignee_user_id
       LIMIT 1
     ) AS assignee ON true
     LEFT JOIN LATERAL (
       SELECT member.display_name
       FROM nexora.list_current_project_members(task.organization_id, task.project_id) AS member
       WHERE member.user_id = task.created_by_user_id
       LIMIT 1
     ) AS creator ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS subtask_count,
              count(*) FILTER (WHERE child_status.is_done)::integer AS completed_subtask_count
       FROM nexora.tasks AS child
       JOIN nexora.project_task_statuses AS child_status
         ON child_status.organization_id = child.organization_id
        AND child_status.project_id = child.project_id
        AND child_status.id = child.workflow_status_id
       WHERE child.organization_id = task.organization_id
         AND child.project_id = task.project_id
         AND child.parent_task_id = task.id
         AND child.archived_at IS NULL
     ) AS subtasks ON true
     LEFT JOIN LATERAL (
       SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id', dependency.id,
                  'title', dependency.title,
                  'status_name', dependency_status.name,
                  'is_done', dependency_status.is_done
                ) ORDER BY dependency.title, dependency.id
              ) AS dependencies,
              count(*) FILTER (WHERE NOT dependency_status.is_done)::integer AS unresolved_dependency_count
       FROM nexora.task_dependencies AS edge
       JOIN nexora.tasks AS dependency
         ON dependency.organization_id = edge.organization_id
        AND dependency.project_id = edge.project_id
        AND dependency.id = edge.depends_on_task_id
       JOIN nexora.project_task_statuses AS dependency_status
         ON dependency_status.organization_id = dependency.organization_id
        AND dependency_status.project_id = dependency.project_id
        AND dependency_status.id = dependency.workflow_status_id
       WHERE edge.organization_id = task.organization_id
         AND edge.project_id = task.project_id
         AND edge.task_id = task.id
     ) AS task_dependencies ON true
     WHERE task.organization_id = $1 AND task.project_id = $2 AND task.id = $3`,
    [organizationId, projectId, taskId],
  );
  return result.rows[0] ?? null;
}

export async function readProjectTaskStatuses(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
): Promise<ProjectTaskStatusRow[]> {
  const result = await transaction.query<ProjectTaskStatusRow>(
    `SELECT workflow.id,
            workflow.name,
            workflow.sort_order,
            workflow.is_done,
            (SELECT count(*) FILTER (WHERE task.archived_at IS NULL)::integer
             FROM nexora.tasks AS task
             WHERE task.organization_id = workflow.organization_id
               AND task.project_id = workflow.project_id
               AND task.workflow_status_id = workflow.id) AS task_count,
            (SELECT count(*)::integer
             FROM nexora.tasks AS task
             WHERE task.organization_id = workflow.organization_id
               AND task.project_id = workflow.project_id
               AND task.workflow_status_id = workflow.id) AS total_task_count
     FROM nexora.project_task_statuses AS workflow
     WHERE workflow.organization_id = $1 AND workflow.project_id = $2
     ORDER BY workflow.sort_order, workflow.id`,
    [organizationId, projectId],
  );
  return result.rows;
}

export async function readProjectMembers(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
): Promise<ProjectMemberRow[]> {
  const result = await transaction.query<ProjectMemberRow>(
    `SELECT user_id, display_name, role, status
     FROM nexora.list_current_project_members($1, $2)
     WHERE status = 'active'
     ORDER BY display_name, user_id`,
    [organizationId, projectId],
  );
  return result.rows;
}
