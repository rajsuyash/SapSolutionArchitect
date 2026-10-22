-- Let the trusted owner connection bypass row-level security, without superuser.
--
-- Migrations 0001-0007 declared every tenant table FORCE ROW LEVEL SECURITY. FORCE
-- subjects the table OWNER to the policies too, which was invisible while the server's
-- database user was a superuser (superusers always bypass RLS). On managed Postgres
-- (Cloud SQL) the runtime/migration role is NOSUPERUSER NOBYPASSRLS and owns the
-- tables, so every owner-connection query that runs without app.org_id (login,
-- signup, session resolution, worker job claim/execute, jobs.recover, platform admin)
-- saw zero rows or failed WITH CHECK.
--
-- Fix: NO FORCE. RLS stays ENABLED, so tenant isolation is unchanged: every tenant
-- request runs as the non-owner, NOBYPASSRLS role sap_pm_tenant (SET LOCAL ROLE in
-- withTenantSession) and is fully restricted by the policies. Only the owner's trusted
-- server connection, which never takes user-supplied SQL, bypasses them as table owner.
-- The TO CURRENT_USER platform-admin policies of 0009 become redundant for the owner
-- and are intentionally left in place.
ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE projects NO FORCE ROW LEVEL SECURITY;
ALTER TABLE project_memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE org_units NO FORCE ROW LEVEL SECURITY;
ALTER TABLE process_nodes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE document_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE blueprints NO FORCE ROW LEVEL SECURITY;
ALTER TABLE exports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sap_references NO FORCE ROW LEVEL SECURITY;
ALTER TABLE auth.sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE project_creation_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE problem_analyses NO FORCE ROW LEVEL SECURITY;
ALTER TABLE discovery_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE discovery_workspace_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE consultant_jobs NO FORCE ROW LEVEL SECURITY;
