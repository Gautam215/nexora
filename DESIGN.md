# Nexora — Design System

This is the one doc for how Nexora looks and feels. It covers the design that's already in the product, plus the rules a new screen has to follow. If this doc and the shipped CSS disagree, the shipped CSS wins. That's only until the CSS gets changed on purpose, and then this doc has to be updated in that same change. No exceptions there, or the two drift apart and nobody knows which one to trust.

For what the product is, the source is the Nexora PRD (sections 0, 35, 36, 37) and the traceability record in `docs/prd-traceability.md`. This doc doesn't describe features that don't exist yet, like AI workflows or realtime presence. It says how they have to look and behave once they're built.

## 1. Visual direction and design principles

Nexora is a serious, modern SaaS product for teams. Not a tutorial dashboard. The look is Apple-inspired and slightly dark. Calm surfaces, one restrained accent, a lot of information without clutter, and nothing decorative that doesn't help someone finish a task.

Principles, in priority order:

1. Clarity before decoration. Every screen answers, in order: where am I, what is this, what can I do here, what happened last. If a visual element doesn't serve one of those questions, take it out.
2. One accent, used sparingly. The sage accent marks focus, the brand mark, and the small number of primary actions and status labels that need it. It isn't a general highlight colour.
3. Density with breathing room. Project, task, and activity lists are information-dense, but text never crowds a border, and interactive targets are never smaller than a comfortable tap target.
4. Server truth, honest states. A screen never invents a metric, a percentage, or an AI insight. A value with no data shows "no data", not 0%. A failed action says what failed and what to do next.
5. Same patterns everywhere. Auth pages, workspace pages, project pages, and settings use the same shell, forms, cards, tables, and feedback patterns. A new screen reuses an existing pattern. It doesn't invent a one-off layout.
6. Restraint in motion. Motion signals a state change: a status moved, a panel opened, a drag started. It never decorates a page load, a list, or a card for its own sake.

## 2. Colours and typography

### 2.1 Colour tokens (shipped, in `src/app/globals.css`)

The product is dark-only. There's no light theme, and no screen may introduce one without a deliberate, documented change to the token set.

| Token | Value | Use |
| --- | --- | --- |
| Background | `#111315` | Page background |
| Surface | `#191c1f` | Cards, panels, dialogs, raised surfaces |
| Foreground | `#f2f3f4` | Primary text |
| Muted | `#a1a6aa` | Secondary text, descriptions, helper text |
| Border | `#303538` | Dividers, card and input borders |
| Accent (sage) | `#a9c2b0` | Focus ring, brand mark, eyebrow labels, primary emphasis |

Supporting rules:

- Text on a surface is foreground for primary content and muted for secondary content only. Don't introduce a third text colour for decoration.

### 2.1a Accessibility (measured 2026-10-26, static checks only)

Contrast (WCAG AA for normal text is 4.5:1; verified by `tests/accessibility.test.ts`, which fails if a pair drops below it):

| Pair | Ratio |
| --- | --- |
| Foreground `#f2f3f4` on background `#111315` | 16.76:1 |
| Foreground on surface `#191c1f` | 15.40:1 |
| Muted `#a1a6aa` on background | 7.58:1 |
| Muted on surface | 6.97:1 |
| Accent `#a9c2b0` on background | 9.78:1 |

All pairs pass AA. Muted on surface (6.97:1) passes AA but not AAA (7:1). So don't use muted text for anything smaller or lighter than the current body sizes without re-measuring. That one's close to the line, and it's easy to slip under it without noticing.

Form controls: every control in `src/app/components/` is either wrapped in a `<label>` or carries an `aria-label` (verified by the same test file; hidden inputs are exempt). Focus is visible via `:focus-visible` in `globals.css`. These static checks don't prove WCAG conformance. A keyboard and screen-reader pass on the deployed app is still outstanding, and it's recorded as such. Don't claim it until it has actually run.

- Status is conveyed by text first, then by a small shape or label. Never by colour alone. Project health, task status, and membership status always have a readable label.
- The page background carries a single soft radial wash (dark green-grey, centred high on the page, fading out by about 43% of the viewport). It's the only decorative background in the product. Don't add gradients, patterns, or imagery to other surfaces.
- The brand mark is a 30 px rounded square (9 px radius) with a dark green surface, a muted green border, and light green text. It's the only logo treatment. Don't restyle it per page.

### 2.2 Typography

- Font stack: the system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`). No webfont is loaded, and no new font may be added without a performance justification.
- Headings use tight letter-spacing and a weight around 560–600. Body text uses regular weight with a line height around 1.7 for longer copy.
- Scale (shipped, fluid where noted):
  - Page/hero heading: fluid, roughly 42 px at small widths to 76 px at large widths, line height about 1.03.
  - Eyebrow label: 12 px, semibold, 0.12 em letter-spacing, uppercase, accent colour. Used for the small label above a heading, not for body text.
  - Body/intro copy: 16–18 px, muted, line height 1.7.
  - Supporting text (status pills, meta, captions): 13 px.
  - Brand wordmark: 16 px, semibold, −0.03 em letter-spacing.
- Numbers that are metrics (progress, counts, workload) use the same font as text. There's no separate display font for numbers.
- Never use all-caps for body text, and never set text smaller than 12 px for content a user must read to act.

## 3. Spacing and layout system

- The page shell is a full-height flex column, with padding that scales from 24 px on small screens to 64 px on large screens.
- Content width is constrained by readability, not by the viewport. Intro and form content is capped at about 690 px and centred. Headings are capped at about 650 px. Body copy at about 510 px.
- Vertical rhythm: a section heading is followed by 20–25 px of space before its copy. A status pill or primary action sits about 34 px below intro copy.
- Cards and panels use the surface token, a 1 px border, and a radius that matches the component family (9 px for small elements such as the brand mark; larger radii only where an existing component already uses them).
- Status pills are fully rounded (999 px radius), with a 1 px border, a translucent surface, and a 7 px indicator dot. Don't invent a second pill style.
- Gaps inside a component are 10–13 px for inline elements (icon + label, dot + text). Don't use a different gap for the same relationship on different screens. That kind of drift is how a product starts looking patched together.

## 4. Reusable components

The following components already exist in `src/app/components/` and must be reused. A new screen that needs a component not listed here must first check whether an existing one can be extended. Honestly, most of the time it can.

- Auth page (`auth-page.tsx`): the shared shell for register, login, forgot-password, reset-password, verify-email, and resend-verification. One form, one primary action, secondary links below, errors announced inline. No auth screen may build its own shell.
- Workspace pages (`workspace-pages.tsx`): organization list, organization detail, and workspace navigation. The workspace is the unit of navigation. Every project screen hangs off a workspace.
- Organization pages (`organization-page.tsx`, `organization-members-page.tsx`, `organization-projects.tsx`): organization detail, member management, and project listing within an organization.
- Project pages (`project-page.tsx`, `project-tasks-page.tsx`, `project-milestones-page.tsx`, `project-activity-page.tsx`, `project-work-nav.tsx`): project overview (including calculated progress, health, workload, activity, and deadlines), Kanban/list task board, milestones, and activity feed, with shared project navigation.
- Organization search page (`organization-search-page.tsx`): workspace search results, with a pagination control rendered as a semantic `<nav>` element.
- Notification centre (`notification-center.tsx`): in-app notifications, read/unread state, and preferences. The UI states plainly that email delivery is not enabled yet. Don't imply otherwise.
- Accept-invitation page (`accept-invitation-page.tsx`): invitation acceptance. The token is removed from the address bar and held in tab-scoped session storage while the invitee signs in. The page never displays the raw token.

Component rules:

- A component owns one screen or one panel, not a whole workflow.
- Buttons and links inherit the surrounding font. A button never sets its own font family or size unless the existing component already does.
- Progress is shown with a semantic `<progress>` element, not a styled `<div>` with an inline width. This is also a CSP rule: no inline styles for progress bars.
- Lists that paginate use the shared pagination pattern (semantic nav, same class and label). Lists that do not paginate say so by their bounded size (for example, at most six milestones on an overview, at most five recent activity events, at most eight upcoming deadlines).
- Dialogs, dropdowns, and menus, where they exist, follow the same surface, border, and focus rules as the rest of the product. A dialog must trap focus, close on Escape, and return focus to the element that opened it.

## 5. Navigation and forms

### 5.1 Navigation

- Top level: the brand mark and wordmark, then workspace navigation. A user with several organizations switches organization from the workspace, not from a project screen.
- Project navigation (`project-work-nav.tsx`) is shared across the project overview, tasks, milestones, and activity screens. A project screen never builds its own project nav.
- Navigation labels are nouns and verbs the user already knows: Workspaces, Projects, Milestones, Tasks, Activity, Search, Notifications. Don't rename them per screen.
- The current location is always visible in the navigation and in the page heading. A user must never have to guess which organization or project a screen belongs to.
- Deep links go to the same screen a user would reach by navigating there. A signed file-download link is the only exception, and it is time-limited (five minutes) and bound to one user, tenant, task, file, and version.

### 5.2 Forms

- Every field has a visible, associated label. Placeholder text is never a substitute for a label.
- Validation is client-visible and server-enforced. The server is the authority. Client validation is a convenience, not a boundary.
- Errors are shown inline, next to the field they belong to, in plain language, and are announced to assistive technology. A form never shows a generic "something went wrong" when a field-level message is possible.
- A primary action is a single button. Secondary actions are links or lower-emphasis buttons. A form never has two primary buttons.
- A submitting form disables its submit button and shows a loading state. It never allows a double submit to create a duplicate. Server-side idempotency keys back the important mutations (see `API.md`).
- Destructive actions (delete, remove a member, revoke an invitation) require an explicit confirmation step and state exactly what will happen, including what cannot be undone. Project deletion follows this pattern in a danger zone on the project page, visible only to managers: an opener button ("Delete project") reveals a confirmation panel (role `alertdialog`) naming the project and stating that it hides immediately for everyone and that its tasks, milestones, comments, files, and notifications are permanently removed after 30 days while activity records are kept. The confirm button ("Delete this project") is distinct from the opener, and cancellation ("Keep project") leaves the project untouched.
- File upload forms state the limits before upload: at most 10 MiB per file, at most 20 active files per task, at most 100 MiB per task. A rejected file says which rule it broke.

## 6. Loading, empty, and error states

Every data screen must define all four states before it ships. A screen that only handles the happy path is not finished. That's the rule, and it's there because the unhappy paths are where users actually get stuck.

- Loading: a skeleton or a labelled loading indicator in place of the content, with the page heading and navigation already visible. No spinner that blocks the whole page, and no layout shift when content arrives.
- Empty: a short sentence saying what would be here and the one action that creates it, if the user is allowed to create it. Examples: a project with no tasks, a search with no results, an organization with no projects. An empty analytics panel says "no data", not 0%.
- Error: a plain-language message, what the user can do (retry, check a field, contact an administrator), and no database detail, stack trace, or internal code. A 401 shows a sign-in prompt. A 403 shows a permission message, not a sign-in prompt. A 409 (concurrent update) says the project changed and asks the user to refresh and try again.
- Permission-denied: a dedicated state, not a blank screen and not a login redirect loop. It says the user does not have access to this organization or project, and offers the workspace list as a way out.
- Route crash: `src/app/error.tsx` is the route error boundary. When a page throws during render, the user sees a generic message with "Try again" (re-renders the route) and a link back to workspaces. No error message, stack trace, or internal detail is ever rendered. The real error is logged server-side. Build-verified only. No crashing route exists to exercise it in a browser test.
- Offline / reconnecting (future, realtime): when realtime arrives, a disconnected client must show a reconnecting state and fall back to refresh/polling. Until then, a failed fetch is an error state, not a silent stale screen.

## 7. Interactions and animations

- Kanban drag and drop: dragging is available only in board view, only when the user has work permission, only when the full list is shown (no pagination remainder), and only when no filter is active. When dragging is unavailable, a status control is the alternative. A user must never be left with no way to change a status.
- Drag alternative: every drag operation has a keyboard/screen-reader alternative (the status control). Drag alone is never the only path.
- Optimistic updates: only where safe. A status change may update optimistically and roll back on a 409. A consequential creation (a project, a member invitation, an AI-generated plan) never pretends to succeed before the server confirms it.
- Motion: transitions are short and purposeful (panel open/close, status change, drag start). No page-load animation, no animated card hover, no looping decoration. Reduced motion (`prefers-reduced-motion`) disables non-essential motion entirely.
- Focus: the visible focus ring is a 2 px accent outline with a 4 px offset. It is never removed, and it is never replaced by a colour change alone. Focus order follows the visual order, and focus is managed on dialog open/close and after a destructive action completes.

## 8. Responsive behaviour

- Desktop: full workspace and project layouts, board and list views side by side with their filters, and the full analytics overview.
- Tablet: the same screens, with filters and navigation collapsing into the shared patterns rather than a separate layout. The Kanban board scrolls horizontally by column. It is never squeezed into unreadable columns.
- Mobile: single-column layout, full-width forms and cards, and the page-shell padding at its 24 px minimum. Kanban columns stack or scroll horizontally. Task cards show title, status, priority, assignee, and due date, in that order. No feature is desktop-only except where a future design document explicitly says so, and then the mobile alternative must be named.
- Breakpoints follow the shipped fluid rules (page padding and heading size scale with the viewport) rather than a fixed set of pixel breakpoints in this document. A new screen must use the same fluid approach.
- Touch targets are at least 44 px in the dimension a user taps, and tap targets never overlap.

## 9. Accessibility requirements

Accessibility is a release gate, not a note. A screen is not finished until each item below has been checked for that screen. Look, that sounds strict, and it is meant to be.

- Keyboard navigation covers every action, including Kanban status changes, pagination, dialogs, and notification actions. There is no mouse-only path.
- Semantic HTML: `<nav>` for pagination and navigation, `<progress>` for progress, real buttons for actions, real links for navigation, real labels for fields. A `<div>` with a click handler is not a button.
- Visible focus (section 7) on every interactive element, in the same style everywhere.
- Contrast: primary text on background and surface meets the usual AA bar. Muted text is used only for secondary content, never for a primary action label or an error message.
- Form errors are associated with their fields and announced. A form submit that fails does not silently leave focus where it was.
- Reduced motion is honoured (section 7).
- Screen-reader text is present where an icon alone would otherwise carry meaning (brand mark, status indicator dot, drag handle).
- The product is dark-only, so contrast is judged against the dark tokens in section 2, not against a light theme that does not exist.

## 10. Page-level layout guidance

- Auth pages: centred, capped-width form in the shared auth shell. One heading, one form, one primary action, secondary links below. No sidebar, no marketing copy, no decorative panel.
- Home / landing (signed out): full-viewport photo hero (header logo, centred eyebrow, heading, copy, and the real account actions), followed by the covers block. It states what Nexora is and nothing it does not yet do. The hero carries no demo text, no fake navigation, partners, badges, or calls to action.
- Workspace / organization list: list of organizations with name, membership, and a way into each workspace. Empty state: create an organization.
- Organization detail: organization name and members, project list, and member management. Member rows show name, role, and status (including disabled memberships, labelled as disabled).
- Project overview: progress, health (with its reason), workload (including unassigned tasks), milestone progress (at most six milestones), recent activity (at most five events, trailing seven days), and upcoming deadlines (at most eight). Every number is calculated from the database and labelled as such. No AI insight is shown here.
- Task board / list: columns or rows by workflow status, with filters, sorting, and pagination on the list view, and safe bulk priority updates where offered. Task cards show title, status, priority, assignee, labels, due date, and subtask progress, in that order.
- Milestones: milestone list with dates, status, linked-task progress, and dependency information. A milestone with no linked active tasks shows no percentage.
- Activity: an audit-backed feed of meaningful events (task created, assigned, status changed, comment added, member added, milestone completed), most recent first, with actor and time.
- Search: one search field, entity and project filters, bounded results (default 20, at most 50 per page, offset at most 10,000), and a result that shows only a title, a short preview, and an in-app destination. Member results never show email addresses. File results never show file content or storage keys.
- Notifications: a centre listing in-app notifications with read/unread state and preferences. It states that email delivery is not enabled yet.
- Settings: organization settings and member roles are still future work. Account security is built: the `/account` screen follows the same form and confirmation rules as section 5, with a password-change form and an active-sessions list (created, last seen, expiry, current flag) that shows no invented device details, because the account does not record them. Two rules govern its error and success states: a wrong current password stays on the page with its error (only a genuinely missing session redirects to sign-in), and a successful revocation refreshes the session list before showing its success message, so the refresh cannot erase the message. A settings screen that does nothing must not be implied for the parts that are still future.

## 11. What not to do

- Do not add a light theme, a second accent colour, a webfont, or a decorative illustration without a documented decision.
- Do not copy a generic SaaS dashboard template: no gradient hero, no feature-card grid, no fake metrics, no testimonial block.
- The home hero is a photo-background hero by explicit user decision (2026-10-29), not a gradient hero: its background photo host is allow-listed for images only, and the brand logo on every page follows the music-and-movies-show technique exactly. The leaf light variant is a true transparent PNG, rendered as a plain image with no blend mode, no background and no box, plus the same subtle drop-shadow glow. It still carries only real Nexora copy and real account actions.
- Home hero type and actions, by user decision (2026-10-30): the font is the system San Francisco stack (`--font-sans`), so Apple devices render real SF Pro and nothing is downloaded — this is not a webfont, so the no-webfont rule above is not broken. The hero stays centred with the same photo and shade gradient untouched. Buttons follow the Reelscape floating-nav example (2026-10-30): every primary button is a dark glass pill (rounded-full, translucent white, thin light border, 18px backdrop blur, inset top highlight, Inter stack), with a soft glow on hover and a scale(0.94) press; the hero Create account button is the same glass pill at a larger size.
- Fonts and page background, by user decision (2026-10-30): Nexora uses Reelscape's font system — Inter for text and headings, IBM Plex Mono for labels — loaded self-hosted with `next/font/google`, so no remote font request happens at runtime and the content-security policy needs no change (this is the documented font decision the no-webfont rule asks for). The page background is Reelscape's profile page background (`#050711`), with its blue glow, faint grid, and cursor-following liquid wave on every page. Surfaces, foreground, muted text and the sage accent stay Nexora's own, and the SF Pro stack from the earlier hero change is replaced by Inter-first ordering — Apple devices now render Inter, not SF Pro, because that is Reelscape's look.
- Profile background, wave, and boxes, by user decision (2026-10-30): every page carries Reelscape's profile background stack — blue top glow and faint 44px grid as fixed body layers, plus the `LiquidWaveBackground` component, a faithful WebGL port of Reelscape's profile liquid wave (same ripple shader, cursor-followed pointer, time animation, single still frame with reduced motion, empty canvas if WebGL is unavailable). The canvas is fixed behind a `nexora-page-content` wrapper so it shows on all pages; auth layouts keep only their sage glow tint (solid base removed) so the wave shows through app pages too. The home hero photo still covers the wave on the hero itself — the wave appears below the fold and on app pages. Every box in Nexora (workspace cards, organization cards, project cards, milestone cards, task cards, status cards, confirm panels, analytics panels) uses Reelscape's card colours: translucent surface, thin white border, backdrop blur, cinematic shadow on the large workspace card; hover states use the lighter translucent pair. Width-only card variants inherit the workspace card colours automatically. Text colours, radii, padding, and copy are unchanged.
- Apple dark theme on app pages, by user decision (2026-10-30): every page except the home page follows Apple's dark interface rules — Liquid Glass materials (translucent white surfaces, backdrop blur, thin light border, inner top highlight), white primary text, secondary text at 60% white, system blue for unread, system red for destructive actions. The theme is scoped to the two app shells (`.auth-layout` and `.project-work-layout`), which every app page renders; the home page renders a plain `<main>` with no app shell, so its photo hero is untouched. The sage accent is gone from app pages: eyebrows, links, pills, status dots, monograms, fields, and checkmarks are white or neutral glass instead of green. Notification preferences are Apple switches (the checkbox itself is unchanged — keyboard and screen reader behaviour identical — it is only painted as a 51×31 switch with a sliding white knob, system blue when on). The delete button is a Liquid Glass pill in translucent system red with white text, hover brightening, and a press scale. The wave backdrop stays behind the glass on app pages.
- Login bloom background, by user decision (2026-10-31): the login page only carries a Breath Bloom flower (`breath-bloom.tsx`, React only, no new dependency) as a fixed background layer behind the shared auth shell — six blue petals breathing on a slow loop, no guide or hint text, no overlay copy. The whole window's pointer position shapes it (sideways spreads the petals, down grows them, click pins a shape; clicks on form controls never pin), so it answers the cursor anywhere on the page, including over the form card. The story arc (`.auth-story::after`) is hidden on the login page only. Register, forgot-password, reset-password, verify-email, and resend-verification keep the old arc and gain no flower. Reduced motion shows one still pose.
- Login bloom fix, by user decision (2026-10-31): the first live version showed no flower — only the arc was gone. Root cause: the site CSP has no `unsafe-inline` for styles, so the browser drops the server-rendered inline style attributes the petals and glow were painted with, and this codebase otherwise uses no inline style props at all. Fix: petal and glow sizes and default-preset gradients moved into `.bloom-petal` / `.bloom-glow` classes (the component's inline background still wins after hydration, so other presets keep their colours). Same change also removes the old background on login, as the user asked: while the login page is mounted, AuthPage adds `login-bloom` to `<body>`, and globals.css hides the wave layers (`body::before`, `body::after`, `.liquid-wave-background`) under that class only; other pages keep the wave. Follow-up (2026-10-31): the story column's divider line (`.auth-story` `border-right`) was also removed on login only, after the user pointed at the line in the middle of the page.
- Buttons, by user decision (2026-10-31): every button carries a small action icon (hand-made stroke SVGs in `src/app/components/button-icons.tsx`, no new library) plus Apple liquid-glass styling with light blur (12px) on the shared classes; quiet buttons became muted glass chips instead of underline text; bare buttons joined their matching class (AI actions primary, secondary cancels quiet); the auth-card kicker "Nexora account" is white; file scan warnings and form errors (including "The authenticator code is incorrect.") are system red (#ff453a, the danger button's red) instead of the pale pink they were before.
- Buttons follow-up + workspaces background, by user decision (2026-10-31): the first icon pass had added icons but NOT classes to 12 bare buttons (script bug: it looked the class map up by full path while the keys were relative) — fixed, so Keep workspace and the AI panel actions now actually render their quiet/primary glass instead of a plain grey box; `.confirm-actions` gained 16px top margin so the Delete/Keep row no longer touches the field above it. Workspaces page only (`.workspace-layout`, body class `workspaces-dark-bg`): the old blue body glow + grid, the shell backgrounds, the story half-circle arc and the centre divider line are all removed, replaced by a plain-CSS port of the pasted DarkGradientBg (black radial base, five skewed cyan streaks with their masks, dot grid, soft highlight; demo text not carried over, 21st.dev noise texture at 5% opacity skipped as an invisible hotlink).
- Organization page Apple HIG + liquid-glass pass, by user decision (2026-10-31): the organization page only (`.organization-layout` scope — every other page is untouched) is restyled per Apple's Human Interface Guidelines together with the installed liquid-glass-widgets guide (`~/workspace/skills-repos/liquid-glass-widgets`, the sdegenaar Flutter package's AI guide; the package itself is Flutter-only, so its design rules are translated to CSS, not its widgets). Buttons are deliberately untouched, the dark page background is unchanged, and the layout/format (widths, order, sections) is unchanged. Per the guide's Rules 1–2 (glass is the control layer, never glass inside glass) and the HIG functional-layer rule, the content surfaces went from translucent glass to solid: the card is solid #1c1c1e with a 24px radius and a soft offset shadow, the status tile and project rows are solid #242426 — so the already-glass buttons now sit on solid content, which is the guide's own pattern, and the delete confirm panel keeps its glass (it is a dialog-like surface). Type and spacing follow HIG numbers: page title 28px/700 with −0.02em tracking (it was rendering at the 31–42px card-title size), section headings 17px/600, form gap 20px, confirm-actions gap 16px, quick-link gap 24px, field radius 12px. Fields keep their translucent control fill with a glowing system-blue focus ring (3px rgba(10,132,255,0.35)) that replaces the generic outline on keyboard focus; placeholders move to 60% white for contrast; links use system blue #0a84ff; selection uses the cyan accent; reduced-transparency flattens the remaining translucent fields and the dialog panel to solid. Tagline: "Private by design. Built for focused teams." is replaced by "Design by Gautam. Built for focused teams." on all 10 surfaces that carried it (9 component story footers plus the home footer, where only the first span changed and the rendered line reads identically).
- Content-hugging boxes and centred notifications, by user decision (2026-10-30): row boxes (organization, project, milestone, task, status cards, confirm panels) size to their content (`width: fit-content`, capped at 100%) with a 14px Apple card radius, so a box ends where its words end instead of stretching empty across the page. Form containers (workspace cards) and dashboard grid panels (analytics panels) keep their fixed widths — a form and a grid need them. The whole notifications section sits in one centred, light blur box (720px max, 20px radius, translucent white with blur) with the preference switches and notification rows inside it.
- No PRD references or "AI-generated" wording in code, by user decision (2026-10-30): source comments, panel copy, and the test provider string no longer mention PRD section numbers or carry an "AI-generated" label — the five AI panels, the draft-review sentences, and the analytics note present their content without a generated-content marker. Migration files and docs are excluded on purpose: migration headers are checksum-verified in production and append-only, and the traceability document maps PRD sections by design. Sign in stays a plain text link, underlined only on hover. Quiet text actions and danger buttons are untouched. Intro copy uses the lighter `--foreground-soft` token so it stays high-contrast over the photo.
- Logo destination, by user decision (2026-10-30): the brand logo is not a fixed home link. A signed-in user lands on the workspace list (`/workspaces`, the post-login landing) from the logo on any page, including the home hero itself — the home page checks the session cookie against the database and falls back to `/` if there is no session or no database, so the hero still renders without a database configured. A signed-out user, and any visitor on a sign-in or create-account page, lands on the home hero (`/`). The logo artwork itself is untouched; only its destination changes, and the accessible label follows the destination ("Nexora workspaces" vs "Nexora home").
- Do not use a component library's default styling. Nexora's components are custom and token-driven. A library component, if ever adopted, must be restyled to these tokens before it ships.
- Do not animate for decoration, and do not add a loading spinner to a screen that already has a skeleton pattern.
- Do not show AI-generated content without labelling it as AI-generated, and do not present an AI recommendation as a confirmed fact. (AI features do not exist yet; this rule binds their future design.)
