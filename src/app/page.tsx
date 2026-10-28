export default function HomePage() {
  return (
    <main className="page-shell">
      <header className="brand">
        <span className="brand-mark" aria-hidden="true">
          N
        </span>
        <span>Nexora</span>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">Nexora — AI-Powered Team Project Management &amp; Real-Time Collaboration</p>
        <h1 id="page-title">A calmer place to move work forward.</h1>
        <p className="intro-copy">
          Bring your team's plans, decisions, and next steps into one calm,
          secure workspace. Start with your account and organization.
        </p>
        <div className="home-actions">
          <a className="primary-button button-link" href="/register">Create your account</a>
          <a className="home-login" href="/login">Sign in</a>
        </div>
      </section>

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
        <span>Private by design</span>
        <span>Built for focused teams</span>
      </footer>
    </main>
  );
}
