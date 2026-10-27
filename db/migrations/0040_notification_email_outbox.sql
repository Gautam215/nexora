-- Notification email outbox (approved default, 2026-10-26).
-- PRD §13 defers email delivery ("design the architecture so email
-- notifications can be added safely later"). The approved shape is a
-- transactional outbox plus a background worker, not synchronous sends
-- from mutation routes: a synchronous send would slow every mutation
-- and fail it on SMTP failure, and a failed send would vanish.
-- Policy is deliberately off by default: the server only enqueues an
-- email when BOTH (a) the operator configured the event type in
-- NEXORA_NOTIFICATION_EMAIL_TYPES and (b) the recipient enabled
-- email for that event type in their notification preferences
-- (email_enabled, default false). No notification is emailed by
-- default, and no email is sent when SMTP is unconfigured: the
-- worker fails closed and leaves rows pending for a later run.
--
-- All outbox access goes through SECURITY DEFINER functions. The
-- table itself has no direct app-role grants, because the outbox is
-- a server/worker concern, not a user-visible record: a user must
-- never read another recipient's outbox rows through RLS, and the
-- worker runs without a tenant session (like the cleanup command).

ALTER TABLE nexora.notification_preferences
  ADD COLUMN email_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE nexora.notification_email_outbox (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  notification_id uuid NOT NULL UNIQUE,
  organization_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  href text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  sent_at timestamptz,
  CONSTRAINT notification_email_outbox_event_type CHECK (
    event_type IN ('mention', 'task_assigned', 'project_activity', 'due_date', 'ai_workflow')
  ),
  CONSTRAINT notification_email_outbox_status CHECK (
    status IN ('pending', 'processing', 'sent', 'failed')
  ),
  CONSTRAINT notification_email_outbox_title_length CHECK (
    pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 120
  ),
  CONSTRAINT notification_email_outbox_body_length CHECK (
    pg_catalog.length(pg_catalog.btrim(body)) BETWEEN 1 AND 500
  ),
  CONSTRAINT notification_email_outbox_notification_fk
    FOREIGN KEY (notification_id)
    REFERENCES nexora.notifications (id)
    ON DELETE CASCADE,
  CONSTRAINT notification_email_outbox_organization_fk
    FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT
);

CREATE INDEX notification_email_outbox_pending
  ON nexora.notification_email_outbox (status, next_attempt_at, created_at)
  WHERE status = 'pending';

ALTER TABLE nexora.notification_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.notification_email_outbox FORCE ROW LEVEL SECURITY;

-- Whether the recipient enabled email for this event type. No row
-- means false: email is opt-in, never opt-out by omission.
CREATE FUNCTION nexora.notification_email_enabled(
  target_organization_id uuid,
  target_user_id uuid,
  target_event_type text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT COALESCE((
    SELECT preference.email_enabled
    FROM nexora.notification_preferences AS preference
    WHERE preference.organization_id = target_organization_id
      AND preference.user_id = target_user_id
      AND preference.event_type = target_event_type
    LIMIT 1
  ), false);
$function$;

REVOKE ALL ON FUNCTION nexora.notification_email_enabled(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.notification_email_enabled(uuid, uuid, text) TO nexora_app;

-- Enqueue an email for an already-created in-app notification, in
-- the caller's transaction (so a rolled-back mutation never leaves
-- an orphan email). The notification must belong to the caller's
-- organization and have the caller as its actor; the recipient must
-- be a member of the same organization. Duplicate enqueues for the
-- same notification are ignored (UNIQUE notification_id).
CREATE FUNCTION nexora.enqueue_notification_email_outbox(
  target_notification_id uuid,
  target_organization_id uuid,
  target_recipient_user_id uuid,
  target_event_type text,
  target_title text,
  target_body text,
  target_href text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  outbox_id uuid;
BEGIN
  IF nexora.current_organization_id() IS DISTINCT FROM target_organization_id THEN
    RAISE EXCEPTION 'notification email enqueue is not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nexora.notifications AS notification
    WHERE notification.id = target_notification_id
      AND notification.organization_id = target_organization_id
      AND notification.recipient_user_id = target_recipient_user_id
      AND notification.actor_user_id = nexora.current_user_id()
  ) THEN
    RAISE EXCEPTION 'notification email enqueue is not authorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO nexora.notification_email_outbox (
    notification_id, organization_id, recipient_user_id,
    event_type, title, body, href
  )
  VALUES (
    target_notification_id, target_organization_id, target_recipient_user_id,
    target_event_type, target_title, target_body, target_href
  )
  ON CONFLICT (notification_id) DO NOTHING
  RETURNING id INTO outbox_id;
  RETURN outbox_id;
END;
$function$;

REVOKE ALL ON FUNCTION nexora.enqueue_notification_email_outbox(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.enqueue_notification_email_outbox(uuid, uuid, uuid, text, text, text, text) TO nexora_app;

-- Claim the next pending batch for the worker. Claiming increments
-- attempts and moves rows to 'processing' atomically (FOR UPDATE
-- SKIP LOCKED), so two workers never send the same email twice.
-- The recipient email is resolved here, in the SECURITY DEFINER
-- function, so the worker never needs a tenant session and never
-- sees a recipient's other data.
CREATE FUNCTION nexora.claim_notification_email_outbox(p_limit integer)
RETURNS TABLE (
  outbox_id uuid,
  notification_id uuid,
  organization_id uuid,
  recipient_user_id uuid,
  recipient_email text,
  event_type text,
  title text,
  body text,
  href text,
  attempts integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  WITH claimed AS (
    UPDATE nexora.notification_email_outbox
    SET status = 'processing',
        claimed_at = pg_catalog.now(),
        attempts = attempts + 1,
        last_attempt_at = pg_catalog.now()
    WHERE id IN (
      SELECT id FROM nexora.notification_email_outbox
      WHERE status = 'pending' AND next_attempt_at <= pg_catalog.now()
      ORDER BY created_at ASC, id ASC
      LIMIT GREATEST(p_limit, 1)
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  )
  SELECT claimed.id, claimed.notification_id, claimed.organization_id,
    claimed.recipient_user_id, account.email, claimed.event_type,
    claimed.title, claimed.body, claimed.href, claimed.attempts
  FROM claimed
  JOIN nexora.users AS account ON account.id = claimed.recipient_user_id;
$function$;

REVOKE ALL ON FUNCTION nexora.claim_notification_email_outbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.claim_notification_email_outbox(integer) TO nexora_app;

CREATE FUNCTION nexora.mark_notification_email_sent(p_outbox_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  UPDATE nexora.notification_email_outbox
  SET status = 'sent', sent_at = pg_catalog.now()
  WHERE id = p_outbox_id AND status = 'processing';
$function$;

REVOKE ALL ON FUNCTION nexora.mark_notification_email_sent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.mark_notification_email_sent(uuid) TO nexora_app;

-- A transient failure returns the row to pending with a backoff
-- (5 minutes per attempt, so attempt 1 retries in 5 minutes, attempt
-- 2 in 10, and so on); after 5 attempts, or when the worker marks a
-- failure permanent, the row is 'failed' and is never retried
-- automatically. No SMTP detail is stored: only the generic status.
CREATE FUNCTION nexora.mark_notification_email_failed(p_outbox_id uuid, p_permanent boolean)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  UPDATE nexora.notification_email_outbox
  SET status = CASE
      WHEN p_permanent OR attempts >= 5 THEN 'failed'
      ELSE 'pending'
    END,
    next_attempt_at = CASE
      WHEN p_permanent OR attempts >= 5 THEN next_attempt_at
      ELSE pg_catalog.now() + (pg_catalog.make_interval(mins => attempts * 5))
    END
  WHERE id = p_outbox_id AND status = 'processing';
$function$;

REVOKE ALL ON FUNCTION nexora.mark_notification_email_failed(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.mark_notification_email_failed(uuid, boolean) TO nexora_app;

-- A worker that crashes between claim and mark leaves rows in
-- 'processing'. Those rows are never retried automatically, or a
-- crashed worker could double-send after a restart. The worker
-- resets rows claimed more than 30 minutes ago to pending before
-- claiming a new batch, so a crash delays — but never loses or
-- duplicates — an email. A row that was actually sent before the
-- crash and then reset could be sent twice; that is the known,
-- documented trade-off of at-least-once email delivery, and it is
-- why the worker sends from a claimed batch, not from a blind
-- resend of every pending row.
CREATE FUNCTION nexora.reset_stuck_notification_email_outbox()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  reset_count integer;
BEGIN
  UPDATE nexora.notification_email_outbox
  SET status = 'pending', claimed_at = NULL
  WHERE status = 'processing'
    AND claimed_at IS NOT NULL
    AND claimed_at <= pg_catalog.now() - pg_catalog.make_interval(mins => 30);
  GET DIAGNOSTICS reset_count = ROW_COUNT;
  RETURN reset_count;
END;
$function$;

REVOKE ALL ON FUNCTION nexora.reset_stuck_notification_email_outbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.reset_stuck_notification_email_outbox() TO nexora_app;
