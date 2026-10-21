-- Separate discovery work from initial project analysis. Tenant callers can
-- enqueue and read; only the trusted worker can finish a model attempt.
CREATE TABLE consultant_jobs (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL,
  variant_code text NOT NULL CHECK (variant_code ~ '^[A-Z][A-Z0-9_-]{0,39}$'),
  kind text NOT NULL CHECK (kind IN ('INTERVIEW','TO_BE')),
  input_revision integer NOT NULL CHECK (input_revision > 0),
  message_id text, snapshot_id uuid,
  requested_by uuid NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  run_token uuid, deadline_at timestamptz, error jsonb, result jsonb, metrics jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  UNIQUE (org_id,project_id,variant_code,requested_by,request_key),
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY (org_id,requested_by) REFERENCES users(org_id,id),
  FOREIGN KEY (org_id,project_id,variant_code,input_revision)
    REFERENCES discovery_workspace_revisions(org_id,project_id,variant_code,revision),
  FOREIGN KEY (snapshot_id) REFERENCES discovery_versions(id),
  CHECK ((kind='INTERVIEW' AND message_id IS NOT NULL AND snapshot_id IS NULL)
    OR (kind='TO_BE' AND message_id IS NULL AND snapshot_id IS NOT NULL)),
  CHECK ((status='RUNNING') = (run_token IS NOT NULL AND deadline_at IS NOT NULL)),
  CHECK ((status IN ('SUCCEEDED','FAILED')) = (finished_at IS NOT NULL)),
  CHECK ((status='SUCCEEDED') = (result IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_consultation ON consultant_jobs(org_id,project_id,variant_code)
  WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX consultant_recovery ON consultant_jobs(status,deadline_at) WHERE status IN ('QUEUED','RUNNING');
ALTER TABLE consultant_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultant_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY consultant_read ON consultant_jobs FOR SELECT TO sap_pm_tenant USING (
  org_id=nullif(current_setting('app.org_id',true),'')::uuid
  AND EXISTS (SELECT 1 FROM project_memberships m WHERE m.org_id=consultant_jobs.org_id
    AND m.project_id=consultant_jobs.project_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY consultant_enqueue ON consultant_jobs FOR INSERT TO sap_pm_tenant WITH CHECK (
  org_id=nullif(current_setting('app.org_id',true),'')::uuid
  AND requested_by=nullif(current_setting('app.user_id',true),'')::uuid
  AND current_setting('app.org_role',true) IN ('ADMIN','MEMBER')
  AND status='QUEUED' AND error IS NULL AND result IS NULL AND metrics IS NULL
  AND run_token IS NULL AND deadline_at IS NULL AND finished_at IS NULL
  AND EXISTS (SELECT 1 FROM project_memberships m JOIN projects p ON p.org_id=m.org_id AND p.id=m.project_id
    WHERE m.org_id=consultant_jobs.org_id AND m.project_id=consultant_jobs.project_id
      AND m.user_id=consultant_jobs.requested_by AND NOT p.is_demo
      AND (m.project_role IN ('LEAD','CONSULTANT') OR (kind='INTERVIEW' AND m.project_role='PROCESS_OWNER')))
  AND EXISTS (SELECT 1 FROM discovery_workspace_revisions w WHERE w.org_id=consultant_jobs.org_id
    AND w.project_id=consultant_jobs.project_id AND w.variant_code=consultant_jobs.variant_code
    AND w.revision=consultant_jobs.input_revision
    AND (kind='INTERVIEW' OR w.confirmed_snapshot_id=consultant_jobs.snapshot_id)));
GRANT SELECT,INSERT ON consultant_jobs TO sap_pm_tenant;
