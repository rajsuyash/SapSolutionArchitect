CREATE TABLE jobs (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind='PROBLEM_ANALYSIS'),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  requested_by uuid NOT NULL, request_id uuid NOT NULL, retry_of uuid,
  progress_label text NOT NULL DEFAULT 'Waiting for analysis',
  error jsonb, result jsonb, metrics jsonb,
  run_token uuid, deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(org_id,id), UNIQUE(org_id,project_id,id),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY(org_id,requested_by) REFERENCES users(org_id,id),
  FOREIGN KEY(org_id,project_id,retry_of) REFERENCES jobs(org_id,project_id,id),
  CHECK ((status='RUNNING') = (run_token IS NOT NULL AND deadline_at IS NOT NULL)),
  CHECK ((status IN ('SUCCEEDED','FAILED')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_analysis ON jobs(org_id,project_id,kind) WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX pending_analysis_recovery ON jobs(status,deadline_at) WHERE status IN ('QUEUED','RUNNING');
CREATE TABLE problem_analyses (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, job_id uuid NOT NULL UNIQUE,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,project_id,job_id) REFERENCES jobs(org_id,project_id,id)
);
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE problem_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE problem_analyses FORCE ROW LEVEL SECURITY;
CREATE POLICY job_read ON jobs FOR SELECT TO sap_pm_tenant USING (
  org_id=nullif(current_setting('app.org_id',true),'')::uuid AND
  (current_setting('app.org_role',true)<>'GUEST' OR EXISTS (SELECT 1 FROM project_memberships m
    WHERE m.org_id=jobs.org_id AND m.project_id=jobs.project_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid)));
CREATE POLICY job_enqueue ON jobs FOR INSERT TO sap_pm_tenant WITH CHECK (
  org_id=nullif(current_setting('app.org_id',true),'')::uuid AND requested_by=nullif(current_setting('app.user_id',true),'')::uuid
  AND current_setting('app.org_role',true) IN ('ADMIN','MEMBER') AND status='QUEUED'
  AND error IS NULL AND result IS NULL AND metrics IS NULL AND run_token IS NULL AND deadline_at IS NULL
  AND EXISTS (SELECT 1 FROM project_memberships m JOIN projects p ON p.org_id=m.org_id AND p.id=m.project_id
    WHERE m.org_id=jobs.org_id AND m.project_id=jobs.project_id AND m.user_id=jobs.requested_by
      AND m.project_role IN ('LEAD','CONSULTANT') AND NOT p.is_demo AND p.setup_status<>'ACTIVE'));
CREATE POLICY analysis_read ON problem_analyses FOR SELECT TO sap_pm_tenant USING (
  org_id=nullif(current_setting('app.org_id',true),'')::uuid AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=problem_analyses.job_id));
GRANT SELECT,INSERT ON jobs TO sap_pm_tenant;
GRANT SELECT ON problem_analyses TO sap_pm_tenant;
-- Completion and recovery run only in the trusted worker, never with tenant SQL privileges.
