-- 0035: Organization-level idempotency for AI confirmations.
--
-- Planning and extraction confirmations create a project that does
-- not exist yet, so they cannot use project_mutation_idempotency:
-- that table's primary key and foreign key both require a project
-- id. This table mirrors its shape (key hash, request hash, stored
-- response, 7-day expiry, replay-or-conflict) at the organization
-- level instead. The operation distinguishes workflows
-- ('planning.confirm', 'extraction.confirm'); the key is
-- client-generated and must match the idempotency-key header pattern
-- used elsewhere. An expired prior row is deleted on reuse, exactly
-- as the milestone route does for its own table.
--
-- The organization purge deletes these rows: they are operational,
-- not audit, and a purged organization must not keep them. The purge
-- function below is 0034's body verbatim plus that one DELETE.
CREATE TABLE nexora.ai_creation_idempotency (
  organization_id uuid NOT NULL
    REFERENCES nexora.organizations (id)
    ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL
    REFERENCES nexora.users (id)
    ON DELETE RESTRICT,
  operation text NOT NULL
    CHECK (operation IN ('planning.confirm', 'extraction.confirm')),
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  response_status smallint NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL DEFAULT (pg_catalog.now() + interval '7 days'),
  PRIMARY KEY (organization_id, actor_user_id, operation, key_hash)
);

ALTER TABLE nexora.ai_creation_idempotency ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_creation_idempotency_select_actor ON nexora.ai_creation_idempotency
  FOR SELECT USING (
    organization_id = nexora.current_organization_id()
    AND actor_user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  );

CREATE POLICY ai_creation_idempotency_insert_actor ON nexora.ai_creation_idempotency
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND actor_user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  );

CREATE POLICY ai_creation_idempotency_delete_actor ON nexora.ai_creation_idempotency
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND actor_user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  );

CREATE OR REPLACE FUNCTION nexora.purge_expired_organizations()
RETURNS TABLE(organization_id uuid, storage_key uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  expired_org RECORD;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nexora-organization-purge', 0));
  FOR expired_org IN
    SELECT organization.id
    FROM nexora.organizations AS organization
    WHERE organization.status = 'deletion_pending'
      AND organization.purged_at IS NULL
      AND organization.deleted_at <= pg_catalog.now() - interval '30 days'
  LOOP
    BEGIN
      RETURN QUERY
      DELETE FROM nexora.task_files AS file
      WHERE file.organization_id = expired_org.id
      RETURNING expired_org.id, file.storage_key;
      DELETE FROM nexora.task_comment_mentions AS mention
      WHERE mention.organization_id = expired_org.id;
      DELETE FROM nexora.task_comments AS comment
      WHERE comment.organization_id = expired_org.id;
      DELETE FROM nexora.task_dependencies AS dependency
      WHERE dependency.organization_id = expired_org.id;
      DELETE FROM nexora.tasks AS task
      WHERE task.organization_id = expired_org.id;
      DELETE FROM nexora.milestone_dependencies AS dependency
      WHERE dependency.organization_id = expired_org.id;
      DELETE FROM nexora.milestones AS milestone
      WHERE milestone.organization_id = expired_org.id;
      DELETE FROM nexora.project_task_statuses AS status
      WHERE status.organization_id = expired_org.id;
      DELETE FROM nexora.project_mutation_idempotency AS idempotency
      WHERE idempotency.organization_id = expired_org.id;
      DELETE FROM nexora.project_memberships AS membership
      WHERE membership.organization_id = expired_org.id;
      DELETE FROM nexora.projects AS project
      WHERE project.organization_id = expired_org.id;
      DELETE FROM nexora.ai_executions AS execution
      WHERE execution.organization_id = expired_org.id;
      DELETE FROM nexora.ai_creation_idempotency AS idempotency
      WHERE idempotency.organization_id = expired_org.id;
      DELETE FROM nexora.organization_invitations AS invitation
      WHERE invitation.organization_id = expired_org.id;
      DELETE FROM nexora.notification_preferences AS preference
      WHERE preference.organization_id = expired_org.id;
      DELETE FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = expired_org.id;
      UPDATE nexora.organizations AS organization
      SET purged_at = pg_catalog.now()
      WHERE organization.id = expired_org.id;
      -- One marker row per purged organization, even when it has no
      -- files: callers count purged organizations from these rows and
      -- must skip the NULL storage key when removing files from disk.
      RETURN QUERY SELECT expired_org.id, NULL::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'nexora organization purge skipped %: %', expired_org.id, SQLERRM;
    END;
  END LOOP;
  RETURN;
END
$function$;

REVOKE ALL ON FUNCTION nexora.purge_expired_organizations() FROM PUBLIC;
