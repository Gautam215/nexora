import type { NextRequest } from "next/server";
import { jsonError, jsonServerFailure } from "../../../../../../server/api.ts";
import { getAuthPrincipal } from "../../../../../../server/auth.ts";
import { isRateLimited } from "../../../../../../server/auth-rate-limit.ts";
import { withOrganizationContext } from "../../../../../../server/db.ts";
import {
  recordNotificationConnect,
  recordNotificationDelivered,
  recordNotificationDisconnect,
} from "../../../../../../server/metrics.ts";
import {
  cursorForNotificationId,
  cursorFromSince,
  latestUserNotificationCursor,
  listUserNotificationsAfter,
  type NotificationCursor,
  type UserNotificationRow,
} from "../../../../../../server/notifications/user-stream.ts";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLAY_WINDOW = 200;
const POLL_MS = 2000;
const HEARTBEAT_MS = 15000;

interface RouteContext {
  params: Promise<{ organizationId: string }>;
}

// Per-user notification stream (approved default, 2026-10-26):
// Server-Sent Events over the existing HTTP stack, per organization
// and per recipient. Authentication is the session cookie
// (EventSource sends cookies same-origin); no CORS headers are
// emitted. Authorization runs before the first byte: the caller
// must be an active organization member (else 403 via
// OrganizationAccessDenied, or 404 for a deleted organization),
// and every row is then filtered by the notifications table's
// FORCE RLS policy to recipient = caller, organization = current
// organization, and project still accessible to the caller. A
// recipient therefore never sees another user's notifications,
// even by guessing an id: cursor lookup for another user's id
// returns null and the stream goes live-only.
//
// Reconnection: EventSource resends the last event id
// automatically, and ?since_id= / ?since= (ISO timestamp) are
// accepted explicitly. A fresh client goes live-only; a returning
// client replays missed notifications up to 200; a client further
// behind gets one `resync` event and refetches the notification
// list instead of a flood. Delivery is a durable table polled
// every 2 seconds, not an in-memory bus, so a restart loses no
// notifications. Rate limit shares the realtime connection scope
// (120/hour per user): notification streams and project streams
// are both realtime connections for that user.
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const principal = await getAuthPrincipal(request);
    if (!principal) return jsonError(request, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const { organizationId } = await params;
    if (!UUID_PATTERN.test(organizationId)) {
      return jsonError(request, 400, "INVALID_IDENTIFIER", "Organization identifier is invalid.");
    }
    if (await isRateLimited(request, "realtime-connect-user", principal.userId, 120, 3600, 120)) {
      return jsonError(request, 429, "RATE_LIMITED", "Too many realtime connections. Wait before trying again.", {
        "retry-after": "3600",
      });
    }
    // Membership check only: the stream itself queries
    // notifications in organization context on every poll tick.
    await withOrganizationContext(
      principal.userId,
      organizationId,
      async () => true,
      "guest",
    );

    const lastEventId = request.headers.get("last-event-id");
    const sinceIdParam = request.nextUrl.searchParams.get("since_id");
    const sinceParam = request.nextUrl.searchParams.get("since");
    const sinceId = lastEventId ?? sinceIdParam;
    const parsedSinceId = sinceId !== null && UUID_PATTERN.test(sinceId) ? sinceId : null;
    const parsedSince = sinceParam !== null && !Number.isNaN(Date.parse(sinceParam))
      ? new Date(sinceParam)
      : null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let cursor: NotificationCursor | null = null;
        recordNotificationConnect();
        const send = (text: string) => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        const sendNotification = (row: UserNotificationRow) => {
          send(
            `id: ${row.id}\nevent: notification.created\ndata: ${JSON.stringify({
              id: row.id,
              organizationId: row.organization_id,
              projectId: row.project_id,
              eventType: row.event_type,
              title: row.title,
              body: row.body,
              href: row.href,
              createdAt: row.created_at,
            })}\n\n`,
          );
          cursor = { createdAt: row.created_at, id: row.id };
          recordNotificationDelivered();
        };
        const close = () => {
          if (closed) return;
          closed = true;
          recordNotificationDisconnect();
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
          if (closed || !cursor) return;
          try {
            const rows = await withOrganizationContext(
              principal.userId,
              organizationId,
              async (transaction) =>
                listUserNotificationsAfter(transaction, organizationId, principal.userId, cursor!, REPLAY_WINDOW),
              "guest",
            );
            for (const row of rows) sendNotification(row);
          } catch {
            // A failed poll tick must not kill the stream; the
            // next tick retries, and the cursor keeps missed
            // notifications available for replay.
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
              async (transaction) =>
                latestUserNotificationCursor(transaction, organizationId, principal.userId),
              "guest",
            );
            if (closed) return;
            send(
              `event: hello\ndata: ${JSON.stringify({
                organizationId,
                latestCreatedAt: latest?.createdAt ?? null,
              })}\n\n`,
            );
            if (parsedSinceId) {
              const resolved = await withOrganizationContext(
                principal.userId,
                organizationId,
                async (transaction) =>
                  cursorForNotificationId(transaction, organizationId, principal.userId, parsedSinceId),
                "guest",
              );
              if (closed) return;
              if (resolved) {
                cursor = resolved;
                const missed = await withOrganizationContext(
                  principal.userId,
                  organizationId,
                  async (transaction) =>
                    listUserNotificationsAfter(transaction, organizationId, principal.userId, cursor!, REPLAY_WINDOW + 1),
                  "guest",
                );
                if (missed.length > REPLAY_WINDOW) {
                  send(
                    `event: resync\ndata: ${JSON.stringify({ organizationId, latestCreatedAt: latest?.createdAt ?? null })}\n\n`,
                  );
                  cursor = latest ?? cursor;
                } else {
                  for (const row of missed) sendNotification(row);
                  if (!cursor) cursor = latest;
                  else if (missed.length === 0) cursor = latest ?? cursor;
                }
              } else {
                // Another user's id, or a notification the caller
                // can no longer access: live-only, no leak about
                // whether that id exists.
                cursor = latest ?? { createdAt: new Date(), id: "00000000-0000-0000-0000-000000000000" };
              }
            } else if (parsedSince) {
              cursor = cursorFromSince(parsedSince);
              const missed = await withOrganizationContext(
                principal.userId,
                organizationId,
                async (transaction) =>
                  listUserNotificationsAfter(transaction, organizationId, principal.userId, cursor!, REPLAY_WINDOW + 1),
                "guest",
              );
              if (closed) return;
              if (missed.length > REPLAY_WINDOW) {
                send(
                  `event: resync\ndata: ${JSON.stringify({ organizationId, latestCreatedAt: latest?.createdAt ?? null })}\n\n`,
                );
                cursor = latest ?? cursor;
              } else {
                for (const row of missed) sendNotification(row);
                if (missed.length === 0 && latest) cursor = latest;
              }
            } else {
              cursor = latest ?? { createdAt: new Date(), id: "00000000-0000-0000-0000-000000000000" };
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
    return jsonServerFailure(request, "notifications.stream", error);
  }
}
