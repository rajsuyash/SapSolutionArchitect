-- Per-model token usage for the admin cost estimate. platform_admin_orgs() (0009) sums tokens over all models,
-- which cannot be priced per model, so this companion function keeps the model recorded in job metrics.
-- Same 30-day window, same two job tables, same guard on non-numeric token values. model is NULL for jobs
-- whose metrics predate model recording (or have no metrics); the caller prices those at the default rate.
CREATE FUNCTION platform_admin_usage_by_model() RETURNS TABLE(
  org_id uuid, model text, input_tokens_30d bigint, output_tokens_30d bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.platform_admin', 'on', true);
  RETURN QUERY
  WITH j AS (
    SELECT org_id, created_at, metrics FROM public.jobs
    UNION ALL SELECT org_id, created_at, metrics FROM public.consultant_jobs)
  SELECT j.org_id,
    CASE WHEN jsonb_typeof(j.metrics->'model') = 'string' THEN j.metrics->>'model' END,
    coalesce(sum(CASE WHEN jsonb_typeof(j.metrics->'inputTokens') = 'number' THEN (j.metrics->>'inputTokens')::numeric END), 0)::bigint,
    coalesce(sum(CASE WHEN jsonb_typeof(j.metrics->'outputTokens') = 'number' THEN (j.metrics->>'outputTokens')::numeric END), 0)::bigint
  FROM j WHERE j.created_at > clock_timestamp() - interval '30 days'
  GROUP BY j.org_id, 2;
  PERFORM set_config('app.platform_admin', '', true);
END $$;

REVOKE ALL ON FUNCTION platform_admin_usage_by_model() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_admin_usage_by_model() FROM sap_pm_tenant;
