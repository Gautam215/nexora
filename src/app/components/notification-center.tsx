"use client";

import { useEffect, useState } from "react";
import { NOTIFICATION_EVENT_TYPES } from "../../security/notification-schemas.ts";

type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

interface Notification {
  id: string;
  event_type: NotificationEventType;
  title: string;
  body: string;
  href: string;
  created_at: string;
  read_at: string | null;
  project_name: string;
  actor_name: string | null;
}

interface Preference {
  eventType: NotificationEventType;
  inAppEnabled: boolean;
}

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

const EVENT_LABELS: Record<NotificationEventType, string> = {
  mention: "Someone mentions me",
  task_assigned: "A task is assigned to me",
  project_activity: "Project activity",
  due_date: "Upcoming due dates",
  ai_workflow: "AI workflow updates",
};

export default function NotificationCenter({ organizationId }: { organizationId: string }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const notificationsBase = `/api/organizations/${encodeURIComponent(organizationId)}/notifications`;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [notificationResponse, preferenceResponse] = await Promise.all([
          fetch(`${notificationsBase}?limit=50&offset=0`, { cache: "no-store" }),
          fetch(`${notificationsBase}/preferences`, { cache: "no-store" }),
        ]);
        if (notificationResponse.status === 401 || preferenceResponse.status === 401) {
          window.location.assign("/login");
          return;
        }
        const [notificationResult, preferenceResult] = await Promise.all([
          notificationResponse.json().catch(() => null),
          preferenceResponse.json().catch(() => null),
        ]) as [ApiResult<{
          notifications: Notification[];
          unreadCount: number;
          pagination: { hasMore: boolean };
        }> | null, ApiResult<{ preferences: Preference[] }> | null];
        if (!notificationResponse.ok || !notificationResult?.data) {
          throw new Error(notificationResult?.error?.message ?? "Notifications could not be loaded.");
        }
        if (!preferenceResponse.ok || !preferenceResult?.data) {
          throw new Error(preferenceResult?.error?.message ?? "Notification preferences could not be loaded.");
        }
        if (!cancelled) {
          setNotifications(notificationResult.data.notifications);
          setUnreadCount(notificationResult.data.unreadCount);
          setHasMore(notificationResult.data.pagination.hasMore);
          setOffset(notificationResult.data.notifications.length);
          setPreferences(preferenceResult.data.preferences);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Notifications could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [notificationsBase]);

  async function setRead(notification: Notification, read: boolean): Promise<boolean> {
    setPending(notification.id);
    setError("");
    try {
      const response = await fetch(`${notificationsBase}/${encodeURIComponent(notification.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ read }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{ notification: { read_at: string | null } }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return false;
      }
      if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "Notification state could not be saved.");
      setNotifications((current) => current.map((item) => item.id === notification.id
        ? { ...item, read_at: result.data!.notification.read_at }
        : item));
      setUnreadCount((current) => Math.max(0, current + (read && !notification.read_at ? -1 : !read && notification.read_at ? 1 : 0)));
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notification state could not be saved.");
      return false;
    } finally {
      setPending("");
    }
  }

  async function setPreference(eventType: NotificationEventType, inAppEnabled: boolean) {
    setPending(`preference-${eventType}`);
    setError("");
    try {
      const response = await fetch(`${notificationsBase}/preferences`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferences: [{ eventType, inAppEnabled }] }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{ preferences: Preference[] }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "Preference could not be saved.");
      setPreferences(result.data.preferences);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preference could not be saved.");
    } finally {
      setPending("");
    }
  }

  async function loadMore() {
    if (pending || !hasMore) return;
    setPending("more");
    setError("");
    try {
      const response = await fetch(`${notificationsBase}?limit=50&offset=${offset}`, { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        notifications: Notification[];
        pagination: { hasMore: boolean };
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? "More notifications could not be loaded.");
      setNotifications((current) => [...current, ...result.data!.notifications]);
      setOffset((current) => current + result.data!.notifications.length);
      setHasMore(result.data.pagination.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "More notifications could not be loaded.");
    } finally {
      setPending("");
    }
  }

  return (
    <main className="project-work-layout">
      <div className="project-work-shell">
        <a className="secondary-link" href={`/organizations/${encodeURIComponent(organizationId)}`}>Back to workspace</a>
        <section className="project-panel notification-center-panel" aria-labelledby="notifications-title">
          <div className="notification-heading-row">
            <div>
              <p className="eyebrow">Your workspace</p>
              <h1 id="notifications-title">Notifications</h1>
            </div>
            <span className="notification-count" aria-label={`${unreadCount} unread notifications`}>{unreadCount} unread</span>
          </div>
          {error && <p className="form-message form-error" role="alert">{error}</p>}
          <section className="notification-preferences" aria-labelledby="notification-preferences-title">
            <h2 id="notification-preferences-title">In-app preferences</h2>
            <p className="workspace-note">Email delivery is not enabled yet. These controls apply to in-app notifications only.</p>
            <div className="notification-preference-list">
              {preferences.map((preference) => (
                <label className="notification-preference" key={preference.eventType}>
                  <span>{EVENT_LABELS[preference.eventType]}</span>
                  <input
                    type="checkbox"
                    checked={preference.inAppEnabled}
                    disabled={pending === `preference-${preference.eventType}`}
                    onChange={(event) => void setPreference(preference.eventType, event.target.checked)}
                  />
                </label>
              ))}
            </div>
          </section>
          <section className="notification-list-section" aria-label="Recent notifications">
            <h2>Recent</h2>
            {loading ? <p className="workspace-loading" role="status">Loading notifications...</p>
              : notifications.length ? (
                <ol className="notification-list">
                  {notifications.map((notification) => (
                    <li className={`notification-card ${notification.read_at ? "is-read" : "is-unread"}`} key={notification.id}>
                      <a className="notification-open-link" href={notification.href} onClick={(event) => {
                        if (!notification.read_at) {
                          event.preventDefault();
                          void setRead(notification, true).then((saved) => {
                            if (saved) window.location.assign(notification.href);
                          });
                        }
                      }}>
                        <span className="notification-unread-dot" aria-hidden="true" />
                        <span className="notification-copy">
                          <strong>{notification.title}</strong>
                          <span>{notification.body}</span>
                          <small>{notification.project_name} · {notification.actor_name || "Project member"} · {formatDateTime(notification.created_at)}</small>
                        </span>
                      </a>
                      <button className="quiet-button" type="button" disabled={pending === notification.id} onClick={() => void setRead(notification, !notification.read_at)}>
                        {notification.read_at ? "Mark unread" : "Mark read"}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : <p className="workspace-note">You are all caught up.</p>}
            {hasMore && <button className="quiet-button notification-load-more" type="button" onClick={() => void loadMore()} disabled={Boolean(pending)}>{pending === "more" ? "Loading..." : "Load older"}</button>}
          </section>
        </section>
      </div>
    </main>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
