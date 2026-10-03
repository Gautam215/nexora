import "server-only";
import type { DatabaseTransaction } from "./db.ts";

export type TaskFileScope =
  | { kind: "not_found" }
  | {
      kind: "ok";
      projectStatus: string;
      canWork: boolean;
      taskArchived: boolean;
      milestoneStatus: string | null;
    };

export async function readTaskFileScope(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  taskId: string,
): Promise<TaskFileScope> {
  const project = await transaction.query<{
    status: string;
    can_access: boolean;
    can_work: boolean;
  }>(
    `SELECT project.status::text AS status,
            nexora.can_access_current_project(project.organization_id, project.id) AS can_access,
            nexora.can_work_current_project(project.organization_id, project.id) AS can_work
     FROM nexora.projects AS project
     WHERE project.organization_id = $1 AND project.id = $2`,
    [organizationId, projectId],
  );
  const projectRow = project.rows[0];
  if (!projectRow?.can_access) return { kind: "not_found" };

  const task = await transaction.query<{ archived_at: Date | null; milestone_status: string | null }>(
    `SELECT task.archived_at,
            milestone.status::text AS milestone_status
     FROM nexora.tasks AS task
     LEFT JOIN nexora.milestones AS milestone
       ON milestone.organization_id = task.organization_id
      AND milestone.project_id = task.project_id
      AND milestone.id = task.milestone_id
     WHERE task.organization_id = $1 AND task.project_id = $2 AND task.id = $3`,
    [organizationId, projectId, taskId],
  );
  const taskRow = task.rows[0];
  if (!taskRow) return { kind: "not_found" };

  return {
    kind: "ok",
    projectStatus: projectRow.status,
    canWork: projectRow.can_work,
    taskArchived: taskRow.archived_at !== null,
    milestoneStatus: taskRow.milestone_status,
  };
}

export function taskFileWriteBlock(scope: Extract<TaskFileScope, { kind: "ok" }>):
  | "forbidden"
  | "project_closed"
  | "task_archived"
  | "milestone_closed"
  | null {
  if (!scope.canWork) return "forbidden";
  if (["completed", "archived"].includes(scope.projectStatus)) return "project_closed";
  if (scope.taskArchived) return "task_archived";
  if (scope.milestoneStatus === "completed") return "milestone_closed";
  return null;
}
