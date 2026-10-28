-- 0055_remove_unused_membership_delete_policies.sql
--
-- Correction to 0054, append-only (0054 itself is not edited). Member
-- removal turned out to be a disable, not a hard delete: the schema
-- anchors history to memberships with RESTRICT foreign keys (tasks
-- created, comments authored, files uploaded, notifications), so
-- deleting a membership row fails for any member with a footprint and
-- would rewrite history if it succeeded. Removal therefore disables
-- the membership and unassigns the member's tasks instead of deleting
-- the row. The organization/project membership DELETE policies from
-- 0054 are unused, and an unused DELETE privilege is a liability, so
-- they are removed here. The notification-preference and invitation
-- DELETE policies from 0054 ARE used by removal (preferences and
-- pending invitations are deleted) and stay, as does their grant in
-- db/runtime-grants.sql.

DROP POLICY IF EXISTS memberships_delete_manager ON nexora.organization_memberships;
DROP POLICY IF EXISTS memberships_delete_self ON nexora.organization_memberships;
DROP POLICY IF EXISTS project_memberships_delete_manager ON nexora.project_memberships;
DROP POLICY IF EXISTS project_memberships_delete_self ON nexora.project_memberships;

REVOKE DELETE ON nexora.organization_memberships, nexora.project_memberships FROM nexora_app;
