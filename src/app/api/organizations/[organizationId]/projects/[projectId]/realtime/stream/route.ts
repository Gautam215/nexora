import type { NextRequest } from "next/server";
import { jsonError, jsonServerFailure } from "../../../../../../../../server/api.ts";
import { getAuthenticatedUser, getAuthPrincipal } from "../../../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../../../server/db.ts";
import {
  recordRealtimeConnect,
  recordRealtimeDelivered,
  recordRealtimeDisconnect,
} from "../../../../../../../../server/metrics.ts";
import {
  latestRealtimeVersion,
  listRealtimeEvents,
  planReplay,
  type RealtimeEventRow,
} from "../../../../../../../../server/realtime/events.ts";
import { presenceRegistry } from "../../../../../../../../server/realtime/presence.ts";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLAY_WINDOW = 200;
const POLL_MS = 2000;
const HEARTBEAT_MS = 15000;

interface RouteContext {
  params: Promise<{ organizationId: string; projectId: string }>;
}

// Realtime project stream (PRD 25): Server-Sent Events over the
// existing HTTP stack — no new dependency, no WebSocket provider.
// Authentication is the session cookie (EventSource sends cookies
// same-origin); no CORS headers are emitted, so a cross-origin page
// cannot read this stream even if it could open it. Authorization
// runs before the first byte: the project must be visible to the
// caller, else 404 (foreign projects) or 403 (non-members, via the
// organization context).
//
// Reconnection: EventSource resends the last event id
// automatically, and ?since= is accepted explicitly. A fresh client
// (no last seen version) goes live-only; a returning client replays
// missed events up to the window; a client further behind gets one
// `resync` event and refetches state instead of a flood.
//
// Delivery is a durable event log polled every 2 seconds, not an
// in-memory bus: every server instance sees the same log, so this
// works across instances at polling cost, and a restart loses no
// events. That trade-off is documented in ARCHITECTURE.md.
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId, projectId } = await params;
    if (!UUID_PATTERN.test(projectId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Project identifier is invalid.");
    }
    if (await isRateLimited(request, "realtime-connect-user", principal.userId, 120, 3600, 120)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many realtime connections. Wait before trying again.", {
        "retry-after": "3600",
      });
    }
    const visible = await withOrganizationContext(
      principal.userId,
      organizationId,
      async (transaction) => {
        const result = await transaction.query<{ visible: boolean }>(
          `SELECT nexora.can_access_current_project($1, $2) AS visible`,
          [organizationId, projectId],
        );
        return result.rows[0]?.visible === true;
      },
    );
    if (!visible) return jsonError(request, 404, "PROJECT_NOT_FOUND", "Project not found.");

    // Presence is best-effort: without a display name the stream
    // still works, it just does not join the roster.
    const authenticatedUser = await getAuthenticatedUser(principal);
    const displayName = authenticatedUser?.display_name ?? null;

    const lastEventId = request.headers.get("last-event-id");
    const sinceParam = request.nextUrl.searchParams.get("since");
    const parsedSince = lastEventId ?? sinceParam;
    const lastSeen =
      parsedSince !== null && /^\d+$/.test(parsedSince) ? Number(parsedSince) : null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let lastSent = 0;
        // Counted here, not in the route handler above: start runs
        // only for a stream the runtime actually created, after
        // authentication and project visibility passed.
        recordRealtimeConnect();
        let lastPresenceVersion = -1;
        let presenceJoined = false;
        const sendPresence = (members: { userId: string; displayName: string }[]) => {
          // No `id:` line: presence is ephemeral roster state, not
          // a log event, so it must not move the client's
          // last-event-id cursor.
          send(
            `event: presence.changed\ndata: ${JSON.stringify({ projectId, online: members })}\n\n`,
          );
        };
        if (displayName) {
          const joined = presenceRegistry.join(organizationId, projectId, principal.userId, displayName);
          presenceJoined = true;
          lastPresenceVersion = joined.version;
        }
        const send = (text: string) => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        const sendEvent = (event: RealtimeEventRow) => {
          send(
            `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.data, version: event.version, projectId })}\n\n`,
          );
          lastSent = event.version;
          recordRealtimeDelivered();
        };
        const close = () => {
          if (closed) return;
          closed = true;
          recordRealtimeDisconnect();
          if (presenceJoined) presenceRegistry.leave(organizationId, projectId, principal.userId);
          clearInterval(pollTimer);
          clearInterval(heartbeatTimer);
          try {
            controller.close();
          } catch {
            // Already closed by the runtime.
          }
        };
        request.signal.addEventListener("abort", close, { once: true });

        const poll = async () => {
          if (closed) return;
          try {
            const events = await withOrganizationContext(
              principal.userId,
              organizationId,
              async (transaction) => listRealtimeEvents(transaction, organizationId, projectId, lastSent, REPLAY_WINDOW),
            );
            for (const event of events) sendEvent(event);
          } catch {
            // A failed poll tick must not kill the stream; the next
            // tick retries, and the version cursor keeps missed
            // events available for replay.
          }
          // Presence rides the same poll loop: no extra timer, no
          // extra transport. A roster change since the last sent
          // version goes out on the next tick.
          if (presenceJoined) {
            const currentVersion = presenceRegistry.version(organizationId, projectId);
            if (currentVersion !== lastPresenceVersion) {
              lastPresenceVersion = currentVersion;
              sendPresence(presenceRegistry.snapshot(organizationId, projectId));
            }
          }
        };
        const pollTimer = setInterval(() => {
          void poll();
        }, POLL_MS);
        const heartbeatTimer = setInterval(() => {
          send(": heartbeat\n\n");
        }, HEARTBEAT_MS);

        void (async () => {
          try {
            const latest = await withOrganizationContext(
              principal.userId,
              organizationId,
              async (transaction) => latestRealtimeVersion(transaction, organizationId, projectId),
            );
            if (closed) return;
            send(`event: hello\ndata: ${JSON.stringify({ projectId, latestVersion: latest })}\n\n`);
            if (presenceJoined) {
              sendPresence(presenceRegistry.snapshot(organizationId, projectId));
            }
            const plan = planReplay(latest, lastSeen, REPLAY_WINDOW);
            if (plan.mode === "resync") {
              send(`event: resync\ndata: ${JSON.stringify({ projectId, latestVersion: latest })}\n\n`);
              lastSent = latest;
            } else if (plan.mode === "replay") {
              const missed = await withOrganizationContext(
                principal.userId,
                organizationId,
                async (transaction) =>
                  listRealtimeEvents(transaction, organizationId, projectId, plan.fromVersion, REPLAY_WINDOW),
              );
              if (closed) return;
              for (const event of missed) sendEvent(event);
              lastSent = Math.max(lastSent, latest);
            } else {
              lastSent = latest;
            }
          } catch {
            close();
          }
        })();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    return jsonServerFailure(request, "realtime.stream", error);
  }
}
