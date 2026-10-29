import { randomUUID } from "node:crypto";
import { withOrganizationContext, type DatabaseTransaction } from "../db.ts";
import { recordRealtimePublished } from "../metrics.ts";
import { lockProjectTaskGraph } from "../project-work.ts";

// Realtime events, v1 scope: project-channel events only.
// notification.created is future work (see ARCHITECTURE.md):
// notifications already have their own centre, and delivering them
// over a stream needs a user-level channel decision. presence.changed
// is NOT a log event: it is ephemeral roster state from the
// in-process registry in `presence.ts`, sent over the same stream
// without an event id. The type union lists only what has a log
// producer.
export const REALTIME_EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.deleted",
  "comment.created",
  "project.updated",
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

// task.deleted fires when a task is archived: archiving is this
// codebase's task deletion (tasks are never hard-deleted).
export interface RealtimeEventData {
  taskId?: string;
  taskTitle?: string;
  commentId?: string;
  projectId?: string;
  projectName?: string;
}

export interface PublishedRealtimeEvent {
  id: string;
  version: number;
}

// Publishes one event AFTER the caller's mutation transaction has
// committed: this helper opens its own short transaction, so it must
// never be called inside a mutation transaction. Versions are
// per-project, assigned under the project task-graph lock, so two
// publishers can never assign the same version. A publish failure
// throws to the caller, which logs it and never fails the mutation
// it reports on.
export async function publishRealtimeEvent(input: {
  userId: string;
  organizationId: string;
  projectId: string;
  type: RealtimeEventType;
  data: RealtimeEventData;
}): Promise<PublishedRealtimeEvent> {
  const eventId = randomUUID();
  const version = await withOrganizationContext(
    input.userId,
    input.organizationId,
    async (transaction) => {
      await lockProjectTaskGraph(transaction, input.organizationId, input.projectId);
      const maxResult = await transaction.query<{ max_version: string | null }>(
        `SELECT pg_catalog.max(version)::text AS max_version
         FROM nexora.realtime_events
         WHERE organization_id = $1 AND project_id = $2`,
        [input.organizationId, input.projectId],
      );
      const nextVersion = Number(maxResult.rows[0]?.max_version ?? 0) + 1;
      await transaction.query(
        `INSERT INTO nexora.realtime_events
           (id, organization_id, project_id, type, version, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          eventId,
          input.organizationId,
          input.projectId,
          input.type,
          nextVersion,
          JSON.stringify(input.data),
        ],
      );
      return nextVersion;
    },
  );
  // Only a committed publish counts: a throw above leaves the
  // counter untouched.
  recordRealtimePublished();
  return { id: eventId, version };
}

export interface RealtimeEventRow {
  id: string;
  type: RealtimeEventType;
  version: number;
  data: RealtimeEventData;
  created_at: string;
}

export async function listRealtimeEvents(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
  afterVersion: number,
  limit: number,
): Promise<RealtimeEventRow[]> {
  const result = await transaction.query<RealtimeEventRow>(
    `SELECT id, type, version, data, created_at::text AS created_at
     FROM nexora.realtime_events
     WHERE organization_id = $1 AND project_id = $2 AND version > $3
     ORDER BY version ASC LIMIT $4`,
    [organizationId, projectId, afterVersion, limit],
  );
  return result.rows;
}

export async function latestRealtimeVersion(
  transaction: DatabaseTransaction,
  organizationId: string,
  projectId: string,
): Promise<number> {
  const result = await transaction.query<{ max_version: string | null }>(
    `SELECT pg_catalog.max(version)::text AS max_version
     FROM nexora.realtime_events
     WHERE organization_id = $1 AND project_id = $2`,
    [organizationId, projectId],
  );
  return Number(result.rows[0]?.max_version ?? 0);
}

export type ReplayMode = "live" | "replay" | "resync";

export interface ReplayPlan {
  mode: ReplayMode;
  /** Versions above this value are sent (replay), or this is the new baseline (live/resync). */
  fromVersion: number;
}

// Pure replay decision, unit-tested on its own: a fresh client (no
// last seen version) goes live-only; a returning client replays what
// it missed up to the window; a client further behind than the window
// gets a resync signal and refetches state instead of a flood.
export function planReplay(
  latestVersion: number,
  lastSeen: number | null,
  window: number,
): ReplayPlan {
  if (lastSeen === null || lastSeen >= latestVersion) {
    return { mode: "live", fromVersion: latestVersion };
  }
  if (latestVersion - lastSeen > window) {
    return { mode: "resync", fromVersion: latestVersion };
  }
  return { mode: "replay", fromVersion: lastSeen };
}
