-- Each interview edit is a complete, immutable state revision. The confirmed
-- discovery snapshot is a separate immutable 0005 artifact pinned by revision.
ALTER TABLE discovery_versions ADD CONSTRAINT discovery_snapshot_workspace_identity
  UNIQUE (org_id,project_id,variant_code,id);
CREATE TABLE discovery_workspace_revisions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  variant_code text NOT NULL CHECK (variant_code ~ '^[A-Z][A-Z0-9_-]{0,39}$'),
  revision integer NOT NULL CHECK (revision > 0),
  operation text NOT NULL CHECK (operation IN ('CREATE','COMMAND','TURN','CONFIRM')),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_snapshot_id uuid,
  UNIQUE (org_id,project_id,variant_code,revision),
  UNIQUE (org_id,project_id,variant_code,created_by,request_key),
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES users(org_id,id),
  FOREIGN KEY (org_id,project_id,variant_code,confirmed_snapshot_id)
    REFERENCES discovery_versions(org_id,project_id,variant_code,id),
  CHECK (operation <> 'CONFIRM' OR confirmed_snapshot_id IS NOT NULL),
  CHECK (confirmed_snapshot_id IS NULL OR (state ? 'confirmation' AND state->'confirmation' <> 'null'::jsonb))
);
CREATE INDEX discovery_workspace_actor_idx ON discovery_workspace_revisions(org_id,created_by);
ALTER TABLE discovery_workspace_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_workspace_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_workspace_read ON discovery_workspace_revisions FOR SELECT TO sap_pm_tenant
  USING (org_id = nullif(current_setting('app.org_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM project_memberships m
      WHERE m.org_id=discovery_workspace_revisions.org_id
        AND m.project_id=discovery_workspace_revisions.project_id
        AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY discovery_workspace_insert ON discovery_workspace_revisions FOR INSERT TO sap_pm_tenant
  WITH CHECK (org_id = nullif(current_setting('app.org_id',true),'')::uuid
    AND created_by = nullif(current_setting('app.user_id',true),'')::uuid
    AND current_setting('app.org_role',true) IN ('ADMIN','MEMBER')
    AND EXISTS (SELECT 1 FROM project_memberships m JOIN projects p
      ON p.org_id=m.org_id AND p.id=m.project_id
      JOIN users u ON u.org_id=m.org_id AND u.id=m.user_id
      WHERE m.org_id=discovery_workspace_revisions.org_id
        AND m.project_id=discovery_workspace_revisions.project_id
        AND m.user_id=discovery_workspace_revisions.created_by
        AND m.project_role IN ('LEAD','CONSULTANT','PROCESS_OWNER')
        AND u.org_role IN ('ADMIN','MEMBER') AND NOT p.is_demo
        AND (discovery_workspace_revisions.operation <> 'CONFIRM'
          OR m.project_role IN ('LEAD','CONSULTANT'))));
GRANT SELECT,INSERT ON discovery_workspace_revisions TO sap_pm_tenant;

CREATE FUNCTION protect_discovery_workspace_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Discovery workspace revision is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER immutable_discovery_workspace_revision
  BEFORE UPDATE OR DELETE ON discovery_workspace_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_discovery_workspace_revision();

-- A process owner's edit may only carry the previous revision's confirmation forward unchanged; it can never
-- introduce one. A trigger, not a policy: a policy that reads its own table recurses. Runs as the caller, so RLS still applies.
CREATE FUNCTION guard_discovery_workspace_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation = 'CONFIRM' OR (NEW.confirmed_snapshot_id IS NULL
    AND coalesce(NEW.state->'confirmation','null'::jsonb) = 'null'::jsonb) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM project_memberships m WHERE m.org_id=NEW.org_id AND m.project_id=NEW.project_id
      AND m.user_id=NEW.created_by AND m.project_role IN ('LEAD','CONSULTANT'))
    OR EXISTS (SELECT 1 FROM discovery_workspace_revisions prev WHERE prev.org_id=NEW.org_id
      AND prev.project_id=NEW.project_id AND prev.variant_code=NEW.variant_code AND prev.revision=NEW.revision-1
      AND prev.confirmed_snapshot_id IS NOT DISTINCT FROM NEW.confirmed_snapshot_id
      AND prev.state->'confirmation' IS NOT DISTINCT FROM NEW.state->'confirmation') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Only a lead or consultant can confirm discovery' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER guard_discovery_workspace_confirmation
  BEFORE INSERT ON discovery_workspace_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_discovery_workspace_confirmation();
