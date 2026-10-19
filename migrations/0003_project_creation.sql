-- Durable create-request identity is scoped to the authenticated actor and org.
-- Requests are retained with the project so a delayed retry cannot duplicate it.
CREATE TABLE project_creation_requests (
  org_id uuid NOT NULL, user_id uuid NOT NULL, request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'), project_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id,user_id,request_key),
  FOREIGN KEY (org_id,user_id) REFERENCES users(org_id,id),
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id)
);
ALTER TABLE project_creation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_creation_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY creation_actor_scope ON project_creation_requests TO sap_pm_tenant
  USING (org_id=nullif(current_setting('app.org_id',true),'')::uuid
    AND user_id=nullif(current_setting('app.user_id',true),'')::uuid
    AND current_setting('app.org_role',true) IN ('ADMIN','MEMBER'))
  WITH CHECK (org_id=nullif(current_setting('app.org_id',true),'')::uuid
    AND user_id=nullif(current_setting('app.user_id',true),'')::uuid
    AND current_setting('app.org_role',true) IN ('ADMIN','MEMBER'));
GRANT SELECT,INSERT ON project_creation_requests TO sap_pm_tenant;
GRANT INSERT ON projects,project_memberships,org_units TO sap_pm_tenant;

-- Existing tenant policies are permissive. These additional restrictive policies
-- narrow only the new INSERT capability; future edit/invite flows need new grants.
CREATE POLICY project_create_actor ON projects AS RESTRICTIVE FOR INSERT TO sap_pm_tenant
  WITH CHECK (created_by=nullif(current_setting('app.user_id',true),'')::uuid
    AND current_setting('app.org_role',true) IN ('ADMIN','MEMBER') AND setup_status='DRAFT' AND NOT is_demo);
CREATE POLICY creator_membership ON project_memberships AS RESTRICTIVE FOR INSERT TO sap_pm_tenant
  WITH CHECK (user_id=nullif(current_setting('app.user_id',true),'')::uuid AND project_role='LEAD'
    AND current_setting('app.org_role',true) IN ('ADMIN','MEMBER')
    AND EXISTS (SELECT 1 FROM projects p WHERE p.org_id=project_memberships.org_id
      AND p.id=project_memberships.project_id AND p.created_by=project_memberships.user_id));
CREATE POLICY creator_units ON org_units AS RESTRICTIVE FOR INSERT TO sap_pm_tenant
  WITH CHECK (current_setting('app.org_role',true) IN ('ADMIN','MEMBER')
    AND type IN ('COMPANY_CODE','PLANT','SALES_ORG','REGION')
    AND EXISTS (SELECT 1 FROM projects p WHERE p.org_id=org_units.org_id AND p.id=org_units.project_id
      AND p.created_by=nullif(current_setting('app.user_id',true),'')::uuid));
