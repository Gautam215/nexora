-- 0027: Purge notifications through the project foreign key cascade.
--
-- 0026 added a DELETE policy for expired-project notifications, but that
-- alone cannot work: for DELETE (and UPDATE), PostgreSQL also requires
-- the SELECT policy to permit the row, and notifications use FORCE
-- row-level security with a recipient-scoped SELECT policy. The purge
-- function runs without a tenant session, so no recipient context can
-- ever satisfy the SELECT policy for every recipient's rows, and the
-- explicit DELETE step therefore removes zero rows. Loosening the SELECT
-- policy or granting BYPASSRLS would weaken recipient privacy or add a
-- broad privilege, both worse than this change.
--
-- Instead, the notifications foreign key becomes ON DELETE CASCADE.
-- Referential actions bypass row-level security, so purging a project
-- now removes its notifications with it. The outcome is identical to
-- the approved purge: notifications of expired projects are removed
-- when the project is purged, and nothing else changes -- the runtime
-- role still holds no DELETE grant on notifications, and the only
-- hard-delete path for projects remains the purge function. The
-- explicit notifications DELETE step in 0024 is retained as a harmless
-- no-op (it removes zero rows under FORCE RLS); the cascade carries
-- the deletion. The 0026 policy is dropped as superseded.

DROP POLICY IF EXISTS notifications_delete_expired_projects ON nexora.notifications;

ALTER TABLE nexora.notifications
  DROP CONSTRAINT notifications_project_fk,
  ADD CONSTRAINT notifications_project_fk
    FOREIGN KEY (organization_id, project_id)
    REFERENCES nexora.projects (organization_id, id)
    ON DELETE CASCADE;
