"use client";

import { useEffect, useState } from "react";
import OrganizationProjects from "./organization-projects";

interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  created_at: string;
}

interface ApiResult {
  data?: { organization: Organization };
  error?: { message?: string };
}

export default function OrganizationPage({ organizationId }: { organizationId: string }) {
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/organizations/${encodeURIComponent(organizationId)}`, {
          cache: "no-store",
        });
        const result = (await response.json()) as ApiResult;
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!response.ok) {
          if (!cancelled) setError(result.error?.message ?? "Workspace could not be loaded.");
          return;
        }
        if (!cancelled) setOrganization(result.data?.organization ?? null);
      } catch {
        if (!cancelled) setError("The service could not be reached. Try again in a moment.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  return (
    <main className="auth-layout workspace-layout">
      <aside className="auth-story">
        <a className="brand" href="/" aria-label="Nexora home">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>Nexora</span>
        </a>
        <div className="auth-story-copy">
          <p className="eyebrow">Workspace boundary</p>
          <h1>Keep the right work together.</h1>
          <p>Every Nexora organization has its own membership and access boundary. Switch workspaces from your list at any time.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Private by design. Built for focused teams.</span>
        </div>
      </aside>

      <section className="auth-main" aria-label="Workspace details">
        <div className="workspace-card organization-dashboard project-dashboard">
          <a className="secondary-link" href="/workspaces">All workspaces</a>
          {loading ? (
            <p className="workspace-loading" role="status">Loading this workspace...</p>
          ) : organization ? (
            <>
              <p className="eyebrow workspace-greeting">Nexora workspace</p>
              <div className="organization-title-row">
                <span className="organization-monogram organization-monogram-large" aria-hidden="true">
                  {organization.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <h2 id="organization-title">{organization.name}</h2>
                  <p className="organization-address">nexora / {organization.slug}</p>
                </div>
              </div>
              <div className="workspace-status-card">
                <span className="status-indicator" aria-hidden="true" />
                <div>
                  <strong>Workspace secured</strong>
                  <p>You are a {organization.role} in this organization.</p>
                </div>
              </div>
              {(organization.role === "owner" || organization.role === "admin") && (
                <a
                  className="primary-button button-link"
                  href={`/organizations/${encodeURIComponent(organization.id)}/members`}
                >
                  Manage team access
                </a>
              )}
              <div className="organization-quick-links">
                <a className="secondary-link" href={`/organizations/${encodeURIComponent(organization.id)}/search`}>
                  Search workspace
                </a>
                <a className="secondary-link organization-notifications-link" href={`/organizations/${encodeURIComponent(organization.id)}/notifications`}>
                  Notifications
                </a>
              </div>
              <OrganizationProjects
                organizationId={organization.id}
                canCreate={["owner", "admin", "member"].includes(organization.role)}
              />
            </>
          ) : (
            <p className="form-message form-error" role="alert">{error || "Workspace not found."}</p>
          )}
          {error && organization && <p className="form-message form-error" role="alert">{error}</p>}
        </div>
        <footer className="auth-footer">Nexora - A clearer way to move work forward</footer>
      </section>
    </main>
  );
}
