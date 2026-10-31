import { cookies } from "next/headers";
import { BrandLogo } from "./components/brand-logo";
import { sessionCookieName } from "../server/auth.ts";
import { lookupActiveSession } from "../server/db.ts";
import { hashOpaqueToken } from "../security/tokens.ts";

const HERO_BACKGROUND_URL =
  "https://cdn.21st.dev/assets/mirror/a8/a8cf38f65f7315f95eba8c803c4a80a9d78cb2ea36fbfee49828396e4a0b9737.jpg";

// Signed-in visitors go to the workspace list from the logo; everyone else
// goes home. Any failure (no database, no session) falls back to home, so
// the hero still renders without a database configured.
async function isSignedIn(): Promise<boolean> {
  try {
    const token = (await cookies()).get(sessionCookieName())?.value;
    const tokenHash = hashOpaqueToken(token);
    if (!tokenHash) return false;
    return (await lookupActiveSession(tokenHash)) !== null;
  } catch {
    return false;
  }
}

export default async function HomePage() {
  const signedIn = await isSignedIn();
  return (
    <main>
      <section className="home-hero" aria-labelledby="page-title">
        <img className="home-hero-bg" src={HERO_BACKGROUND_URL} alt="" />
        <div className="home-hero-shade" aria-hidden="true" />
        <header className="home-hero-header">
          <BrandLogo logoClassName="home-hero-logo" href={signedIn ? "/workspaces" : "/"} />
        </header>
        <div className="home-hero-content">
          <p className="eyebrow">Nexora — AI-Powered Team Project Management &amp; Real-Time Collaboration</p>
          <h1 id="page-title">A calmer place to move work forward.</h1>
          <p className="intro-copy">
            Bring your team&apos;s plans, decisions, and next steps into one calm,
            secure workspace. Start with your account and organization.
          </p>
          <div className="home-actions">
            <a className="primary-button button-link" href="/register">Create your account</a>
            <a className="home-login" href="/login">Sign in</a>
          </div>
        </div>
      </section>

      <div className="home-below">
        <section className="intro" aria-labelledby="positioning-title">
          <h2 id="positioning-title">What Nexora covers</h2>
          <ul>
            <li>Project and task management with Kanban workflows</li>
            <li>Team collaboration: comments, mentions, and activity</li>
            <li>Real-time synchronization and presence</li>
            <li>Project analytics and auditability</li>
            <li>AI-powered project intelligence, embedded in real workflows</li>
            <li>Secure file and document handling</li>
            <li>Notifications, with production-grade security and reliability</li>
          </ul>
          <p className="intro-copy">
            AI here assists real work — summaries, planning drafts, risk
            notes, and meeting follow-ups — it does not replace the team.
          </p>
        </section>

        <footer className="page-footer">
          <span>Design by Gautam</span>
          <span>Built for focused teams</span>
        </footer>
      </div>
    </main>
  );
}
