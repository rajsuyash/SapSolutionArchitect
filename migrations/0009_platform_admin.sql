-- Platform ("SaaS operator") admin: cross-tenant reads and limited organization
-- updates for the trusted server connection ONLY. No superuser or BYPASSRLS needed.
--
-- Design: every tenant table is FORCE ROW LEVEL SECURITY, so even the owning role
-- sees nothing without app.org_id. Instead of widening the tenant policies, we add
-- permissive policies that apply solely to the role running this migration (the
-- table owner, which is the server's runtime role) and only while the transaction
-- GUC app.platform_admin='on'. sap_pm_tenant is a different role, so these
-- policies never apply to it, whatever GUC it sets. The GUC is switched on and
-- off inside the SECURITY DEFINER functions below, which return exactly the
-- aggregates/rows the admin page needs and perform the only allowed writes.
-- EXECUTE is revoked from PUBLIC and sap_pm_tenant.

CREATE POLICY platform_admin_read ON organizations FOR SELECT TO CURRENT_USER
  USING (current_setting('app.platform_admin', true) = 'on');
CREATE POLICY platform_admin_update ON organizations FOR UPDATE TO CURRENT_USER
  USING (current_setting('app.platform_admin', true) = 'on')
  WITH CHECK (current_setting('app.platform_admin', true) = 'on');
CREATE POLICY platform_admin_read ON users FOR SELECT TO CURRENT_USER
  USING (current_setting('app.platform_admin', true) = 'on');
CREATE POLICY platform_admin_read ON projects FOR SELECT TO CURRENT_USER
  USING (current_setting('app.platform_admin', true) = 'on');
CREATE POLICY platform_admin_read ON jobs FOR SELECT TO CURRENT_USER
  USING (current_setting('app.platform_admin', true) = 'on');
CREATE POLICY platform_admin_read ON consultant_jobs FOR SELECT TO CURRENT_USER
  USING (current_setting('app.platform_admin', true) = 'on');

-- One row per workspace. Job counts and tokens cover both job tables; failed jobs
-- count too (they can have spent tokens). "24h" is a rolling window.
CREATE FUNCTION platform_admin_orgs() RETURNS TABLE(
  id uuid, name text, created_at timestamptz, trial_ends_at timestamptz, daily_ai_job_quota integer,
  suspended_at timestamptz, user_count integer, project_count integer, last_login_at timestamptz,
  jobs_24h integer, jobs_30d integer, input_tokens_30d bigint, output_tokens_30d bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.platform_admin', 'on', true);
  RETURN QUERY
  WITH j AS (
    SELECT org_id, created_at, metrics FROM public.jobs
    UNION ALL SELECT org_id, created_at, metrics FROM public.consultant_jobs),
  usage AS (
    SELECT org_id,
      count(*) FILTER (WHERE created_at > clock_timestamp() - interval '24 hours')::integer AS jobs_24h,
      count(*)::integer AS jobs_30d,
      coalesce(sum(CASE WHEN jsonb_typeof(metrics->'inputTokens') = 'number' THEN (metrics->>'inputTokens')::numeric END), 0)::bigint AS input_tokens_30d,
      coalesce(sum(CASE WHEN jsonb_typeof(metrics->'outputTokens') = 'number' THEN (metrics->>'outputTokens')::numeric END), 0)::bigint AS output_tokens_30d
    FROM j WHERE created_at > clock_timestamp() - interval '30 days' GROUP BY org_id)
  SELECT o.id, o.name, o.created_at, o.trial_ends_at, o.daily_ai_job_quota, o.suspended_at,
    (SELECT count(*)::integer FROM public.users u WHERE u.org_id = o.id),
    (SELECT count(*)::integer FROM public.projects p WHERE p.org_id = o.id),
    (SELECT max(u.last_login_at) FROM public.users u WHERE u.org_id = o.id),
    coalesce(s.jobs_24h, 0), coalesce(s.jobs_30d, 0), coalesce(s.input_tokens_30d, 0), coalesce(s.output_tokens_30d, 0)
  FROM public.organizations o LEFT JOIN usage s ON s.org_id = o.id
  ORDER BY o.created_at, o.id;
  PERFORM set_config('app.platform_admin', '', true);
END $$;

CREATE FUNCTION platform_admin_users() RETURNS TABLE(
  id uuid, email text, name text, org_id uuid, org_name text, org_role text,
  created_at timestamptz, last_login_at timestamptz, has_password boolean, has_google boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.platform_admin', 'on', true);
  RETURN QUERY
  SELECT u.id, u.email, u.name, u.org_id, o.name, u.org_role, u.created_at, u.last_login_at,
    u.password_hash IS NOT NULL,
    EXISTS (SELECT 1 FROM auth.oauth_identities i WHERE i.user_id = u.id AND i.provider = 'google')
  FROM public.users u JOIN public.organizations o ON o.id = u.org_id
  ORDER BY u.created_at, u.id;
  PERFORM set_config('app.platform_admin', '', true);
END $$;

-- Only these three columns can ever be changed. A NULL p_set_* flag or false leaves
-- the column alone; zero rows returned means the organization does not exist.
CREATE FUNCTION platform_admin_update_org(p_id uuid, p_set_trial boolean, p_trial timestamptz,
  p_set_quota boolean, p_quota integer, p_set_suspended boolean, p_suspended boolean)
RETURNS TABLE(trial_ends_at timestamptz, daily_ai_job_quota integer, suspended_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.platform_admin', 'on', true);
  RETURN QUERY
  WITH changed AS (
    UPDATE public.organizations o SET
      trial_ends_at = CASE WHEN coalesce(p_set_trial, false) THEN p_trial ELSE o.trial_ends_at END,
      daily_ai_job_quota = CASE WHEN coalesce(p_set_quota, false) THEN p_quota ELSE o.daily_ai_job_quota END,
      suspended_at = CASE WHEN coalesce(p_set_suspended, false)
        THEN CASE WHEN p_suspended THEN coalesce(o.suspended_at, clock_timestamp()) END ELSE o.suspended_at END
    WHERE o.id = p_id RETURNING o.trial_ends_at, o.daily_ai_job_quota, o.suspended_at)
  SELECT c.trial_ends_at, c.daily_ai_job_quota, c.suspended_at FROM changed c;
  PERFORM set_config('app.platform_admin', '', true);
END $$;

REVOKE ALL ON FUNCTION platform_admin_orgs(), platform_admin_users(),
  platform_admin_update_org(uuid, boolean, timestamptz, boolean, integer, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_admin_orgs(), platform_admin_users(),
  platform_admin_update_org(uuid, boolean, timestamptz, boolean, integer, boolean, boolean) FROM sap_pm_tenant;
