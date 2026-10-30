"use client";

import { RefreshIcon } from "./components/button-icons";

// Route error boundary: when a page throws during render,
// Next.js renders this instead of an unstyled failure. The message is
// deliberately generic: the real error (which may contain internal
// detail) is logged server-side by Next.js and is never rendered
// here. "Try again" re-renders the route; the workspaces link gives
// the user a way out that does not depend on the failed route.
export default function RouteError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <section aria-labelledby="route-error-title">
        <p className="eyebrow">Something went wrong</p>
        <h1 id="route-error-title">This page could not be shown</h1>
        <p className="project-section-copy">
          The page hit an unexpected error. Try again, or return to
          your workspaces and continue from there.
        </p>
        <button type="button" onClick={() => reset()}><RefreshIcon />
          Try again
        </button>{" "}
        <a href="/workspaces">Back to workspaces</a>
      </section>
    </main>
  );
}
