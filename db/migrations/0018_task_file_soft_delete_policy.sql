DROP POLICY task_files_select_project_member ON nexora.task_files;

CREATE POLICY task_files_select_project_member ON nexora.task_files
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, project_id)
    AND (
      deleted_at IS NULL
      OR (
        deleted_by_user_id = nexora.current_user_id()
        AND nexora.can_work_current_project(organization_id, project_id)
      )
    )
  );
