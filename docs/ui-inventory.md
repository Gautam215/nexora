# UI inventory — surfaces and their states (PRD 36)

Every surface below is a real route or component in this repo; there
are no placeholder screens. States use four shared patterns, so a
surface is covered when it uses them, not when it invents its own:

- **Loading:** a `role="status"` note ("Loading…") or a button that
  switches to its pending label ("Creating…", "Please wait…") and
  disables itself. No spinners, no skeletons.
- **Empty:** a `workspace-empty` block or a `workspace-note`
  ("No comments yet.", "You are all caught up.").
- **Error:** a `form-message form-error` paragraph with
  `role="alert"`, plus a Retry button where the data can be
  re-fetched. The message is the API's message, never a generic
  "something went wrong" that hides the cause.
- **Denied:** there is no dedicated denied screen. Unauthenticated
  requests (401) redirect to `/login` from every data component.
  A non-member workspace answers 404, not 403, by design (the
  org-detail query filters to active memberships, so a stranger
  cannot probe for a workspace's existence). A signed-in user
  without the role for an action sees the API's 403 message
  inline as a form error, and the UI hides or disables the
  action first with a role note ("Your role is member; only
  project managers can edit these details.").

## Surfaces

| Surface (route → component) | Loading | Empty | Error | Denied |
| --- | --- | --- | --- | --- |
| Landing `/` → `page.tsx` | Static, no fetch | n/a | n/a | n/a |
| Login / register / forgot / reset / resend / verify → `auth-page.tsx` | Submit button pending label | n/a | Form error, `role="alert"` | n/a (public) |
| Onboarding `/onboarding` | Pending on create | n/a | Form error | 401 → `/login` |
| Workspaces `/workspaces` → `workspace-pages.tsx` | Create button pending | `workspace-empty` when no workspaces | Form error | 401 → `/login` |
| Workspace `/organizations/[id]` → `organization-page.tsx`, `organization-projects.tsx` | Pending on settings save | "Open a workspace to view its projects" note; "No pending invitations." | Form error + Retry | Role note for non-managers; 404 for non-members |
| Members `/organizations/[id]/members` → `organization-members-page.tsx` | Pending on invite/role change | "No pending invitations."; "No project members are available." | Form error + Retry | Role note; owner protection (owners cannot be removed) |
| Project tasks `/…/projects/[id]/tasks` → `project-tasks-page.tsx` | "Loading comments…" / "Loading activity…" status notes | "No comments yet."; "No activity has been recorded yet."; 100-comment cap note | Form error + Retry | Viewer role note; work actions hidden for viewers |
| Project milestones `/…/milestones` → `project-milestones-page.tsx` | Status notes | "No milestones yet" equivalent notes | Form error + Retry | Manager-only actions hidden for others |
| Project activity `/…/activity` → `project-activity-page.tsx` | "Loading activity…" | "No activity has been recorded yet." | Form error + Retry | 401 → `/login` |
| Project page `/…/projects/[id]` → `project-page.tsx` | Status notes | Notes per section | Form error + Retry | Role note |
| Search `/…/search` → `organization-search-page.tsx` | Pending on search | "No results" note | Form error | 401 → `/login`; results are authorization-filtered server-side (hidden projects return nothing) |
| Notifications `/…/notifications` → `notification-center.tsx` | Pending per notification/preference | "You are all caught up." | Form error | 401 → `/login` |
| Account `/account` → `account-settings-page.tsx` | Pending on password/session actions | "No active sessions found." | Form error + Retry | 401 → `/login` |
| Accept invitation `/accept-invitation` → `accept-invitation-page.tsx` | Pending on accept | Note for unverified accounts | Form error | Invalid/expired token message (no account enumeration) |
| AI panels (summary, planning, extraction, risk, assistant) → `ai-*.tsx` | Pending on generate/confirm | Notes when no data (e.g. no tasks to summarize) | Form error; provider failure surfaces as the API's 503 message | Viewer: read workflows only; confirm actions hidden (task-creation gate) |
| Realtime panel → `realtime-panel.tsx` | "Live updates: connecting…" until the stream opens | n/a | Stream failure note; EventSource reconnects automatically | n/a (read-only, visibility-gated) |

## Viewports

Acceptance is checked with the browser harness
(`~/workspace/nexora-browser-tests/`), not by resizing a dev
browser by hand: `a11y-check.py` accepts a `VIEWPORT` environment
variable (`375x667` mobile, `768x1024` tablet, unset = desktop
1280x720) and runs its heading, label, keyboard, and language
checks at that size. The same four pages are checked at all
three sizes; a viewport-specific failure is reported as a
failure, not skipped. Contrast is enforced in the codebase, not
in the harness: `tests/accessibility.test.ts` ("DESIGN.md palette
pairs meet WCAG AA for normal text (4.5:1)") asserts WCAG AA
ratios for the theme tokens, and
the harness's keyboard check asserts a visible focus indicator
on every focused element.

## Known gaps (honest, not fixed by this document)

- No dedicated denied screen: a 403 always surfaces as an
  inline error message. That is deliberate (it never leaks
  whether the target exists beyond what the API already says),
  but it means a denied user sees an error paragraph, not an
  explanation page.
- The landing page and auth pages have no loading skeleton;
  they are static or single-form, so a pending button label is
  the whole loading state.
- Focus management across dynamic changes (dialog open/close)
  is covered by the a11y harness's focus checks on `/account`;
  the human screen-reader pass (PRD 37) remains open.
