"use client";

import { useState, type FormEvent } from "react";

export type AuthPageMode =
  | "login"
  | "register"
  | "forgot-password"
  | "resend-verification"
  | "reset-password"
  | "verify-email";

interface AuthPageProps {
  mode: AuthPageMode;
  nextPath?: string | null;
}

interface ApiResponse {
  data?: { message?: string };
  error?: { message?: string };
}

const pageCopy: Record<Exclude<AuthPageMode, "verify-email">, { title: string; copy: string }> = {
  login: {
    title: "Welcome back.",
    copy: "Sign in to return to your team's work.",
  },
  register: {
    title: "Make room for better work.",
    copy: "Create your Nexora account. Your first workspace comes next.",
  },
  "forgot-password": {
    title: "Reset your password.",
    copy: "We'll send a private reset link if the address is eligible.",
  },
  "resend-verification": {
    title: "Confirm your email.",
    copy: "Request a fresh confirmation link for your Nexora account.",
  },
  "reset-password": {
    title: "Choose a new password.",
    copy: "Use a passphrase of at least 12 characters.",
  },
};

export default function AuthPage({ mode, nextPath }: AuthPageProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verified, setVerified] = useState(false);
  const isVerificationPage = mode === "verify-email";
  const { title, copy } = isVerificationPage
    ? { title: verified ? "Email confirmed." : "Confirm your email.", copy: "This one-time link verifies the address on your account." }
    : pageCopy[mode];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError("");
    setMessage("");

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    let endpoint = "";
    let body: Record<string, string> = {};
    if (mode === "register") {
      endpoint = "/api/auth/register";
      body = {
        name: String(form.get("name") ?? ""),
        email,
        password: String(form.get("password") ?? ""),
      };
    } else if (mode === "login") {
      endpoint = "/api/auth/login";
      body = { email, password: String(form.get("password") ?? "") };
    } else if (mode === "forgot-password" || mode === "resend-verification") {
      endpoint = mode === "forgot-password"
        ? "/api/auth/password-reset/request"
        : "/api/auth/verification/resend";
      body = { email };
    } else if (mode === "reset-password") {
      const token = new URLSearchParams(window.location.search).get("token") ?? "";
      window.history.replaceState(null, "", "/reset-password");
      const password = String(form.get("password") ?? "");
      if (password !== confirmPassword) {
        setError("The passwords do not match.");
        return;
      }
      endpoint = "/api/auth/password-reset/complete";
      body = { token, password };
    }

    setPending(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => null)) as ApiResponse | null;
      if (!response.ok) {
        setError(result?.error?.message ?? "Unable to complete that request. Try again.");
        return;
      }

      formElement.reset();
      setConfirmPassword("");
      if (mode === "login") {
        window.location.assign(nextPath ?? "/workspaces");
      } else if (mode === "reset-password") {
        setMessage("Your password is updated. Sign in with the new password.");
      } else if (mode === "forgot-password") {
        setMessage("If the address is eligible, reset instructions will arrive by email.");
      } else if (mode === "resend-verification") {
        setMessage("If the address is eligible, a confirmation link will arrive by email.");
      } else {
        setMessage("Check your inbox for a confirmation link. You can request another one below.");
      }
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  async function confirmEmail() {
    setPending(true);
    setError("");
    setMessage("");
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    window.history.replaceState(null, "", "/verify-email");
    try {
      const response = await fetch("/api/auth/verification/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const result = (await response.json().catch(() => null)) as ApiResponse | null;
      if (!response.ok) {
        setError(result?.error?.message ?? "This confirmation link is invalid or expired.");
        return;
      }
      setVerified(true);
      setMessage("Your Nexora account is ready. Sign in to create a workspace.");
    } catch {
      setError("The service could not be reached. Try again in a moment.");
    } finally {
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
          <p className="eyebrow">Teamwork, with clarity</p>
          <h1>Make progress feel lighter.</h1>
          <p>One calm place for teams to see what matters, decide what is next, and move together.</p>
        </div>
        <div className="auth-story-foot">
          <span className="story-rule" aria-hidden="true" />
          <span>Private by design. Built for focused teams.</span>
        </div>
      </aside>

      <section className="auth-main" aria-labelledby="auth-title">
        <div className="auth-card">
          <span className="auth-kicker">Nexora account</span>
          <h2 id="auth-title">{title}</h2>
          <p className="auth-copy">{copy}</p>

          {isVerificationPage ? (
            <div className="auth-actions">
              <button className="primary-button" type="button" onClick={confirmEmail} disabled={pending || verified}>
                {pending ? "Confirming..." : verified ? "Email confirmed" : "Confirm email"}
              </button>
              {!verified && <p className="form-hint">The link is single-use and expires after two hours.</p>}
            </div>
          ) : !message || mode !== "reset-password" ? (
            <form className="auth-form" onSubmit={submit}>
              {mode === "register" && (
                <label className="form-field">
                  <span>Your name</span>
                  <input name="name" type="text" autoComplete="name" maxLength={120} required />
                </label>
              )}

              {mode !== "reset-password" && (
                <label className="form-field">
                  <span>Email address</span>
                  <input name="email" type="email" autoComplete="email" maxLength={320} required />
                </label>
              )}

              {(mode === "register" || mode === "login" || mode === "reset-password") && (
                <label className="form-field">
                  <span>{mode === "login" ? "Password" : "New password"}</span>
                  <input
                    name="password"
                    type="password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    minLength={mode === "login" ? 1 : 12}
                    maxLength={128}
                    required
                  />
                  {mode !== "login" && <small>12-128 characters. A memorable passphrase works well.</small>}
                </label>
              )}

              {mode === "reset-password" && (
                <label className="form-field">
                  <span>Confirm new password</span>
                  <input
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                  />
                </label>
              )}

              <button className="primary-button" type="submit" disabled={pending}>
                {pending ? "Please wait..." : submitLabel(mode)}
              </button>
            </form>
          ) : null}

          {error && <p className="form-message form-error" role="alert">{error}</p>}
          {message && <p className="form-message form-success" role="status" aria-live="polite">{message}</p>}
          <nav className="auth-links" aria-label="Account links">{linksFor(mode, verified, nextPath)}</nav>
        </div>
        <footer className="auth-footer">Nexora - A clearer way to move work forward</footer>
      </section>
    </main>
  );
}

function submitLabel(mode: AuthPageMode): string {
  switch (mode) {
    case "login": return "Sign in";
    case "register": return "Create account";
    case "forgot-password": return "Send reset link";
    case "resend-verification": return "Send confirmation link";
    case "reset-password": return "Save new password";
    case "verify-email": return "Confirm email";
  }
}

function linksFor(mode: AuthPageMode, verified: boolean, nextPath?: string | null) {
  const nextQuery = nextPath ? `?next=${encodeURIComponent(nextPath)}` : "";
  if (mode === "login") {
    return <><a href="/forgot-password">Forgot password?</a><a href={`/register${nextQuery}`}>Create an account</a></>;
  }
  if (mode === "register") {
    return <><a href={`/login${nextQuery}`}>Already have an account? Sign in</a><a href="/resend-verification">Resend confirmation</a></>;
  }
  if (mode === "verify-email") {
    return <a href={verified ? `/login${nextQuery}` : "/resend-verification"}>{verified ? "Continue to sign in" : "Request another confirmation link"}</a>;
  }
  if (mode === "reset-password") return <a href={`/login${nextQuery}`}>Return to sign in</a>;
  return <a href="/login">Return to sign in</a>;
}
