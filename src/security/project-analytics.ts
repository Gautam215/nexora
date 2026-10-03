import type { ProjectStatus } from "./project-status.ts";

export interface ProjectAnalytics {
  as_of_date: string;
  project_status: ProjectStatus;
  target_date: string | null;
  progress_percent: number | null;
  tasks: {
    total: number;
    completed: number;
    overdue: number;
  };
  milestones: {
    total: number;
    completed: number;
    overdue: number;
    items: Array<{
      id: string;
      name: string;
      status: string;
      start_date: string | null;
      end_date: string | null;
      task_count: number;
      completed_task_count: number;
      progress_percent: number | null;
    }>;
  };
  health: ProjectHealth;
  workload: {
    members: Array<{
      user_id: string;
      display_name: string;
      status: string;
      open_task_count: number;
      estimated_task_count: number;
      estimated_effort_hours: string;
      unestimated_task_count: number;
    }>;
    unassigned: {
      open_task_count: number;
      estimated_task_count: number;
      estimated_effort_hours: string;
      unestimated_task_count: number;
    };
  };
  deadlines: Array<{
    id: string;
    kind: "task" | "milestone" | "project";
    title: string;
    due_date: string;
  }>;
  activity: {
    last_7_days_count: number;
    events: Array<{
      id: string;
      action: string;
      created_at: string;
      actor_name: string | null;
      target_name: string | null;
    }>;
  };
}

export type ProjectHealthStatus =
  | "on_track"
  | "at_risk"
  | "no_target_date"
  | "planned"
  | "on_hold"
  | "completed"
  | "archived";

export interface ProjectHealth {
  status: ProjectHealthStatus;
  reason: string;
}

export function calculateCompletionPercent(completed: number, total: number): number | null {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || completed < 0 || total <= 0) {
    return null;
  }
  return Math.round((Math.min(completed, total) / total) * 100);
}

export function calculateProjectHealth(input: {
  projectStatus: ProjectStatus;
  targetDate: string | null;
  asOfDate: string;
  overdueTasks: number;
  overdueMilestones: number;
}): ProjectHealth {
  if (input.projectStatus === "completed") {
    return { status: "completed", reason: "The project is marked complete." };
  }
  if (input.projectStatus === "archived") {
    return { status: "archived", reason: "The project is archived." };
  }

  const risks: string[] = [];
  if (input.targetDate && input.targetDate < input.asOfDate) {
    risks.push("The project target date has passed.");
  }
  if (input.overdueTasks > 0) {
    risks.push(`${input.overdueTasks} overdue ${input.overdueTasks === 1 ? "task" : "tasks"}.`);
  }
  if (input.overdueMilestones > 0) {
    risks.push(`${input.overdueMilestones} overdue ${input.overdueMilestones === 1 ? "milestone" : "milestones"}.`);
  }
  if (risks.length) return { status: "at_risk", reason: risks.join(" ") };
  if (input.projectStatus === "on_hold") {
    return { status: "on_hold", reason: "The project is on hold." };
  }
  if (!input.targetDate) {
    return { status: "no_target_date", reason: "Set a target date to assess project timing." };
  }
  if (input.projectStatus === "planned") {
    return { status: "planned", reason: "The project has not started." };
  }
  return { status: "on_track", reason: "No overdue work; the project target date has not passed." };
}
