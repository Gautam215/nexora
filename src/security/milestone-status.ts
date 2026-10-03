export const MILESTONE_STATUSES = ["planned", "active", "on_hold", "completed"] as const;

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

const TRANSITIONS: Record<MilestoneStatus, readonly MilestoneStatus[]> = {
  planned: ["active", "on_hold", "completed"],
  active: ["on_hold", "completed"],
  on_hold: ["active", "completed"],
  completed: ["active"],
};

export function canTransitionMilestoneStatus(
  current: MilestoneStatus,
  next: MilestoneStatus,
): boolean {
  return current === next || TRANSITIONS[current].includes(next);
}
