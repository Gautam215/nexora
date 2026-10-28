-- 0061_operator_metrics_aggregates.sql
--
-- Operator aggregates for /api/metrics (PRD 33). The metrics route
-- is token-gated, not session-gated, so it cannot borrow a user's
-- RLS context, and two of the three sources are unreadable to the
-- app role directly: ai_executions has an own-row SELECT policy,
-- and notification_email_outbox has RLS enabled with no policies
-- at all. Both aggregates below therefore run SECURITY DEFINER
-- and return counts only — never user data, prompts, responses,
-- or email bodies. scheduled_job_runs has no RLS and the app role
-- already holds SELECT on it, so the route reads job failures
-- directly without a function.
--
-- ai_operator_aggregate: execution counts by status, token totals
-- all-time and trailing 30 days, average latency over completed
-- executions, and per-workflow counts. Token and latency columns
-- are nullable (started rows have none), so the sums coalesce.
-- outbox_queue_depth: email-outbox rows by status. A failed row
-- is one that exhausted its attempts; a pending row is one that
-- has not been sent yet, including rows awaiting their next
-- backoff attempt.

CREATE OR REPLACE FUNCTION nexora.ai_operator_aggregate()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'executionsTotal', (SELECT pg_catalog.count(*) FROM nexora.ai_executions),
    'executionsSucceeded', (SELECT pg_catalog.count(*) FROM nexora.ai_executions WHERE status = 'succeeded'),
    'executionsFailed', (SELECT pg_catalog.count(*) FROM nexora.ai_executions WHERE status = 'failed'),
    'executionsStarted', (SELECT pg_catalog.count(*) FROM nexora.ai_executions WHERE status = 'started'),
    'promptTokensTotal', COALESCE((SELECT pg_catalog.sum(prompt_tokens) FROM nexora.ai_executions), 0),
    'completionTokensTotal', COALESCE((SELECT pg_catalog.sum(completion_tokens) FROM nexora.ai_executions), 0),
    'promptTokensLast30d', COALESCE((SELECT pg_catalog.sum(prompt_tokens) FROM nexora.ai_executions WHERE created_at >= pg_catalog.now() - interval '30 days'), 0),
    'completionTokensLast30d', COALESCE((SELECT pg_catalog.sum(completion_tokens) FROM nexora.ai_executions WHERE created_at >= pg_catalog.now() - interval '30 days'), 0),
    'avgLatencyMs', (SELECT pg_catalog.round(pg_catalog.avg(latency_ms)) FROM nexora.ai_executions WHERE latency_ms IS NOT NULL),
    'byWorkflow', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('workflow', workflow, 'count', workflow_count))
      FROM (
        SELECT workflow, pg_catalog.count(*) AS workflow_count
        FROM nexora.ai_executions
        GROUP BY workflow
        ORDER BY workflow
      ) AS per_workflow
    ), '[]'::jsonb)
  );
$function$;

CREATE OR REPLACE FUNCTION nexora.outbox_queue_depth()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'pending', (SELECT pg_catalog.count(*) FROM nexora.notification_email_outbox WHERE status = 'pending'),
    'processing', (SELECT pg_catalog.count(*) FROM nexora.notification_email_outbox WHERE status = 'processing'),
    'sent', (SELECT pg_catalog.count(*) FROM nexora.notification_email_outbox WHERE status = 'sent'),
    'failed', (SELECT pg_catalog.count(*) FROM nexora.notification_email_outbox WHERE status = 'failed')
  );
$function$;

REVOKE EXECUTE ON FUNCTION nexora.ai_operator_aggregate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.ai_operator_aggregate() TO nexora_app;
REVOKE EXECUTE ON FUNCTION nexora.outbox_queue_depth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.outbox_queue_depth() TO nexora_app;
