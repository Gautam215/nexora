"use client";

import { useEffect, useRef, useState } from "react";

const INVITATION_TOKEN_KEY = "nexora.pending-invitation";
const LOGIN_URL = "/login?next=%2Faccept-invitation";

interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

export default function AcceptInvitationPage() {
  const started = useRef(false);
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let cancelled = false;

    async function acceptInvitation() {
      let token: string | null = null;
      try {
        const suppliedToken = new URLSearchParams(window.location.search).get("token");
        if (suppliedToken) {
          window.sessionStorage.setItem(INVITATION_TOKEN_KEY, suppliedToken);
          token = suppliedToken;
          window.history.replaceState(null, "", "/accept-invitation");
        } else {
          token = window.sessionStorage.getItem(INVITATION_TOKEN_KEY);
        }
      } catch {
        setError("This browser could not keep the invitation link in this tab. Allow site storage, then reopen the original email link.");
        setLoading(false);
        return;
      }

      if (!token) {
        setError("This invitation link is missing its token. Open the original link from your invitation email.");
        setLoading(false);
        return;
      }
      if (!cancelled) setHasToken(true);

      try {
        const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
        if (sessionResponse.status === 401) {
          if (!cancelled) setNeedsLogin(true);
          return;
        }
        if (!sessionResponse.ok) {
          throw new Error("Your sign-in could not be checked. Try again in a moment.");
        }
        if (!cancelled) setSignedIn(true);

        const response = await fetch("/api/invitations/accept", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const result = (await response.json().catch(() => null)) as
          | ApiResult<{ accepted: boolean }>
          | null;
        if (!response.ok) {
          throw new Error(result?.error?.message ?? "This invitation could not be accepted.");
        }
        window.sessionStorage.removeItem(INVITATION_TOKEN_KEY);
        if (!cancelled) setAccepted(true);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "The service could not be reached. Try again.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void acceptInvitation();
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOutAndSwitchAccount() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not sign out. Try again.");
      window.location.assign(LOGIN_URL);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign out. Try again.");
      setPending(false);
    }
  }

  return (
    <main className="auth-layout">
      <aside className="auth-story">
        <a className="brand" href="/" aria-label="Nexora home">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>Nexora</span>
        </a>
        <div className="auth-story-copy">
          <p className="eyebrow">A place on the team</p>
          <h1>Good work moves together.</h1>
          <p>Join the workspace you were invited to, with access tied to your verified email address.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Private by design. Built for focused teams.</span>
        </div>
      </aside>

      <section className="auth-main" aria-labelledby="invitation-title">
        <div className="auth-card invitation-card">
          <span className="auth-kicker">Workspace invitation</span>
          <h2 id="invitation-title">
            {accepted ? "You are on the team." : needsLogin ? "Sign in to continue." : "Accept your invitation."}
          </h2>
          <p className="auth-copy">
            {accepted
              ? "Your verified account is now a member of this workspace."
              : "Use the verified email address this invitation was sent to. Invitations can only be accepted once and expire after seven days."}
          </p>

          {loading ? (
            <p className="workspace-loading" role="status">Checking your invitation...</p>
          ) : accepted ? (
            <a className="primary-button button-link invitation-action" href="/workspaces?invitation=accepted">
              Go to your workspaces
            </a>
          ) : needsLogin ? (
            <div className="invitation-actions">
              <a className="primary-button button-link" href={LOGIN_URL}>Sign in with the invited email</a>
              <p className="workspace-note">New to Nexora? Create and verify an account with that same email, then sign in to accept the invitation.</p>
              <a className="secondary-link" href="/register?next=%2Faccept-invitation">Create an account</a>
            </div>
          ) : error ? (
            <div className="invitation-actions">
              <p className="form-message form-error" role="alert">{error}</p>
              {signedIn && (
                <button className="quiet-button invitation-switch" type="button" onClick={signOutAndSwitchAccount} disabled={pending}>
                  {pending ? "Signing out..." : "Sign out and choose the invited email"}
                </button>
              )}
              {hasToken && !signedIn && <a className="primary-button button-link" href={LOGIN_URL}>Sign in and try again</a>}
              <a className="secondary-link" href="/workspaces">Back to workspaces</a>
            </div>
          ) : null}
        </div>
        <footer className="auth-footer">Nexora - A clearer way to move work forward</footer>
      </section>
    </main>
  );
}
