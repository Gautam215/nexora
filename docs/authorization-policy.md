# Nexora — Authorization policy (PRD 4)

Server-side enforcement is the only security boundary. Frontend visibility
is never a boundary: every route re-checks the caller's organization
membership, project membership, and role before reading or writing.

## Roles

Organization roles (`nexora.organization_role`): `owner`, `admin`,
`member`, `guest`.

Project roles (`nexora.project_role`): `manager`, `member`, `viewer`.

A user with no organization membership is a non-member: every
organization-scoped route returns 403 for them, before any business logic
runs. A member of another organization asking for a foreign project from
their own organization gets 404, never a cross-tenant leak.

## What each role may do

| Resource / action | owner | admin | member | guest | non-member |
| --- | --- | --- | --- | --- | --- |
| Read organization, projects, tasks, comments, files | yes | yes | member projects only | member projects only, read-only | 403 |
| Create projects | yes | yes | yes | no (403) | 403 |
| Organization settings (name, slug, quota) | yes | yes | no (403) | no (403) | 403 |
| Manage organization members (role, disable) | yes | yes | no (403) | no (403) | 403 |
| Remove organization members | yes | yes | self only (leave) | self only (leave) | 403 |
| Delete the organization | yes only | no (403) | no (403) | no (403) | 403 |
| Manage project members | owner, org admin/manager | yes | no | no | 403 |
| Create / edit tasks, comments, files in a project | manager or member | manager or member | manager or member | no (403 `PROJECT_WORK_ACCESS_REQUIRED`) | 404 |
| Read tasks, comments, files in a project | any project role | any project role | any project role | viewer may read | 404 |
| AI read workflows on a project (summarize, risk, assistant, generate draft) | any project role | any project role | any project role | yes, read-only, visibility-gated | 404 |
| AI confirm actions that create tasks | manager or member | manager or member | manager or member | no (task-creation gate, 403) | 404 |
| Usage report for the organization | yes | yes | no (403) | no (403) | 403 |

Removal is not a hard delete. The schema anchors history to memberships
with RESTRICT foreign keys (tasks created, comments authored, files
uploaded, notifications), so deleting a membership row fails for any
member with a footprint and would rewrite history if it succeeded.
Removal therefore disables the membership (denied exactly like a
non-member), unassigns the member's tasks in the workspace, deletes
their notification preferences and pending invitations, and revokes
their sessions when someone else removes them. A voluntary leave
keeps the leaver's sessions (their other workspaces must keep
working); org access is denied by the disabled membership alone,
which is the same guarantee disable already gives. Project
membership rows stay as history anchors and grant nothing once the org
membership is disabled. Removal is reversible by reactivation, and the
`membership.removed` audit event distinguishes it from a plain disable.

Notes:

- "Organization security settings" in PRD 4 is this surface: organization
  settings plus membership role management plus invitations (owner/admin
  only). There is no separate security-settings panel; the policy above
  is the setting.
- A disabled organization membership (`status = 'disabled'`) is denied
  at the organization context, exactly like a non-member. Disable is
  reversible by an owner/admin; removal likewise disables the
  membership row (it does not delete it) and is reversible by
  reactivation.
- A deleted organization (`status = 'deletion_pending'`) is denied at
  the tenant context, so its projects, tasks, comments, files,
  notifications, and analytics vanish from every surface at once.
- Project ownership: the project creator is its owner and may always
  work in it, even without an explicit project membership row.
- Viewer read-only is enforced twice: routes return 403
  `PROJECT_WORK_ACCESS_REQUIRED` for viewer writes, and row-level
  security (`nexora.can_work_current_project`, manager/member only)
  denies the write even if a route check were bypassed.

## Enforcement layers, in order

1. Session authentication (`getAuthPrincipal`): no session → 401.
2. Organization context (`withOrganizationContext`): membership must be
   `active` and the organization must not be deleted; the minimum role
   is per-route (`guest` for reads, `member` for project creation,
   `admin` for member management). Failure → 403.
3. Project visibility (`nexora.can_access_current_project`): the caller
   must be the project owner, an organization manager, or an active
   project member. Failure → 404, so hidden projects are
   indistinguishable from missing ones.
4. Project work (`nexora.can_work_current_project`): manager/member
   only (plus project owner and organization managers). Failure → 403
   `PROJECT_WORK_ACCESS_REQUIRED`.
5. Row-level security on every tenant table, using the same two
   functions, so a SQL-level bypass of the route checks still cannot
   read or write another tenant's rows.

## Known limitation (not a vulnerability)

Row-level denials that reach a route without a pre-check surface as
server errors (500) rather than 403, because a 42501 can also mean a
missing column grant, and masking a grant misconfiguration as
"forbidden" would hide a real outage. Every write path that matters
(tasks, comments, files, milestones, members) has an explicit pre-check
and returns 403; the 500 shape is confined to paths where no pre-check
exists.

Two defense-in-depth gaps are documented, not hidden. The member
removal function (`apply_organization_member_removal`, migration
0056) enforces manager-or-self only; owner protection and the
last-owner block live in the removal route, and no second caller
exists today, so a future caller must re-enforce them. The operator
aggregate functions (migration 0061) are SECURITY DEFINER with no
caller guard and return counts only; only the token-gated metrics
route calls them today, and they must never be called from a
user-session route, where they would leak global cross-tenant
counts.
