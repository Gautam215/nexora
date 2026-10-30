"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  apiErrorMessage,
  formatSessionTime,
  passwordChangeSuccessMessage,
  validatePasswordChange,
} from "./account-settings-helpers.ts";
import { BrandLogo } from "./brand-logo";
import { CheckIcon, ChevronLeftIcon, DownloadIcon, KeyIcon, RefreshIcon, ShieldIcon, SignInIcon, SignOutIcon, TrashIcon, XIcon } from "./button-icons";

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
  // Focus management for the sign-out confirm panels:
  // opening a panel moves focus into it (autoFocus on its danger
  // button), and closing it returns focus to the row's trigger
  // button. The trigger button itself unmounts while its panel is
  // open, so the return target is found through the row element,
  // which survives the open/close swap.
  const sessionRowRefs = useRef(new Map<string, HTMLLIElement | null>());
  const focusReturnRowId = useRef<string | null>(null);
  const revokeOthersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusReturnOthers = useRef(false);
  useEffect(() => {
    if (confirmRevokeId === null && focusReturnRowId.current !== null) {
      const rowId = focusReturnRowId.current;
      focusReturnRowId.current = null;
      sessionRowRefs.current.get(rowId)?.querySelector("button")?.focus();
    }
    if (!confirmRevokeOthers && focusReturnOthers.current) {
      focusReturnOthers.current = false;
      revokeOthersTriggerRef.current?.focus();
    }
  }, [confirmRevokeId, confirmRevokeOthers]);
  const [revokePending, setRevokePending] = useState(false);
  const [sessionsSuccess, setSessionsSuccess] = useState("");

  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportSuccess, setExportSuccess] = useState("");
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteTotpCode, setDeleteTotpCode] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [totpEnrolled, setTotpEnrolled] = useState(false);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string; qrSvg?: string } | null>(null);
  const [totpAppChoice, setTotpAppChoice] = useState<"google" | "microsoft" | null>(null);
  const [totpShowManual, setTotpShowManual] = useState(false);
  const [totpShowDisable, setTotpShowDisable] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [totpDisablePassword, setTotpDisablePassword] = useState("");
  const [totpPending, setTotpPending] = useState(false);
  const [totpError, setTotpError] = useState("");
  const [totpSuccess, setTotpSuccess] = useState("");

  const loadTotpStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/account/totp/status", { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        enrolled: boolean;
      }> | null;
      if (response.ok) setTotpEnrolled(result?.data?.enrolled ?? false);
    } catch {
      // Status is a progressive enhancement: deletion still enforces
      // the code server-side when enrolled, even if this read fails.
    }
  }, []);

  useEffect(() => {
    void loadTotpStatus();
  }, [loadTotpStatus]);

  async function startTotpSetup(app: "google" | "microsoft") {
    if (totpPending) return;
    setTotpAppChoice(app);
    setTotpShowManual(false);
    setTotpPending(true);
    setTotpError("");
    setTotpSuccess("");
    try {
      const response = await fetch("/api/account/totp/setup", { method: "POST" });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        setup: { secret: string; otpauthUrl: string; qrSvg?: string };
      }> | null;
      // Only a missing session signs the user out: a factor 401
      // (wrong current code on re-enrollment) is a form error,
      // exactly like the verify and disable handlers below.
      if (response.status === 401 && result?.error?.code === "AUTHENTICATION_REQUIRED") {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.setup) {
        setTotpError(apiErrorMessage(result, "Authenticator setup could not be started."));
        return;
      }
      setTotpSetup(result.data.setup);
    } catch {
      setTotpError(NETWORK_ERROR);
    } finally {
      setTotpPending(false);
    }
  }

  async function verifyTotpSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (totpPending) return;
    setTotpPending(true);
    setTotpError("");
    setTotpSuccess("");
    try {
      const response = await fetch("/api/account/totp/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: totpCode }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        enabled: boolean;
      }> | null;
      if (response.status === 401 && result?.error?.code === "AUTHENTICATION_REQUIRED") {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.enabled) {
        setTotpError(apiErrorMessage(result, "Authenticator code could not be verified."));
        return;
      }
      setTotpEnrolled(true);
      setTotpSetup(null);
      setTotpAppChoice(null);
      setTotpShowManual(false);
      setTotpCode("");
      setTotpSuccess("Authenticator enabled. Deleting your account or a workspace now also requires a code.");
    } catch {
      setTotpError(NETWORK_ERROR);
    } finally {
      setTotpPending(false);
    }
  }

  async function disableTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (totpPending) return;
    setTotpPending(true);
    setTotpError("");
    setTotpSuccess("");
    try {
      const response = await fetch("/api/account/totp/disable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: totpDisablePassword, code: totpCode }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        disabled: boolean;
      }> | null;
      if (response.status === 401 && result?.error?.code === "AUTHENTICATION_REQUIRED") {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.disabled) {
        setTotpError(apiErrorMessage(result, "Authenticator could not be disabled."));
        return;
      }
      setTotpEnrolled(false);
      setTotpShowDisable(false);
      setTotpCode("");
      setTotpDisablePassword("");
      setTotpSuccess("Authenticator disabled.");
    } catch {
      setTotpError(NETWORK_ERROR);
    } finally {
      setTotpPending(false);
    }
  }

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

  async function exportData() {
    if (exportPending) return;
    setExportPending(true);
    setExportError("");
    setExportSuccess("");
    try {
      const response = await fetch("/api/account/export", { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        export: unknown;
        exportedAt: string;
      }> | null;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.export) {
        setExportError(apiErrorMessage(result, "Your data could not be exported."));
        return;
      }
      const blob = new Blob([JSON.stringify(result.data.export, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `nexora-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setExportSuccess("Your data export has been downloaded.");
    } catch {
      setExportError(NETWORK_ERROR);
    } finally {
      setExportPending(false);
    }
  }

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deletePending) return;
    setDeletePending(true);
    setDeleteError("");
    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmation: deleteConfirmation,
          password: deletePassword,
          ...(deleteTotpCode ? { totpCode: deleteTotpCode } : {}),
        }),
      });
      const result = (await response.json().catch(() => null)) as ApiResult<{
        deleted: boolean;
      }> | null;
      // Only a session 401 redirects: a wrong or missing
      // authenticator code is also a 401, but it must surface as
      // a form error, not a sign-out.
      if (response.status === 401 && result?.error?.code === "AUTHENTICATION_REQUIRED") {
        window.location.assign("/login");
        return;
      }
      if (!response.ok || !result?.data?.deleted) {
        setDeleteError(apiErrorMessage(result, "Your account could not be deleted."));
        return;
      }
      // The server deleted every session and cleared the cookie, so
      // the signed-in screen can no longer be used.
      window.location.assign("/login");
    } catch {
      setDeleteError(NETWORK_ERROR);
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <main className="auth-layout">
      <aside className="auth-story">
        <BrandLogo href="/workspaces" />
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
            <a className="quiet-button" href="/workspaces"><ChevronLeftIcon />Back to workspaces</a>
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
                  <button className="primary-button" type="submit" disabled={passwordPending}><KeyIcon />
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
                    <button className="quiet-button" type="button" onClick={() => void loadSessions()}><RefreshIcon />
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
                    <a className="primary-button button-link" href="/login"><SignInIcon />Sign in</a>
                  </div>
                ) : (
                  <ul className="session-list">
                    {sessions.map((session) => (
                      <li
                        className="session-row"
                        key={session.id}
                        ref={(element) => {
                          sessionRowRefs.current.set(session.id, element);
                        }}
                      >
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
                                autoFocus
                                onClick={() => void revokeSession(session.id)}
                                disabled={revokePending}
                              ><SignOutIcon />
                                {revokePending ? "Signing out..." : "Sign out session"}
                              </button>
                              <button
                                className="quiet-button"
                                type="button"
                                onClick={() => {
                                  focusReturnRowId.current = session.id;
                                  setConfirmRevokeId(null);
                                }}
                                disabled={revokePending}
                              ><XIcon />
                                Keep session
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            className="quiet-button"
                            type="button"
                            onClick={() => setConfirmRevokeId(session.id)}
                          ><SignOutIcon />
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
                            autoFocus
                            onClick={() => void revokeOthers()}
                            disabled={revokePending}
                          ><SignOutIcon />
                            {revokePending ? "Signing out..." : "Sign out other sessions"}
                          </button>
                          <button
                            className="quiet-button"
                            type="button"
                            onClick={() => {
                              focusReturnOthers.current = true;
                              setConfirmRevokeOthers(false);
                            }}
                            disabled={revokePending}
                          ><XIcon />
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="quiet-button"
                        type="button"
                        ref={revokeOthersTriggerRef}
                        onClick={() => setConfirmRevokeOthers(true)}
                      ><SignOutIcon />
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
              <section className="account-section" aria-labelledby="totp-title">
                <h3 id="totp-title">Two-factor authentication</h3>
                <p className="account-section-copy">
                  When enabled, deleting your account or a workspace requires your password
                  plus a 6-digit code from an authenticator app (Google or Microsoft
                  Authenticator), so a stolen session alone cannot destroy anything.
                </p>
                {totpError && (
                  <p className="form-message form-error" role="alert">{totpError}</p>
                )}
                {totpSuccess && (
                  <p className="form-message form-success" role="status" aria-live="polite">{totpSuccess}</p>
                )}
                {totpEnrolled ? (
                  <div>
                    <p>Authenticator is enabled.</p>
                    {!totpShowDisable ? (
                      <div className="confirm-actions">
                        <button className="quiet-button" type="button" onClick={() => setTotpShowDisable(true)} disabled={totpPending}><ShieldIcon />
                          Disable authenticator
                        </button>
                      </div>
                    ) : (
                      <form className="confirm-panel" onSubmit={disableTotp}>
                        <label className="form-field">
                          <span>Current password</span>
                          <input
                            type="password"
                            value={totpDisablePassword}
                            onChange={(event) => setTotpDisablePassword(event.target.value)}
                            autoComplete="current-password"
                            required
                          />
                        </label>
                        <label className="form-field">
                          <span>Authenticator code</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={totpCode}
                            onChange={(event) => setTotpCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                            autoComplete="one-time-code"
                            required
                          />
                        </label>
                        <div className="confirm-actions">
                          <button className="danger-button" type="submit" disabled={totpPending}><ShieldIcon />
                            {totpPending ? "Disabling..." : "Disable authenticator"}
                          </button>
                          <button className="quiet-button" type="button" onClick={() => setTotpShowDisable(false)} disabled={totpPending}><XIcon />
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                ) : totpSetup ? (
                  <form className="confirm-panel" onSubmit={verifyTotpSetup}>
                    {totpSetup.qrSvg && !totpShowManual ? (
                      <>
                        <p>
                          Scan this QR code with {totpAppChoice === "microsoft" ? "Microsoft" : "Google"} Authenticator,
                          then enter the 6-digit code it shows. The code changes every 30 seconds.
                        </p>
                        <img
                          className="totp-qr"
                          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(totpSetup.qrSvg)}`}
                          alt="Authenticator setup QR code"
                        />
                        <div className="confirm-actions">
                          <button className="quiet-button" type="button" onClick={() => setTotpShowManual(true)} disabled={totpPending}><KeyIcon />
                            Use a setup code instead
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p>
                          Add this key to your authenticator app (manual entry), then enter the
                          6-digit code it shows. The key is shown once.
                        </p>
                        <p>
                          <span>Setup key: </span>
                          <code>{totpSetup.secret}</code>
                        </p>
                        <p>
                          <span>App URL: </span>
                          <code>{totpSetup.otpauthUrl}</code>
                        </p>
                        {totpSetup.qrSvg && (
                          <div className="confirm-actions">
                            <button className="quiet-button" type="button" onClick={() => setTotpShowManual(false)} disabled={totpPending}><ChevronLeftIcon />
                              Back to QR code
                            </button>
                          </div>
                        )}
                      </>
                    )}
                    <label className="form-field">
                      <span>Authenticator code</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={totpCode}
                        onChange={(event) => setTotpCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                        autoComplete="one-time-code"
                        autoFocus
                        required
                      />
                    </label>
                    <div className="confirm-actions">
                      <button className="primary-button" type="submit" disabled={totpPending}><CheckIcon />
                        {totpPending ? "Verifying..." : "Verify and enable"}
                      </button>
                      <button className="quiet-button" type="button" onClick={() => { setTotpSetup(null); setTotpAppChoice(null); setTotpShowManual(false); }} disabled={totpPending}><XIcon />
                        Cancel setup
                      </button>
                    </div>
                  </form>
                ) : (
                  <div>
                    <p>Which authenticator app will you use?</p>
                    <div className="confirm-actions">
                      <button className="quiet-button" type="button" onClick={() => void startTotpSetup("google")} disabled={totpPending}><ShieldIcon />
                        {totpPending ? "Starting setup..." : "Google Authenticator"}
                      </button>
                      <button className="quiet-button" type="button" onClick={() => void startTotpSetup("microsoft")} disabled={totpPending}><ShieldIcon />
                        {totpPending ? "Starting setup..." : "Microsoft Authenticator"}
                      </button>
                    </div>
                  </div>
                )}
              </section>
              <section className="account-section" aria-labelledby="data-title">
                <h3 id="data-title">Your data</h3>
                <p className="account-section-copy">
                  Download everything this account owns across workspaces: profile,
                  workspace memberships, projects, tasks, comments, file metadata, and
                  AI execution metadata. File contents and AI prompts are not included.
                </p>
                {exportError && (
                  <p className="form-message form-error" role="alert">{exportError}</p>
                )}
                {exportSuccess && (
                  <p className="form-message form-success" role="status" aria-live="polite">{exportSuccess}</p>
                )}
                <button className="quiet-button" type="button" onClick={() => void exportData()} disabled={exportPending}><DownloadIcon />
                  {exportPending ? "Preparing export..." : "Download my data"}
                </button>
                <p className="account-section-copy">
                  Deleting your account is permanent. Your profile is scrubbed, every
                  workspace membership is disabled, and every session is signed out.
                  Work you created stays attributed to a deleted account. If you are
                  the sole owner of a workspace, delete that workspace first.
                </p>
                {deleteError && (
                  <p className="form-message form-error" role="alert">{deleteError}</p>
                )}
                {confirmDeleteAccount ? (
                  <form className="confirm-panel" onSubmit={deleteAccount}>
                    <p>
                      To delete this account, type your email address ({user?.email}) and your current password below.
                    </p>
                    <label className="form-field">
                      <span>Confirm email address</span>
                      <input
                        type="email"
                        value={deleteConfirmation}
                        onChange={(event) => setDeleteConfirmation(event.target.value)}
                        autoComplete="off"
                        autoFocus
                        required
                      />
                    </label>
                    <label className="form-field">
                      <span>Current password</span>
                      <input
                        type="password"
                        value={deletePassword}
                        onChange={(event) => setDeletePassword(event.target.value)}
                        autoComplete="current-password"
                        required
                      />
                    </label>
                    {totpEnrolled && (
                      <label className="form-field">
                        <span>Authenticator code</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={deleteTotpCode}
                          onChange={(event) => setDeleteTotpCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                          autoComplete="one-time-code"
                          required
                        />
                      </label>
                    )}
                    <div className="confirm-actions">
                      <button className="danger-button" type="submit" disabled={deletePending}><TrashIcon />
                        {deletePending ? "Deleting..." : "Delete my account"}
                      </button>
                      <button className="quiet-button" type="button" onClick={() => setConfirmDeleteAccount(false)} disabled={deletePending}><XIcon />
                        Keep my account
                      </button>
                    </div>
                  </form>
                ) : (
                  <button className="danger-button" type="button" onClick={() => setConfirmDeleteAccount(true)}><TrashIcon />
                    Delete my account
                  </button>
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
