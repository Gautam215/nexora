"use client";

import { useEffect, useState } from "react";
import AiPlanningPanel from "./ai-planning-panel";
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
  const [settingsName, setSettingsName] = useState("");
  const [settingsSlug, setSettingsSlug] = useState("");
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteSlug, setDeleteSlug] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");

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
        if (!cancelled) {
          const loaded = result.data?.organization ?? null;
          setOrganization(loaded);
          if (loaded) {
            setSettingsName(loaded.name);
            setSettingsSlug(loaded.slug);
          }
        }
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
              {(organization.role === "owner" || organization.role === "admin") && (
                <form
                  className="auth-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (settingsPending) return;
                    setSettingsPending(true);
                    setSettingsError("");
                    setSettingsSaved(false);
                    try {
                      const response = await fetch(
                        `/api/organizations/${encodeURIComponent(organization.id)}`,
                        {
                          method: "PATCH",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ name: settingsName, slug: settingsSlug }),
                        },
                      );
                      const result = (await response.json()) as ApiResult & {
                        data?: { organization?: Organization };
                      };
                      if (response.status === 401) {
                        window.location.assign("/login");
                        return;
                      }
                      if (!response.ok || !result.data?.organization) {
                        setSettingsError(
                          result.error?.message ?? "Workspace settings could not be saved.",
                        );
                        return;
                      }
                      setOrganization({
                        ...organization,
                        name: result.data.organization.name,
                        slug: result.data.organization.slug,
                      });
                      setSettingsSaved(true);
                    } catch {
                      setSettingsError("The service could not be reached. Try again in a moment.");
                    } finally {
                      setSettingsPending(false);
                    }
                  }}
                >
                  <h3>Workspace settings</h3>
                  <label className="form-field">
                    <span>Name</span>
                    <input
                      value={settingsName}
                      onChange={(event) => setSettingsName(event.target.value)}
                      minLength={1}
                      maxLength={120}
                      required
                    />
                  </label>
                  <label className="form-field">
                    <span>Address</span>
                    <input
                      value={settingsSlug}
                      onChange={(event) => setSettingsSlug(event.target.value.toLowerCase())}
                      minLength={2}
                      maxLength={63}
                      pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                      required
                    />
                    <small>Shown as nexora / {settingsSlug || organization.slug}</small>
                  </label>
                  {settingsError && (
                    <p className="form-message form-error" role="alert">{settingsError}</p>
                  )}
                  {settingsSaved && (
                    <p className="form-message form-success" role="status">
                      Workspace settings saved.
                    </p>
                  )}
                  <div className="auth-actions">
                    <button className="primary-button" type="submit" disabled={settingsPending}>
                      {settingsPending ? "Saving..." : "Save settings"}
                    </button>
                  </div>
                </form>
              )}
              <AiPlanningPanel organizationId={organizationId} />
              {organization.role === "owner" && (
                <section className="project-detail-section" aria-labelledby="organization-delete-title">
                  <div className="project-section-heading">
                    <div>
                      <p className="eyebrow">Danger zone</p>
                      <h3 id="organization-delete-title">Delete workspace</h3>
                    </div>
                  </div>
                  <p className="project-section-copy">
                    Deleting hides this workspace immediately for everyone. Its projects, tasks,
                    comments, files, invitations, and notifications are permanently removed after
                    30 days. The workspace record and its audit trail are kept.
                  </p>
                  {confirmDelete ? (
                    <div className="confirm-panel" role="alertdialog" aria-label="Confirm workspace deletion">
                      <p>
                        Delete “{organization.name}”? This hides the workspace immediately and
                        permanently removes its projects, tasks, comments, files, invitations, and
                        notifications after 30 days. The workspace record and its audit trail are
                        kept.
                      </p>
                      <label className="form-field">
                        <span>Type the workspace address to confirm</span>
                        <input
                          value={deleteSlug}
                          onChange={(event) => setDeleteSlug(event.target.value.toLowerCase())}
                          placeholder={organization.slug}
                          autoComplete="off"
                        />
                      </label>
                      <label className="form-field">
                        <span>Your current password</span>
                        <input
                          type="password"
                          value={deletePassword}
                          onChange={(event) => setDeletePassword(event.target.value)}
                          autoComplete="current-password"
                        />
                      </label>
                      {deleteError && (
                        <p className="form-message form-error" role="alert">{deleteError}</p>
                      )}
                      <div className="confirm-actions">
                        <button
                          className="danger-button"
                          type="button"
                          disabled={deletePending || deleteSlug !== organization.slug || !deletePassword}
                          onClick={async () => {
                            if (deletePending) return;
                            setDeletePending(true);
                            setDeleteError("");
                            try {
                              const response = await fetch(
                                `/api/organizations/${encodeURIComponent(organization.id)}`,
                                {
                                  method: "DELETE",
                                  headers: { "content-type": "application/json" },
                                  body: JSON.stringify({ slug: deleteSlug, password: deletePassword }),
                                },
                              );
                              const result = (await response.json()) as ApiResult;
                              if (response.status === 401) {
                                window.location.assign("/login");
                                return;
                              }
                              if (!response.ok) {
                                setDeleteError(
                                  result.error?.message ?? "Workspace could not be deleted.",
                                );
                                return;
                              }
                              window.location.assign("/workspaces");
                            } catch {
                              setDeleteError("The service could not be reached. Try again in a moment.");
                            } finally {
                              setDeletePending(false);
                            }
                          }}
                        >
                          {deletePending ? "Deleting..." : "Delete this workspace"}
                        </button>
                        <button
                          type="button"
                          disabled={deletePending}
                          onClick={() => {
                            setConfirmDelete(false);
                            setDeleteSlug("");
                            setDeleteError("");
                          }}
                        >
                          Keep workspace
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete workspace
                    </button>
                  )}
                </section>
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
