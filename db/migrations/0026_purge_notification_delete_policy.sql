-- 0026: Allow the retention purge to delete expired-project notifications.
--
-- nexora.notifications is the one purge-path table with FORCE row-level
-- security, and it has no DELETE policy. FORCE means the policies apply
-- even to the table owner, so the SECURITY DEFINER purge function in
-- 0024 silently deleted zero notification rows and then failed on the
-- notifications_project_fk foreign key when deleting the project.
-- This policy permits deleting notifications only for projects
-- soft-deleted at least 30 days ago -- exactly the purge's scope. The
-- runtime role holds no DELETE grant on notifications (SELECT and
-- UPDATE(read_at) only), so in practice this policy is exercisable only
-- through the purge function, never through the API.

CREATE POLICY notifications_delete_expired_projects
  ON nexora.notifications FOR DELETE
  USING (
    project_id IN (
      SELECT project.id FROM nexora.projects AS project
      WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
    )
  );
