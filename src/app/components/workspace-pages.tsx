"use client";

import { useEffect, useState, type FormEvent } from "react";

interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  created_at: string;
}

interface WorkspacePageProps {
  mode: "list" | "create";
}

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

export default function WorkspacePage({ mode }: WorkspacePageProps) {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [invitationAccepted, setInvitationAccepted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (new URLSearchParams(window.location.search).get("invitation") === "accepted") {
      setInvitationAccepted(true);
      window.history.replaceState(null, "", "/workspaces");
    }
    async function load() {
      try {
        const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
        if (!sessionResponse.ok) {
          window.location.assign("/login");
          return;
        }
        const session = (await sessionResponse.json()) as ApiResult<{
          user: { displayName: string };
        }>;
        if (cancelled) return;
        setDisplayName(session.data?.user.displayName ?? "");

        if (mode === "list") {
          const organizationResponse = await fetch("/api/organizations", { cache: "no-store" });
          const result = (await organizationResponse.json()) as ApiResult<{
            organizations: Organization[];
          }>;
          if (!organizationResponse.ok) {
            setError(result.error?.message ?? "Workspaces could not be loaded.");
          } else if (!cancelled) {
            setOrganizations(result.data?.organizations ?? []);
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
  }, [mode]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, slug }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (!response.ok) {
        setError(result?.error?.message ?? "Workspace could not be created.");
        return;
      }
      window.location.assign("/workspaces");
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        setError("You could not be signed out right now. Try again.");
        return;
      }
      window.location.assign("/login");
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  function changeName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  }

  return (
    <main className="auth-layout workspace-layout">
      <aside className="auth-story">
        <a className="brand" href="/" aria-label="Nexora home">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>Nexora</span>
        </a>
        <div className="auth-story-copy">
          <p className="eyebrow">A good place to start</p>
          <h1>Bring your team into focus.</h1>
          <p>Workspaces keep people, projects, and decisions in the right place. You are always in control of who belongs.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Private by design. Built for focused teams.</span>
        </div>
      </aside>

      <section className="auth-main" aria-labelledby="workspace-title">
        <div className="workspace-card">
          <div className="workspace-topline">
            <span className="auth-kicker">Your Nexora</span>
            <button className="quiet-button" type="button" onClick={signOut} disabled={pending}>
              Sign out
            </button>
          </div>
          <p className="eyebrow workspace-greeting">{displayName ? `Welcome, ${displayName}` : "Workspace setup"}</p>
          <h2 id="workspace-title">{mode === "create" ? "Create a workspace." : "Your workspaces."}</h2>
          <p className="auth-copy">
            {mode === "create"
              ? "Start with a clear name and a short address for your team."
              : "Organizations are isolated from one another, with access managed by membership."}
          </p>

          {loading ? (
            <p className="workspace-loading" role="status">Loading your secure workspace...</p>
          ) : mode === "create" ? (
            <form className="auth-form workspace-form" onSubmit={createWorkspace}>
              <label className="form-field">
                <span>Workspace name</span>
                <input
                  name="name"
                  type="text"
                  autoComplete="organization"
                  maxLength={120}
                  value={name}
                  onChange={(event) => changeName(event.target.value)}
                  required
                />
              </label>
              <label className="form-field">
                <span>Workspace address</span>
                <div className="slug-input">
                  <span aria-hidden="true">nexora /</span>
                  <input
                    name="slug"
                    type="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    maxLength={63}
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    value={slug}
                    onChange={(event) => {
                      setSlugEdited(true);
                      setSlug(event.target.value.toLowerCase());
                    }}
                    required
                  />
                </div>
                <small>Lowercase letters, numbers, and single hyphens.</small>
              </label>
              <button className="primary-button" type="submit" disabled={pending}>
                {pending ? "Creating..." : "Create workspace"}
              </button>
              <a className="secondary-link" href="/workspaces">Back to workspaces</a>
            </form>
          ) : (
            <div className="workspace-list">
              {invitationAccepted && (
                <p className="form-message form-success" role="status">Invitation accepted. Your new workspace is ready.</p>
              )}
              {organizations.length > 0 ? (
                organizations.map((organization) => (
                  <a
                    className="organization-card organization-card-link"
                    href={`/organizations/${encodeURIComponent(organization.id)}`}
                    key={organization.id}
                  >
                    <span className="organization-monogram" aria-hidden="true">
                      {organization.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="organization-details">
                      <h3>{organization.name}</h3>
                      <p>nexora / {organization.slug}</p>
                    </div>
                    <span className="role-pill">{organization.role}</span>
                  </a>
                ))
              ) : (
                <div className="workspace-empty">
                  <span className="empty-mark" aria-hidden="true">+</span>
                  <h3>Your team's next step starts here.</h3>
                  <p>Create a workspace to establish its secure membership boundary.</p>
                </div>
              )}
              <a className="primary-button button-link" href="/onboarding">Create a workspace</a>
              <p className="workspace-note">Open a workspace to view its projects and team access.</p>
            </div>
          )}

          {error && <p className="form-message form-error" role="alert">{error}</p>}
        </div>
        <footer className="auth-footer">Nexora - A clearer way to move work forward</footer>
      </section>
    </main>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}
