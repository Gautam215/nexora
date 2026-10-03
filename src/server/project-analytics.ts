import "server-only";
import type { ProjectAnalytics } from "../security/project-analytics.ts";
import {
  calculateCompletionPercent,
  calculateProjectHealth,
} from "../security/project-analytics.ts";
import type { ProjectStatus } from "../security/project-status.ts";
import type { DatabaseTransaction } from "./db.ts";

interface SummaryRow {
  as_of_date: string;
  project_status: ProjectStatus;
  target_date: string | null;
  total_task_count: number;
  completed_task_count: number;
  overdue_task_count: number;
  total_milestone_count: number;
  completed_milestone_count: number;
  overdue_milestone_count: number;
}

interface WorkloadRow {
  user_id: string | null;
  display_name: string;
  status: string | null;
  open_task_count: number;
  estimated_task_count: number;
  estimated_effort_hours: string;
  unestimated_task_count: number;
}

interface ActivityRow {
  id: string;
  action: string;
  created_at: Date;
  actor_name: string | null;
  target_name: string | null;
  last_7_days_count: number;
}

export async function readProjectAnalytics(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
): Promise<ProjectAnalytics | null> {
  const summaryResult = await transaction.query<SummaryRow>(
    `SELECT CURRENT_DATE::text AS as_of_date,
            project.status::text AS project_status,
            project.target_date::text AS target_date,
            count(task.id)::integer AS total_task_count,
            count(task.id) FILTER (WHERE workflow.is_done)::integer AS completed_task_count,
            count(task.id) FILTER (
              WHERE NOT workflow.is_done AND task.due_date < CURRENT_DATE
            )::integer AS overdue_task_count,
            (
              SELECT count(*)::integer
              FROM nexora.milestones AS milestone
              WHERE milestone.organization_id = project.organization_id
                AND milestone.project_id = project.id
            ) AS total_milestone_count,
            (
              SELECT count(*)::integer
              FROM nexora.milestones AS milestone
              WHERE milestone.organization_id = project.organization_id
                AND milestone.project_id = project.id
                AND milestone.status = 'completed'
            ) AS completed_milestone_count,
            (
              SELECT count(*)::integer
              FROM nexora.milestones AS milestone
              WHERE milestone.organization_id = project.organization_id
                AND milestone.project_id = project.id
                AND milestone.status <> 'completed'
                AND milestone.end_date < CURRENT_DATE
            ) AS overdue_milestone_count
     FROM nexora.projects AS project
     LEFT JOIN nexora.tasks AS task
       ON task.organization_id = project.organization_id
      AND task.project_id = project.id
      AND task.archived_at IS NULL
     LEFT JOIN nexora.project_task_statuses AS workflow
       ON workflow.organization_id = task.organization_id
      AND workflow.project_id = task.project_id
      AND workflow.id = task.workflow_status_id
     WHERE project.organization_id = $1
       AND project.id = $2
       AND nexora.can_access_current_project(project.organization_id, project.id)
     GROUP BY project.organization_id, project.id, project.status, project.target_date`,
    [organizationId, projectId],
  );
  const summary = summaryResult.rows[0];
  if (!summary) return null;

  const milestoneResult = await transaction.query<ProjectAnalytics["milestones"]["items"][number]>(
    `SELECT milestone.id::text AS id,
            milestone.name,
            milestone.status::text AS status,
            milestone.start_date::text AS start_date,
            milestone.end_date::text AS end_date,
            COALESCE(metrics.task_count, 0)::integer AS task_count,
            COALESCE(metrics.completed_task_count, 0)::integer AS completed_task_count,
            CASE WHEN COALESCE(metrics.task_count, 0) = 0 THEN NULL
                 ELSE pg_catalog.round(100.0 * metrics.completed_task_count / metrics.task_count)::integer
            END AS progress_percent
     FROM nexora.milestones AS milestone
     LEFT JOIN LATERAL (
       SELECT count(task.id)::integer AS task_count,
              count(task.id) FILTER (WHERE workflow.is_done)::integer AS completed_task_count
       FROM nexora.tasks AS task
       JOIN nexora.project_task_statuses AS workflow
         ON workflow.organization_id = task.organization_id
        AND workflow.project_id = task.project_id
        AND workflow.id = task.workflow_status_id
       WHERE task.organization_id = milestone.organization_id
         AND task.project_id = milestone.project_id
         AND task.milestone_id = milestone.id
         AND task.archived_at IS NULL
     ) AS metrics ON true
     WHERE milestone.organization_id = $1 AND milestone.project_id = $2
     ORDER BY CASE WHEN milestone.status = 'completed' THEN 1 ELSE 0 END,
              milestone.end_date NULLS LAST,
              milestone.start_date NULLS LAST,
              milestone.created_at,
              milestone.id
     LIMIT 6`,
    [organizationId, projectId],
  );

  const workloadResult = await transaction.query<WorkloadRow>(
    `WITH task_load AS (
       SELECT task.assignee_user_id,
              count(*)::integer AS open_task_count,
              count(*) FILTER (WHERE task.estimated_effort_hours IS NOT NULL)::integer AS estimated_task_count,
              COALESCE(sum(task.estimated_effort_hours), 0)::text AS estimated_effort_hours,
              count(*) FILTER (WHERE task.estimated_effort_hours IS NULL)::integer AS unestimated_task_count
       FROM nexora.tasks AS task
       JOIN nexora.project_task_statuses AS workflow
         ON workflow.organization_id = task.organization_id
        AND workflow.project_id = task.project_id
        AND workflow.id = task.workflow_status_id
       WHERE task.organization_id = $1
         AND task.project_id = $2
         AND task.archived_at IS NULL
         AND NOT workflow.is_done
       GROUP BY task.assignee_user_id
     ), unassigned_load AS (
       SELECT COALESCE(sum(open_task_count), 0)::integer AS open_task_count,
              COALESCE(sum(estimated_task_count), 0)::integer AS estimated_task_count,
              COALESCE(sum(estimated_effort_hours::numeric), 0)::text AS estimated_effort_hours,
              COALESCE(sum(unestimated_task_count), 0)::integer AS unestimated_task_count
       FROM task_load
       WHERE assignee_user_id IS NULL
     )
     SELECT member.user_id,
            member.display_name,
            member.status,
            COALESCE(load.open_task_count, 0)::integer AS open_task_count,
            COALESCE(load.estimated_task_count, 0)::integer AS estimated_task_count,
            COALESCE(load.estimated_effort_hours, '0') AS estimated_effort_hours,
            COALESCE(load.unestimated_task_count, 0)::integer AS unestimated_task_count
     FROM nexora.list_current_project_members($1, $2) AS member
     LEFT JOIN task_load AS load ON load.assignee_user_id = member.user_id
     UNION ALL
     SELECT NULL::uuid AS user_id,
            'Unassigned'::text AS display_name,
            NULL::text AS status,
            unassigned_load.open_task_count,
            unassigned_load.estimated_task_count,
            unassigned_load.estimated_effort_hours,
            unassigned_load.unestimated_task_count
     FROM unassigned_load
     ORDER BY open_task_count DESC, user_id NULLS LAST`,
    [organizationId, projectId],
  );

  const deadlineResult = await transaction.query<ProjectAnalytics["deadlines"][number]>(
    `SELECT due.id, due.kind, due.title, due.due_date
     FROM (
       SELECT task.id::text AS id,
              'task'::text AS kind,
              task.title,
              task.due_date::text AS due_date
       FROM nexora.tasks AS task
       JOIN nexora.project_task_statuses AS workflow
         ON workflow.organization_id = task.organization_id
        AND workflow.project_id = task.project_id
        AND workflow.id = task.workflow_status_id
       WHERE task.organization_id = $1
         AND task.project_id = $2
         AND task.archived_at IS NULL
         AND NOT workflow.is_done
         AND task.due_date >= CURRENT_DATE
       UNION ALL
       SELECT milestone.id::text AS id,
              'milestone'::text AS kind,
              milestone.name AS title,
              milestone.end_date::text AS due_date
       FROM nexora.milestones AS milestone
       WHERE milestone.organization_id = $1
         AND milestone.project_id = $2
         AND milestone.status <> 'completed'
         AND milestone.end_date >= CURRENT_DATE
       UNION ALL
       SELECT project.id::text AS id,
              'project'::text AS kind,
              project.name || ' target date' AS title,
              project.target_date::text AS due_date
       FROM nexora.projects AS project
       WHERE project.organization_id = $1
         AND project.id = $2
         AND project.status NOT IN ('completed', 'archived')
         AND project.target_date >= CURRENT_DATE
     ) AS due
     ORDER BY due.due_date, due.kind, due.title, due.id
     LIMIT 8`,
    [organizationId, projectId],
  );

  const activityResult = await transaction.query<ActivityRow>(
    `WITH scoped_events AS (
       SELECT event.id,
              event.action,
              event.target_type,
              event.target_id,
              event.actor_user_id,
              event.details,
              event.created_at
       FROM nexora.audit_events AS event
       WHERE event.organization_id = $1
         AND event.created_at >= pg_catalog.now() - interval '7 days'
         AND (
           (event.target_type = 'project' AND event.target_id = $2)
           OR (event.target_type = 'task' AND EXISTS (
             SELECT 1
             FROM nexora.tasks AS task
             WHERE task.organization_id = $1
               AND task.project_id = $2
               AND task.id = event.target_id
           ))
           OR (event.target_type = 'milestone' AND EXISTS (
             SELECT 1
             FROM nexora.milestones AS milestone
             WHERE milestone.organization_id = $1
               AND milestone.project_id = $2
               AND milestone.id = event.target_id
           ))
           OR (event.target_type = 'project_membership'
             AND pg_catalog.lower(event.details->>'projectId') = pg_catalog.lower($2::text))
         )
     )
     SELECT event.id::text AS id,
            event.action,
            event.created_at,
            actor.display_name AS actor_name,
            COALESCE(task.title, milestone.name, project_member.display_name) AS target_name,
            count(*) OVER ()::integer AS last_7_days_count
     FROM scoped_events AS event
     LEFT JOIN nexora.tasks AS task
       ON event.target_type = 'task'
      AND task.organization_id = $1
      AND task.project_id = $2
      AND task.id = event.target_id
     LEFT JOIN nexora.milestones AS milestone
       ON event.target_type = 'milestone'
      AND milestone.organization_id = $1
      AND milestone.project_id = $2
      AND milestone.id = event.target_id
     LEFT JOIN LATERAL (
       SELECT member.display_name
       FROM nexora.list_current_project_members($1, $2) AS member
       WHERE event.target_type = 'project_membership'
         AND member.user_id = event.target_id
       LIMIT 1
     ) AS project_member ON true
     LEFT JOIN LATERAL (
       SELECT member.display_name
       FROM nexora.list_current_project_members($1, $2) AS member
       WHERE member.user_id = event.actor_user_id
       LIMIT 1
     ) AS actor ON true
     ORDER BY event.created_at DESC, event.id DESC
     LIMIT 5`,
    [organizationId, projectId],
  );

  const workloadRows = workloadResult.rows;
  const unassigned = workloadRows.find((item) => item.user_id === null);
  const activityRows = activityResult.rows;
  const health = calculateProjectHealth({
    projectStatus: summary.project_status,
    targetDate: summary.target_date,
    asOfDate: summary.as_of_date,
    overdueTasks: summary.overdue_task_count,
    overdueMilestones: summary.overdue_milestone_count,
  });

  return {
    as_of_date: summary.as_of_date,
    project_status: summary.project_status,
    target_date: summary.target_date,
    progress_percent: calculateCompletionPercent(summary.completed_task_count, summary.total_task_count),
    tasks: {
      total: summary.total_task_count,
      completed: summary.completed_task_count,
      overdue: summary.overdue_task_count,
    },
    milestones: {
      total: summary.total_milestone_count,
      completed: summary.completed_milestone_count,
      overdue: summary.overdue_milestone_count,
      items: milestoneResult.rows,
    },
    health,
    workload: {
      members: workloadRows.filter((item): item is WorkloadRow & { user_id: string; status: string } => (
        item.user_id !== null && item.status !== null
      )),
      unassigned: {
        open_task_count: unassigned?.open_task_count ?? 0,
        estimated_task_count: unassigned?.estimated_task_count ?? 0,
        estimated_effort_hours: unassigned?.estimated_effort_hours ?? "0",
        unestimated_task_count: unassigned?.unestimated_task_count ?? 0,
      },
    },
    deadlines: deadlineResult.rows,
    activity: {
      last_7_days_count: activityRows[0]?.last_7_days_count ?? 0,
      events: activityRows.map((event) => ({
        id: event.id,
        action: event.action,
        created_at: event.created_at.toISOString(),
        actor_name: event.actor_name,
        target_name: event.target_name,
      })),
    },
  };
}
