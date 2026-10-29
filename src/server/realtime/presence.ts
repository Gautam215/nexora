// Project presence (`presence.changed`): who currently has
// the project's stream open. This is deliberately NOT part of the
// durable event log in `events.ts`: connect/disconnect churn would
// flood per-project versions, and presence is ephemeral state, not
// history. The registry is in-process and per-project, keyed by
// organization + project; the stream's poll loop sends the current
// roster whenever the roster version changes.
//
// Honest limits, documented in ARCHITECTURE.md:
// - Multi-instance deployments see only their own connections: a
//   member connected to another instance is absent from this
//   instance's roster. Presence is best-effort, never authoritative;
//   the database remains authoritative for everything else.
// - A dead socket lingers until the runtime closes the stream.
//   SSE is server-to-client only, so there is no client heartbeat
//   to age entries out; entries clear on stream close.
// - Only display names are exposed. Members already see each other
//   through the project member list, so the roster reveals nothing
//   new.

export interface PresenceMember {
  userId: string;
  displayName: string;
}

interface PresenceEntry {
  displayName: string;
  connections: number;
}

export class PresenceRegistry {
  private readonly projects = new Map<string, Map<string, PresenceEntry>>();
  private readonly versions = new Map<string, number>();

  private key(organizationId: string, projectId: string): string {
    return `${organizationId}:${projectId}`;
  }

  // A second connection from the same user adds a connection, not a
  // roster row, and does not bump the version: the roster is
  // unchanged. Returns the roster and version after the join.
  join(
    organizationId: string,
    projectId: string,
    userId: string,
    displayName: string,
  ): { members: PresenceMember[]; version: number } {
    const key = this.key(organizationId, projectId);
    let members = this.projects.get(key);
    if (!members) {
      members = new Map();
      this.projects.set(key, members);
    }
    const entry = members.get(userId);
    if (entry) {
      entry.connections += 1;
      entry.displayName = displayName;
    } else {
      members.set(userId, { displayName, connections: 1 });
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    }
    return { members: this.snapshot(organizationId, projectId), version: this.version(organizationId, projectId) };
  }

  // Returns null when the user was not present (nothing changed).
  // The last connection leaving removes the row and bumps the
  // version; earlier leaves only decrement the count.
  leave(
    organizationId: string,
    projectId: string,
    userId: string,
  ): { members: PresenceMember[]; version: number } | null {
    const key = this.key(organizationId, projectId);
    const members = this.projects.get(key);
    const entry = members?.get(userId);
    if (!members || !entry) return null;
    entry.connections -= 1;
    if (entry.connections > 0) {
      return { members: this.snapshot(organizationId, projectId), version: this.version(organizationId, projectId) };
    }
    members.delete(userId);
    if (members.size === 0) this.projects.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    return { members: this.snapshot(organizationId, projectId), version: this.version(organizationId, projectId) };
  }

  snapshot(organizationId: string, projectId: string): PresenceMember[] {
    const members = this.projects.get(this.key(organizationId, projectId));
    if (!members) return [];
    return [...members.entries()]
      .map(([userId, entry]) => ({ userId, displayName: entry.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
  }

  version(organizationId: string, projectId: string): number {
    return this.versions.get(this.key(organizationId, projectId)) ?? 0;
  }
}

export const presenceRegistry = new PresenceRegistry();
