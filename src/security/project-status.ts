export const PROJECT_STATUSES = [
  "planned",
  "active",
  "on_hold",
  "completed",
  "archived",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const transitions: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  planned: ["active", "archived"],
  active: ["on_hold", "completed", "archived"],
  on_hold: ["active", "archived"],
  completed: ["active", "archived"],
  archived: [],
};

export function canTransitionProjectStatus(
  current: ProjectStatus,
  next: ProjectStatus,
): boolean {
  return current === next || transitions[current].includes(next);
}
