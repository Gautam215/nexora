CREATE SCHEMA IF NOT EXISTS nexora;

CREATE TYPE nexora.user_status AS ENUM (
  'active',
  'suspended',
  'deletion_pending'
);

CREATE TYPE nexora.organization_status AS ENUM (
  'active',
  'archived',
  'deletion_pending'
);

CREATE TYPE nexora.organization_role AS ENUM (
  'owner',
  'admin',
  'member',
  'guest'
);

CREATE TYPE nexora.membership_status AS ENUM (
  'active',
  'invited',
  'disabled'
);

CREATE FUNCTION nexora.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('nexora.user_id', true), '')::uuid
$function$;

CREATE FUNCTION nexora.current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('nexora.organization_id', true), '')::uuid
$function$;

CREATE FUNCTION nexora.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = pg_catalog.clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TABLE nexora.users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status nexora.user_status NOT NULL DEFAULT 'active',
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT users_email_normalized CHECK (email = pg_catalog.lower(pg_catalog.btrim(email))),
  CONSTRAINT users_email_length CHECK (pg_catalog.length(email) BETWEEN 3 AND 320),
  CONSTRAINT users_display_name_length CHECK (pg_catalog.length(pg_catalog.btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT users_password_hash_length CHECK (pg_catalog.length(password_hash) BETWEEN 32 AND 512)
);

CREATE UNIQUE INDEX users_email_unique ON nexora.users (email);

CREATE TABLE nexora.user_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES nexora.users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_seen_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT user_sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_sessions_expiry_after_create CHECK (expires_at > created_at)
);

CREATE INDEX user_sessions_by_user_expiry
  ON nexora.user_sessions (user_id, expires_at DESC);
CREATE INDEX user_sessions_active_by_user
  ON nexora.user_sessions (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE nexora.organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  status nexora.organization_status NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL REFERENCES nexora.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT organizations_name_length CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT organizations_slug_length CHECK (pg_catalog.length(slug) BETWEEN 2 AND 63)
);

CREATE UNIQUE INDEX organizations_slug_unique ON nexora.organizations (slug);

CREATE TABLE nexora.organization_memberships (
  organization_id uuid NOT NULL REFERENCES nexora.organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES nexora.users(id) ON DELETE RESTRICT,
  role nexora.organization_role NOT NULL,
  status nexora.membership_status NOT NULL,
  invited_by uuid REFERENCES nexora.users(id) ON DELETE RESTRICT,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT memberships_invitation_state CHECK (
    (status = 'invited' AND joined_at IS NULL)
    OR (status IN ('active', 'disabled') AND joined_at IS NOT NULL)
  )
);

CREATE INDEX memberships_by_user_status
  ON nexora.organization_memberships (user_id, status, organization_id);

CREATE TABLE nexora.organization_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nexora.organizations(id) ON DELETE RESTRICT,
  email text NOT NULL,
  role nexora.organization_role NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES nexora.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT invitations_email_normalized CHECK (email = pg_catalog.lower(pg_catalog.btrim(email))),
  CONSTRAINT invitations_email_length CHECK (pg_catalog.length(email) BETWEEN 3 AND 320),
  CONSTRAINT invitations_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitations_expiry_after_create CHECK (expires_at > created_at),
  CONSTRAINT invitations_not_owner CHECK (role <> 'owner'),
  CONSTRAINT invitations_single_terminal_state CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX invitations_one_pending_per_org_email
  ON nexora.organization_invitations (organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_by_org_expiry
  ON nexora.organization_invitations (organization_id, expires_at);

CREATE TABLE nexora.audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nexora.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES nexora.users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT audit_action_format CHECK (action ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  CONSTRAINT audit_target_type_format CHECK (target_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT audit_details_object CHECK (pg_catalog.jsonb_typeof(details) = 'object')
);

CREATE INDEX audit_events_by_org_time
  ON nexora.audit_events (organization_id, created_at DESC, id DESC);

CREATE FUNCTION nexora.is_current_organization_member(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT target_organization_id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = target_organization_id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
    )
$function$;

CREATE FUNCTION nexora.is_current_user_organization_creator(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM nexora.organizations AS organization
    WHERE organization.id = target_organization_id
      AND organization.created_by = nexora.current_user_id()
  )
$function$;

REVOKE ALL ON FUNCTION nexora.current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.current_organization_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.is_current_organization_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.is_current_user_organization_creator(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.touch_updated_at() FROM PUBLIC;

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON nexora.users
  FOR EACH ROW EXECUTE FUNCTION nexora.touch_updated_at();
CREATE TRIGGER organizations_touch_updated_at
  BEFORE UPDATE ON nexora.organizations
  FOR EACH ROW EXECUTE FUNCTION nexora.touch_updated_at();
CREATE TRIGGER memberships_touch_updated_at
  BEFORE UPDATE ON nexora.organization_memberships
  FOR EACH ROW EXECUTE FUNCTION nexora.touch_updated_at();

ALTER TABLE nexora.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select_self ON nexora.users
  FOR SELECT USING (id = nexora.current_user_id());
CREATE POLICY users_insert_self ON nexora.users
  FOR INSERT WITH CHECK (id = nexora.current_user_id());
CREATE POLICY users_update_self ON nexora.users
  FOR UPDATE USING (id = nexora.current_user_id())
  WITH CHECK (id = nexora.current_user_id());

CREATE POLICY sessions_select_self ON nexora.user_sessions
  FOR SELECT USING (user_id = nexora.current_user_id());
CREATE POLICY sessions_insert_self ON nexora.user_sessions
  FOR INSERT WITH CHECK (user_id = nexora.current_user_id());
CREATE POLICY sessions_update_self ON nexora.user_sessions
  FOR UPDATE USING (user_id = nexora.current_user_id())
  WITH CHECK (user_id = nexora.current_user_id());

CREATE POLICY organizations_select_member_or_creator ON nexora.organizations
  FOR SELECT USING (
    created_by = nexora.current_user_id()
    OR EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = organizations.id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
    )
  );
CREATE POLICY organizations_insert_creator ON nexora.organizations
  FOR INSERT WITH CHECK (created_by = nexora.current_user_id());
CREATE POLICY organizations_update_admin ON nexora.organizations
  FOR UPDATE USING (
    id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = organizations.id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = organizations.id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin')
    )
  );

CREATE POLICY memberships_select_self ON nexora.organization_memberships
  FOR SELECT USING (user_id = nexora.current_user_id());
CREATE POLICY memberships_insert_initial_owner ON nexora.organization_memberships
  FOR INSERT WITH CHECK (
    user_id = nexora.current_user_id()
    AND role = 'owner'
    AND status = 'active'
    AND joined_at IS NOT NULL
    AND invited_by IS NULL
    AND nexora.is_current_user_organization_creator(organization_id)
  );

CREATE POLICY invitations_select_admin ON nexora.organization_invitations
  FOR SELECT USING (
    organization_id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = organization_invitations.organization_id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin')
    )
  );
CREATE POLICY invitations_insert_admin ON nexora.organization_invitations
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND invited_by = nexora.current_user_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = organization_invitations.organization_id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin')
    )
  );
CREATE POLICY invitations_update_admin ON nexora.organization_invitations
  FOR UPDATE USING (
    organization_id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = organization_invitations.organization_id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = organization_invitations.organization_id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin')
    )
  );

CREATE POLICY audit_events_select_member ON nexora.audit_events
  FOR SELECT USING (nexora.is_current_organization_member(organization_id));
CREATE POLICY audit_events_insert_actor ON nexora.audit_events
  FOR INSERT WITH CHECK (
    nexora.is_current_organization_member(organization_id)
    AND actor_user_id = nexora.current_user_id()
  );
