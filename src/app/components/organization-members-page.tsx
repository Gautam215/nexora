"use client";

import { useEffect, useState, type FormEvent } from "react";

interface Member {
  user_id: string;
  email?: string;
  display_name: string;
  role: string;
  status: string;
  joined_at: string | null;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
}

interface TeamData {
  members: Member[];
  invitations: Invitation[];
  viewerRole: string;
  viewerUserId: string;
}

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

export default function OrganizationMembersPage({
  organizationId,
}: {
  organizationId: string;
}) {
  const [team, setTeam] = useState<TeamData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [inviteRole, setInviteRole] = useState("member");

  async function fetchTeam(): Promise<TeamData> {
    const response = await fetch(
      `/api/organizations/${encodeURIComponent(organizationId)}/members`,
      { cache: "no-store" },
    );
    const result = (await response.json()) as ApiResult<TeamData>;
    if (response.status === 401) {
      window.location.assign("/login");
      throw new Error("Sign in to continue.");
    }
    if (!response.ok || !result.data) {
      throw new Error(result.error?.message ?? "Team access could not be loaded.");
    }
    return result.data;
  }

  useEffect(() => {
    let cancelled = false;
    void fetchTeam()
      .then((result) => {
        if (!cancelled) setTeam(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Team access could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  async function refreshTeam() {
    try {
      setTeam(await fetchTeam());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Team access could not be loaded.");
    }
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email") ?? "");
    setPending("invite");
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/members`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, role: inviteRole }),
        },
      );
      const result = (await response.json().catch(() => null)) as
        | (ApiResult<{ invitation: Invitation; emailAccepted: boolean }>)
        | null;
      if (!response.ok) {
        setError(result?.error?.message ?? "Invitation could not be created.");
        return;
      }
      form.reset();
      setInviteRole("member");
      setMessage(
        result?.data?.emailAccepted
          ? "Invitation created; the mail service accepted the message."
          : "Invitation saved, but email could not be sent. Check SMTP settings, then revoke and re-invite.",
      );
      await refreshTeam();
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending("");
    }
  }

  async function updateMember(userId: string, changes: { role?: string; status?: string }) {
    setPending(userId);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(changes),
        },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (!response.ok) {
        setError(result?.error?.message ?? "Membership could not be updated.");
        return;
      }
      setMessage("Workspace membership updated.");
      await refreshTeam();
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending("");
    }
  }

  async function revokeInvite(invitationId: string) {
    setPending(invitationId);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`,
        { method: "DELETE" },
      );
      const result = (await response.json().catch(() => null)) as ApiResult<unknown> | null;
      if (!response.ok) {
        setError(result?.error?.message ?? "Invitation could not be revoked.");
        return;
      }
      setMessage("Invitation revoked.");
      await refreshTeam();
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending("");
    }
  }

  const canManage = team?.viewerRole === "owner" || team?.viewerRole === "admin";

  return (
    <main className="auth-layout workspace-layout">
      <aside className="auth-story">
        <a className="brand" href="/" aria-label="Nexora home">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>Nexora</span>
        </a>
        <div className="auth-story-copy">
          <p className="eyebrow">People and permissions</p>
          <h1>Give access with intention.</h1>
          <p>Invitations are single-use, expire after seven days, and can only be accepted by the verified email address they were sent to.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Private by design. Built for focused teams.</span>
        </div>
      </aside>

      <section className="auth-main" aria-label="Workspace team access">
        <div className="workspace-card team-card">
          <a className="secondary-link" href={`/organizations/${encodeURIComponent(organizationId)}`}>
            Back to workspace
          </a>
          <p className="eyebrow workspace-greeting">Team access</p>
          <h2>People in this workspace.</h2>
          <p className="auth-copy">Owners and admins can invite people, adjust access, and disable membership.</p>

          {loading ? (
          <p className="workspace-loading" role="status">Loading people and invitations...</p>
          ) : error && !team ? (
            <p className="form-message form-error" role="alert">{error}</p>
          ) : team ? (
            <>
              {canManage && (
                <form className="invite-form" onSubmit={inviteMember}>
                  <label className="form-field">
                    <span>Invite by email</span>
                    <input name="email" type="email" autoComplete="email" maxLength={320} required disabled={Boolean(pending)} />
                  </label>
                  <label className="form-field">
                    <span>Workspace role</span>
                    <select value={inviteRole} disabled={Boolean(pending)} onChange={(event) => setInviteRole(event.target.value)}>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="guest">Guest</option>
                    </select>
                  </label>
                  <button className="primary-button" type="submit" disabled={Boolean(pending)}>
                    {pending === "invite" ? "Sending..." : "Send invitation"}
                  </button>
                </form>
              )}

              <div className="team-section">
                <h3>Members <span>{team.members.length}</span></h3>
                <div className="team-list">
                  {team.members.map((member) => {
                    const protectedMember = member.role === "owner" || member.user_id === team.viewerUserId;
                    const busy = pending === member.user_id;
                    return (
                      <article className="team-row" key={member.user_id}>
                        <div className="member-avatar" aria-hidden="true">
                          {member.display_name.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="member-identity">
                          <strong>{member.display_name}</strong>
                          {member.email && <span>{member.email}</span>}
                        </div>
                        {canManage && !protectedMember ? (
                          <div className="member-controls">
                            <select
                              aria-label={`Role for ${member.display_name}`}
                              value={member.role}
                              disabled={busy || Boolean(pending)}
                              onChange={(event) => void updateMember(member.user_id, { role: event.target.value })}
                            >
                              <option value="admin">Admin</option>
                              <option value="member">Member</option>
                              <option value="guest">Guest</option>
                            </select>
                            <button
                              className="quiet-button"
                              type="button"
                              disabled={busy || Boolean(pending)}
                              onClick={() => void updateMember(member.user_id, {
                                status: member.status === "active" ? "disabled" : "active",
                              })}
                            >
                              {member.status === "active" ? "Disable" : "Restore"}
                            </button>
                          </div>
                        ) : (
                          <span className={`role-pill status-${member.status}`}>{member.status === "active" ? member.role : member.status}</span>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>

              {canManage && (
                <div className="team-section">
                  <h3>Pending invitations <span>{team.invitations.length}</span></h3>
                  {team.invitations.length ? (
                    <div className="team-list">
                      {team.invitations.map((invitation) => {
                        const expired = new Date(invitation.expires_at).getTime() <= Date.now();
                        return (
                          <article className="invite-row" key={invitation.id}>
                            <div className="member-identity">
                              <strong>{invitation.email}</strong>
                    <span>{invitation.role} - {expired ? "Expired" : `Expires ${formatDate(invitation.expires_at)}`}</span>
                            </div>
                            <button
                              className="quiet-button"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={() => void revokeInvite(invitation.id)}
                            >
                              Revoke
                            </button>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="workspace-note">No pending invitations.</p>
                  )}
                </div>
              )}
              {!canManage && <p className="workspace-note">Your role is {team.viewerRole}; only owners and admins can change workspace access.</p>}
            </>
          ) : null}

          {error && team && <p className="form-message form-error" role="alert">{error}</p>}
          {message && <p className="form-message form-success" role="status" aria-live="polite">{message}</p>}
        </div>
        <footer className="auth-footer">Nexora - A clearer way to move work forward</footer>
      </section>
    </main>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
