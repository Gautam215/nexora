ALTER TABLE nexora.auth_rate_limits DROP CONSTRAINT auth_rate_scope;
ALTER TABLE nexora.auth_rate_limits ADD CONSTRAINT auth_rate_scope CHECK (
  scope IN (
    'register-email',
    'login-email',
    'verification-email',
    'verify-token',
    'password-reset-email',
    'password-reset-token',
    'organization-create-user',
    'organization-invite-user',
    'organization-invite-email',
    'organization-invitation-token',
    'project-management-user'
  )
);

CREATE OR REPLACE FUNCTION nexora.consume_auth_rate_limit(
  target_scope text,
  target_subject_hash text,
  max_attempts integer,
  window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  new_attempt_count integer;
BEGIN
  IF target_scope NOT IN (
      'register-email',
      'login-email',
      'verification-email',
      'verify-token',
      'password-reset-email',
      'password-reset-token',
      'organization-create-user',
      'organization-invite-user',
      'organization-invite-email',
      'organization-invitation-token',
      'project-management-user'
    )
    OR target_subject_hash !~ '^[0-9a-f]{64}$'
    OR max_attempts NOT BETWEEN 1 AND 60
    OR window_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'invalid rate limit parameters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO nexora.auth_rate_limits AS current_bucket
    (scope, subject_hash, window_started_at, attempts, expires_at)
  VALUES (
    target_scope,
    target_subject_hash,
    v_now,
    1,
    v_now + pg_catalog.make_interval(secs => window_seconds)
  )
  ON CONFLICT (scope, subject_hash) DO UPDATE
  SET attempts = CASE
        WHEN current_bucket.window_started_at
          <= v_now - pg_catalog.make_interval(secs => window_seconds)
          THEN 1
        ELSE current_bucket.attempts + 1
      END,
      window_started_at = CASE
        WHEN current_bucket.window_started_at
          <= v_now - pg_catalog.make_interval(secs => window_seconds)
          THEN v_now
        ELSE current_bucket.window_started_at
      END,
      expires_at = CASE
        WHEN current_bucket.window_started_at
          <= v_now - pg_catalog.make_interval(secs => window_seconds)
          THEN v_now + pg_catalog.make_interval(secs => window_seconds)
        ELSE current_bucket.expires_at
      END
  RETURNING attempts INTO new_attempt_count;

  RETURN new_attempt_count <= max_attempts;
END
$function$;

CREATE TYPE nexora.project_status AS ENUM (
  'planned',
  'active',
  'on_hold',
  'completed',
  'archived'
);

CREATE TYPE nexora.project_role AS ENUM (
  'manager',
  'member',
  'viewer'
);

CREATE TYPE nexora.project_membership_status AS ENUM (
  'active',
  'disabled'
);

CREATE TABLE nexora.projects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nexora.organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  description text,
  status nexora.project_status NOT NULL DEFAULT 'planned',
  owner_user_id uuid NOT NULL,
  start_date date,
  target_date date,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT projects_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT projects_owner_membership_fk
    FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT projects_name_length CHECK (
    pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 160
  ),
  CONSTRAINT projects_description_length CHECK (
    description IS NULL OR pg_catalog.length(description) <= 10000
  ),
  CONSTRAINT projects_date_range CHECK (
    start_date IS NULL OR target_date IS NULL OR target_date >= start_date
  ),
  CONSTRAINT projects_version_positive CHECK (version >= 1)
);

CREATE INDEX projects_by_org_created
  ON nexora.projects (organization_id, created_at DESC, id DESC);

CREATE TABLE nexora.project_memberships (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role nexora.project_role NOT NULL,
  status nexora.project_membership_status NOT NULL DEFAULT 'active',
  added_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (organization_id, project_id, user_id),
  CONSTRAINT project_memberships_project_fk
    FOREIGN KEY (organization_id, project_id)
    REFERENCES nexora.projects (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT project_memberships_user_fk
    FOREIGN KEY (organization_id, user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT project_memberships_added_by_fk
    FOREIGN KEY (organization_id, added_by_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT
);

CREATE INDEX project_memberships_by_user
  ON nexora.project_memberships (organization_id, user_id, status, project_id);

CREATE FUNCTION nexora.can_create_current_project(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT target_organization_id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      JOIN nexora.organizations AS organization
        ON organization.id = membership.organization_id
      WHERE membership.organization_id = target_organization_id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin', 'member')
        AND organization.status = 'active'
    )
$function$;

CREATE FUNCTION nexora.is_active_organization_member(
  target_organization_id uuid,
  target_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT target_organization_id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      JOIN nexora.organizations AS organization
        ON organization.id = membership.organization_id
      JOIN nexora.users AS account
        ON account.id = membership.user_id
      WHERE membership.organization_id = target_organization_id
        AND membership.user_id = target_user_id
        AND membership.status = 'active'
        AND organization.status = 'active'
        AND account.status = 'active'
        AND account.email_verified_at IS NOT NULL
    )
$function$;

CREATE FUNCTION nexora.can_access_current_project(
  target_organization_id uuid,
  target_project_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT target_organization_id = nexora.current_organization_id()
    AND nexora.is_current_organization_member(target_organization_id)
    AND EXISTS (
      SELECT 1
      FROM nexora.organizations AS organization
      WHERE organization.id = target_organization_id
        AND organization.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM nexora.projects AS project
      WHERE project.organization_id = target_organization_id
        AND project.id = target_project_id
        AND (
          nexora.is_current_organization_manager(target_organization_id)
          OR project.owner_user_id = nexora.current_user_id()
          OR EXISTS (
            SELECT 1
            FROM nexora.project_memberships AS membership
            WHERE membership.organization_id = target_organization_id
              AND membership.project_id = target_project_id
              AND membership.user_id = nexora.current_user_id()
              AND membership.status = 'active'
          )
        )
    )
$function$;

CREATE FUNCTION nexora.can_manage_current_project(
  target_organization_id uuid,
  target_project_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT target_organization_id = nexora.current_organization_id()
    AND nexora.is_current_organization_member(target_organization_id)
    AND EXISTS (
      SELECT 1
      FROM nexora.organizations AS organization
      WHERE organization.id = target_organization_id
        AND organization.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM nexora.projects AS project
      WHERE project.organization_id = target_organization_id
        AND project.id = target_project_id
        AND (
          project.owner_user_id = nexora.current_user_id()
          OR nexora.is_current_organization_manager(target_organization_id)
          OR EXISTS (
            SELECT 1
            FROM nexora.project_memberships AS membership
            WHERE membership.organization_id = target_organization_id
              AND membership.project_id = target_project_id
              AND membership.user_id = nexora.current_user_id()
              AND membership.role = 'manager'
              AND membership.status = 'active'
          )
        )
    )
$function$;

CREATE FUNCTION nexora.is_project_owner(
  target_organization_id uuid,
  target_project_id uuid,
  target_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT target_organization_id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.projects AS project
      WHERE project.organization_id = target_organization_id
        AND project.id = target_project_id
        AND project.owner_user_id = target_user_id
    )
$function$;

CREATE FUNCTION nexora.list_current_project_members(
  target_organization_id uuid,
  target_project_id uuid
)
RETURNS TABLE (
  user_id uuid,
  display_name text,
  role text,
  status text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT membership.user_id,
         account.display_name,
         membership.role::text,
         membership.status::text,
         membership.created_at
  FROM nexora.project_memberships AS membership
  JOIN nexora.users AS account ON account.id = membership.user_id
  WHERE membership.organization_id = target_organization_id
    AND membership.project_id = target_project_id
    AND nexora.can_access_current_project(target_organization_id, target_project_id)
  ORDER BY membership.role, account.display_name, membership.user_id
$function$;

CREATE FUNCTION nexora.guard_project_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  transition_allowed boolean;
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION 'project owner transfer requires a dedicated operation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    transition_allowed := CASE OLD.status
      WHEN 'planned' THEN NEW.status IN ('active', 'archived')
      WHEN 'active' THEN NEW.status IN ('on_hold', 'completed', 'archived')
      WHEN 'on_hold' THEN NEW.status IN ('active', 'archived')
      WHEN 'completed' THEN NEW.status IN ('active', 'archived')
      WHEN 'archived' THEN false
    END;
    IF NOT COALESCE(transition_allowed, false) THEN
      RAISE EXCEPTION 'invalid project status transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER projects_guard_update
  BEFORE UPDATE ON nexora.projects
  FOR EACH ROW EXECUTE FUNCTION nexora.guard_project_update();

CREATE TRIGGER project_memberships_touch_updated_at
  BEFORE UPDATE ON nexora.project_memberships
  FOR EACH ROW EXECUTE FUNCTION nexora.touch_updated_at();

REVOKE ALL ON FUNCTION nexora.can_create_current_project(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.is_active_organization_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.can_access_current_project(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.can_manage_current_project(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.is_project_owner(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.list_current_project_members(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.guard_project_update() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION nexora.can_create_current_project(uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.is_active_organization_member(uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.can_access_current_project(uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.can_manage_current_project(uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.is_project_owner(uuid, uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.list_current_project_members(uuid, uuid) TO nexora_app;

ALTER TABLE nexora.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.project_memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_select_current_member ON nexora.projects
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, id)
  );

CREATE POLICY projects_insert_current_member ON nexora.projects
  FOR INSERT WITH CHECK (
    nexora.can_create_current_project(organization_id)
    AND owner_user_id = nexora.current_user_id()
  );

CREATE POLICY projects_update_manager ON nexora.projects
  FOR UPDATE USING (
    nexora.can_manage_current_project(organization_id, id)
  )
  WITH CHECK (
    nexora.can_manage_current_project(organization_id, id)
  );

CREATE POLICY project_memberships_select_project_member ON nexora.project_memberships
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY project_memberships_insert_project_manager ON nexora.project_memberships
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND added_by_user_id = nexora.current_user_id()
    AND nexora.can_manage_current_project(organization_id, project_id)
    AND nexora.is_active_organization_member(organization_id, user_id)
  );

CREATE POLICY project_memberships_update_project_manager ON nexora.project_memberships
  FOR UPDATE USING (
    organization_id = nexora.current_organization_id()
    AND user_id <> nexora.current_user_id()
    AND NOT nexora.is_project_owner(organization_id, project_id, user_id)
    AND nexora.can_manage_current_project(organization_id, project_id)
  )
  WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND user_id <> nexora.current_user_id()
    AND NOT nexora.is_project_owner(organization_id, project_id, user_id)
    AND nexora.can_manage_current_project(organization_id, project_id)
    AND nexora.is_active_organization_member(organization_id, user_id)
  );
