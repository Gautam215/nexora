"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  apiErrorMessage,
  formatSessionTime,
  passwordChangeSuccessMessage,
  validatePasswordChange,
} from "./account-settings-helpers.ts";

interface SessionUser {
  displayName: string;
  email: string;
}

interface ListedSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

interface ApiResult<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

const NETWORK_ERROR = "The service could not be reached. Try again in a moment.";

export default function AccountSettingsPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessions, setSessions] = useState<ListedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordFieldError, setPasswordFieldError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");

  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false);
  const [revokePending, setRevokePending] = useState(false);
  const [sessionsSuccess, setSessionsSuccess] = useState("");

  const loadSessions = useCallback(async () => {
    setSessionsError("");
    setSessionsSuccess("");
    try {
      const response = await fetch("/api/auth/sessions", { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        sessions: ListedSession[];
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setSessionsError(apiErrorMessage(result, "Active sessions could not be loaded."));
        return;
      }
      setSessions(result?.data?.sessions ?? []);
    } catch {
      setSessionsError(NETWORK_ERROR);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
        if (!sessionResponse.ok) {
          window.location.assign("/login");
          return;
        }
        const sessionResult = (await sessionResponse.json()) as ApiResult<{
          user: SessionUser;
        }>;
        if (cancelled) return;
        setUser(sessionResult.data?.user ?? null);
        await loadSessions();
      } catch {
        if (!cancelled) setSessionsError(NETWORK_ERROR);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError("");
    setPasswordSuccess("");
    setPasswordFieldError("");

    const validation = validatePasswordChange(currentPassword, newPassword, confirmPassword);
    if (!validation.valid) {
      setPasswordFieldError(
        validation.currentPasswordError || validation.newPasswordError || validation.confirmPasswordError,
      );
      return;
    }

    setPasswordPending(true);
    try {
      const response = await fetch("/api/auth/password-change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        passwordUpdated: boolean;
        otherSessionsRevoked: number;
      }> | null;
      if (response.status === 401 && result?.error?.code === "AUTHENTICATION_REQUIRED") {
        // The session itself is gone (or was revoked concurrently).
        // A wrong current password is a different 401
        // (INVALID_CREDENTIALS) and must stay on this page with its
        // message and the fields kept, so it falls through to the
        // error display below instead of signing the user out.
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setPasswordError(apiErrorMessage(result, "Your password could not be updated."));
        return;
      }
      // Sensitive fields are cleared on success, and never persisted.
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSuccess(
        passwordChangeSuccessMessage(result?.data?.otherSessionsRevoked ?? 0),
      );
      // A password change revokes other sessions server-side, so the
      // list shown here must be refreshed to match.
      await loadSessions();
    } catch {
      setPasswordError(NETWORK_ERROR);
    } finally {
      setPasswordPending(false);
    }
  }

  async function revokeSession(sessionId: string) {
    setRevokePending(true);
    setSessionsError("");
    setSessionsSuccess("");
    try {
      const response = await fetch("/api/auth/sessions/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        revoked: boolean;
        currentRevoked: boolean;
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setSessionsError(apiErrorMessage(result, "That session could not be signed out."));
        return;
      }
      setConfirmRevokeId(null);
      if (result?.data?.currentRevoked) {
        // The server cleared this session's cookie; the signed-in
        // screen can no longer be used, so go to sign-in.
        window.location.assign("/login");
        return;
      }
      // Refresh first: loadSessions clears the session success
      // message, so setting it before the refresh would erase it
      // before it ever renders.
      await loadSessions();
      setSessionsSuccess("That session is signed out.");
    } catch {
      setSessionsError(NETWORK_ERROR);
    } finally {
      setRevokePending(false);
    }
  }

  async function revokeOthers() {
    setRevokePending(true);
    setSessionsError("");
    setSessionsSuccess("");
    try {
      const response = await fetch("/api/auth/sessions/revoke-others", { method: "POST" });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        otherSessionsRevoked: number;
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        setSessionsError(apiErrorMessage(result, "Other sessions could not be signed out."));
        return;
      }
      setConfirmRevokeOthers(false);
      const count = result?.data?.otherSessionsRevoked ?? 0;
      // Refresh first, for the same reason as in revoke(): loadSessions
      // clears the session success message.
      await loadSessions();
      setSessionsSuccess(
        count === 0
          ? "No other sessions were signed in."
          : `${count} other session${count === 1 ? "" : "s"} signed out.`,
      );
    } catch {
      setSessionsError(NETWORK_ERROR);
    } finally {
      setRevokePending(false);
    }
  }

  const otherSessions = sessions.filter((session) => !session.current);
  const currentSession = sessions.find((session) => session.current);

  return (
    <main className="auth-layout">
      <aside className="auth-story">
        <a className="brand" href="/" aria-label="Nexora home">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>Nexora</span>
        </a>
        <div className="auth-story-copy">
          <p className="eyebrow">Account security</p>
          <h1>Keep your account in your hands.</h1>
          <p>Change your password and review the sessions signed in to this account. No device details are shown, because the account does not record them.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Private by design. Built for focused teams.</span>
        </div>
      </aside>

      <section className="auth-main" aria-labelledby="account-title">
        <div className="workspace-card account-card">
          <div className="workspace-topline">
            <span className="auth-kicker">Your Nexora</span>
            <a className="quiet-button" href="/workspaces">Back to workspaces</a>
          </div>
          <p className="eyebrow workspace-greeting">
            {user ? `Signed in as ${user.displayName}` : "Account security"}
          </p>
          <h2 id="account-title">Account security.</h2>
          {user && <p className="auth-copy">{user.email}</p>}

          {loading ? (
            <p className="workspace-loading" role="status">Loading your account security...</p>
          ) : (
            <>
              <section className="account-section" aria-labelledby="password-title">
                <h3 id="password-title">Change password</h3>
                <p className="account-section-copy">
                  Changing your password signs out every other session. This session stays signed in.
                </p>
                <form className="auth-form" onSubmit={changePassword}>
                  <label className="form-field">
                    <span>Current password</span>
                    <input
                      type="password"
                      autoComplete="current-password"
                      maxLength={128}
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      aria-describedby={passwordFieldError ? "password-field-error" : undefined}
                      required
                    />
                  </label>
                  <label className="form-field">
                    <span>New password</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={128}
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      aria-describedby={passwordFieldError ? "password-field-error" : undefined}
                      required
                    />
                    <small>12-128 characters. A memorable passphrase works well.</small>
                  </label>
                  <label className="form-field">
                    <span>Confirm new password</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={128}
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      aria-describedby={passwordFieldError ? "password-field-error" : undefined}
                      required
                    />
                  </label>
                  <button className="primary-button" type="submit" disabled={passwordPending}>
                    {passwordPending ? "Updating..." : "Update password"}
                  </button>
                </form>
                {passwordFieldError && (
                  <p className="form-message form-error" id="password-field-error" role="alert">
                    {passwordFieldError}
                  </p>
                )}
                {passwordError && (
                  <p className="form-message form-error" role="alert">{passwordError}</p>
                )}
                {passwordSuccess && (
                  <p className="form-message form-success" role="status" aria-live="polite">
                    {passwordSuccess}
                  </p>
                )}
              </section>

              <section className="account-section" aria-labelledby="sessions-title">
                <h3 id="sessions-title">Active sessions</h3>
                {sessionsError && (
                  <p className="form-message form-error" role="alert">
                    {sessionsError}{" "}
                    <button className="quiet-button" type="button" onClick={() => void loadSessions()}>
                      Try again
                    </button>
                  </p>
                )}
                {sessionsSuccess && (
                  <p className="form-message form-success" role="status" aria-live="polite">
                    {sessionsSuccess}
                  </p>
                )}
                {sessions.length === 0 && !sessionsError ? (
                  <div className="workspace-empty">
                    <h3>No active sessions found.</h3>
                    <p>Sign in again if you were signed out.</p>
                    <a className="primary-button button-link" href="/login">Sign in</a>
                  </div>
                ) : (
                  <ul className="session-list">
                    {sessions.map((session) => (
                      <li className="session-row" key={session.id}>
                        <div className="session-details">
                          <strong>
                            {session.current ? "This session" : "Other session"}
                          </strong>
                          {session.current && <span className="current-pill">Current</span>}
                          <dl className="session-meta">
                            <div>
                              <dt>Created</dt>
                              <dd>{formatSessionTime(session.createdAt)}</dd>
                            </div>
                            <div>
                              <dt>Last seen</dt>
                              <dd>{formatSessionTime(session.lastSeenAt)}</dd>
                            </div>
                            <div>
                              <dt>Expires</dt>
                              <dd>{formatSessionTime(session.expiresAt)}</dd>
                            </div>
                          </dl>
                        </div>
                        {confirmRevokeId === session.id ? (
                          <div className="confirm-panel" role="alertdialog" aria-label="Confirm sign out">
                            <p>
                              {session.current
                                ? "Sign out this session? You will need to sign in again."
                                : "Sign out this session? It will stop working immediately."}
                            </p>
                            <div className="confirm-actions">
                              <button
                                className="danger-button"
                                type="button"
                                onClick={() => void revokeSession(session.id)}
                                disabled={revokePending}
                              >
                                {revokePending ? "Signing out..." : "Sign out session"}
                              </button>
                              <button
                                className="quiet-button"
                                type="button"
                                onClick={() => setConfirmRevokeId(null)}
                                disabled={revokePending}
                              >
                                Keep session
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            className="quiet-button"
                            type="button"
                            onClick={() => setConfirmRevokeId(session.id)}
                          >
                            Sign out
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {otherSessions.length > 0 && (
                  <div className="revoke-others">
                    {confirmRevokeOthers ? (
                      <div className="confirm-panel" role="alertdialog" aria-label="Confirm sign out of other sessions">
                        <p>
                          Sign out all other sessions? This session stays signed in, and the
                          others stop working immediately.
                        </p>
                        <div className="confirm-actions">
                          <button
                            className="danger-button"
                            type="button"
                            onClick={() => void revokeOthers()}
                            disabled={revokePending}
                          >
                            {revokePending ? "Signing out..." : "Sign out other sessions"}
                          </button>
                          <button
                            className="quiet-button"
                            type="button"
                            onClick={() => setConfirmRevokeOthers(false)}
                            disabled={revokePending}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="quiet-button"
                        type="button"
                        onClick={() => setConfirmRevokeOthers(true)}
                      >
                        Sign out all other sessions
                      </button>
                    )}
                  </div>
                )}
                {currentSession === undefined && sessions.length > 0 && (
                  <p className="form-message form-error" role="alert">
                    Your current session is not in this list. Sign in again to continue securely.
                  </p>
                )}
              </section>
            </>
          )}
          <footer className="auth-footer">Nexora - A clearer way to move work forward</footer>
        </div>
      </section>
    </main>
  );
}
