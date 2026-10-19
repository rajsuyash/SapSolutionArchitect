-- Authentication is a trusted bootstrap boundary: it must find a user/session
-- before the tenant is known. Only the server's auth connection may access this
-- schema and bypass the user/session RLS bootstrap. Tenant repositories always
-- SET LOCAL ROLE sap_pm_tenant first. Deployment must keep this privileged
-- connection behind the auth service; it is not a general route query API.
CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
CREATE TABLE auth.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  org_id uuid NOT NULL, user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (org_id,user_id) REFERENCES public.users(org_id,id) ON DELETE CASCADE,
  CHECK (expires_at >= created_at)
);
CREATE INDEX sessions_user_idx ON auth.sessions(org_id,user_id);
CREATE INDEX sessions_expiry_idx ON auth.sessions(expires_at);
ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY session_tenant_scope ON auth.sessions
  USING (org_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id',true),'')::uuid);
CREATE TABLE auth.login_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_hash text NOT NULL CHECK (email_hash ~ '^[a-f0-9]{64}$'),
  failed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX login_failures_window_idx ON auth.login_failures(email_hash,failed_at);
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth FROM PUBLIC;

-- One capability role per PostgreSQL cluster. It owns no tables and inherits no
-- other roles. Concurrent migrations in separate temporary databases may race.
DO $$
BEGIN
  BEGIN
    CREATE ROLE sap_pm_tenant NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
      NOCREATEDB NOCREATEROLE NOREPLICATION;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sap_pm_tenant' AND
    (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='sap_pm_tenant') THEN
    RAISE EXCEPTION 'sap_pm_tenant has unsafe capabilities';
  END IF;
  EXECUTE format('GRANT sap_pm_tenant TO %I', current_user);
END;
$$;
GRANT USAGE ON SCHEMA public TO sap_pm_tenant;
-- Read-only foundation. Feature migrations grant writes only when their guarded
-- repositories exist. Credential columns and auth tables are never granted.
GRANT SELECT ON organizations,projects,project_memberships,org_units,process_nodes,
  documents,document_versions,sap_references,blueprints,exports TO sap_pm_tenant;
GRANT SELECT(id,org_id,email,name,org_role,created_at) ON users TO sap_pm_tenant;
