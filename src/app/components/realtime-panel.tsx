"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshIcon } from "./button-icons";

// Live project updates. A deliberately small surface: the
// panel opens the project's Server-Sent Events stream, shows the
// connection state and who else has the project open, and when an
// event arrives it offers a refresh instead of silently rewriting
// the page under the user. The stream itself (replay, resync,
// authorization, presence roster) lives server-side; this component
// only renders what it reports. Presence is best-effort and
// per-process server-side, so the roster can lag a dead socket and
// can miss members connected to another instance.
export default function RealtimePanel({
  organizationId,
  projectId,
}: {
  organizationId: string;
  projectId: string;
}) {
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "unavailable">("connecting");
  const [lastEvent, setLastEvent] = useState("");
  const [hasUpdate, setHasUpdate] = useState(false);
  const [online, setOnline] = useState<string[] | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource(
      `/api/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/realtime/stream`,
    );
    sourceRef.current = source;
    source.addEventListener("hello", () => {
      setStatus("connected");
    });
    source.addEventListener("resync", () => {
      setHasUpdate(true);
    });
    source.addEventListener("presence.changed", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          online?: { displayName?: string }[];
        };
        setOnline((data.online ?? []).map((member) => member.displayName ?? "?"));
      } catch {
        // A malformed presence payload leaves the last roster shown.
      }
    });
    const onProjectEvent = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { version?: number };
        setLastEvent(`Version ${data.version ?? "?"}: ${event.type}`);
      } catch {
        setLastEvent(event.type);
      }
      setHasUpdate(true);
    };
    for (const type of ["task.created", "task.updated", "task.deleted", "comment.created", "project.updated"]) {
      source.addEventListener(type, onProjectEvent);
    }
    source.onerror = () => {
      setStatus(source.readyState === EventSource.CLOSED ? "unavailable" : "reconnecting");
    };
    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [organizationId, projectId]);

  return (
    <section className="project-detail-section" aria-labelledby="realtime-title">
      <div className="project-section-heading">
        <div>
          <p className="eyebrow">Live</p>
          <h3 id="realtime-title">Live updates</h3>
        </div>
      </div>
      <p className="project-section-copy">
        Connection: {status}
        {lastEvent ? ` — last event ${lastEvent}` : ""}
      </p>
      {online !== null ? (
        <p className="project-section-copy">
          Online now: {online.length > 0 ? online.join(", ") : "nobody"}
        </p>
      ) : null}
      {hasUpdate ? (
        <div>
          <p className="project-section-copy">This project changed. Refresh to see the latest work.</p>
          <button className="quiet-button" type="button" onClick={() => window.location.reload()}><RefreshIcon />
            Refresh project
          </button>
        </div>
      ) : null}
    </section>
  );
}
