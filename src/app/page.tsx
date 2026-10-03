export default function HomePage() {
  return (
    <main className="page-shell">
      <header className="brand" aria-label="Nexora">
        <span className="brand-mark" aria-hidden="true">
          N
        </span>
        <span>Nexora</span>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">Teamwork, with clarity</p>
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

      <footer className="page-footer">
        <span>Private by design</span>
        <span>Built for focused teams</span>
      </footer>
    </main>
  );
}
