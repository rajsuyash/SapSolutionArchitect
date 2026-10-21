-- Raw discovery inputs are distinct from generated/approved AS_IS documents.
-- Every save is an immutable snapshot; never turn user-supplied evidence into
-- an approved decision or verified SAP reference.
CREATE TABLE discovery_versions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  variant_code text NOT NULL CHECK (variant_code ~ '^[A-Z][A-Z0-9_-]{0,39}$'),
  version_no integer NOT NULL CHECK (version_no > 0),
  target_product text NOT NULL CHECK (target_product IN
    ('S4HANA_CLOUD_PUBLIC','S4HANA_CLOUD_PRIVATE','S4HANA_ON_PREMISE')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload @> '{"schemaVersion":1}'),
  source_digests jsonb NOT NULL CHECK (jsonb_typeof(source_digests) = 'object'),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,project_id,variant_code,version_no),
  UNIQUE (org_id,project_id,variant_code,created_by,request_key),
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES users(org_id,id)
);
ALTER TABLE discovery_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_read ON discovery_versions FOR SELECT TO sap_pm_tenant
  USING (org_id = nullif(current_setting('app.org_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM project_memberships m
      WHERE m.org_id=discovery_versions.org_id AND m.project_id=discovery_versions.project_id
      AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY discovery_write ON discovery_versions FOR INSERT TO sap_pm_tenant
  WITH CHECK (org_id = nullif(current_setting('app.org_id',true),'')::uuid
    AND created_by = nullif(current_setting('app.user_id',true),'')::uuid
    AND current_setting('app.org_role',true) IN ('ADMIN','MEMBER')
    AND EXISTS (SELECT 1 FROM project_memberships m JOIN projects p
      ON p.org_id=m.org_id AND p.id=m.project_id
      WHERE m.org_id=discovery_versions.org_id AND m.project_id=discovery_versions.project_id
      AND m.user_id=discovery_versions.created_by AND m.project_role IN ('LEAD','CONSULTANT')
      AND NOT p.is_demo AND p.target_product=discovery_versions.target_product));
GRANT SELECT,INSERT ON discovery_versions TO sap_pm_tenant;

CREATE FUNCTION protect_discovery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Discovery snapshot is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER immutable_discovery BEFORE UPDATE OR DELETE ON discovery_versions
  FOR EACH ROW EXECUTE FUNCTION protect_discovery_snapshot();
