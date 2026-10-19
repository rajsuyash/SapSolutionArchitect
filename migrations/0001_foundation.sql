-- PostgreSQL 16. Run with scripts/seed.ts --migrate-only as the migration owner.
-- Runtime roles must be NOSUPERUSER NOBYPASSRLS. Set app.org_id locally in each
-- authenticated request transaction; never grant runtime roles the migration ledger.
CREATE TABLE organizations (
  id uuid PRIMARY KEY, name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  name text NOT NULL, password_hash text NOT NULL,
  org_role text NOT NULL CHECK (org_role IN ('ADMIN','MEMBER','GUEST')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id,id)
);
CREATE TABLE projects (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL,
  client_name text NOT NULL, problem_statement text NOT NULL DEFAULT '',
  target_product text NOT NULL CHECK (target_product IN ('S4HANA_CLOUD_PUBLIC','S4HANA_CLOUD_PRIVATE','S4HANA_ON_PREMISE')),
  starting_landscape text NOT NULL CHECK (starting_landscape IN ('NON_SAP','EXISTING_SAP','MIXED')),
  modules text[] NOT NULL DEFAULT '{}',
  setup_status text NOT NULL CHECK (setup_status IN ('DRAFT','SCOPE_PROPOSED','ACTIVE')),
  is_demo boolean NOT NULL DEFAULT false, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TABLE project_memberships (
  org_id uuid NOT NULL, project_id uuid NOT NULL, user_id uuid NOT NULL,
  project_role text NOT NULL CHECK (project_role IN ('LEAD','CONSULTANT','PROCESS_OWNER')),
  PRIMARY KEY (org_id,project_id,user_id),
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY (org_id,user_id) REFERENCES users(org_id,id)
);
CREATE INDEX memberships_user_idx ON project_memberships(org_id,user_id);
CREATE TABLE org_units (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('COMPANY_CODE','PLANT','SALES_ORG','REGION')),
  code text NOT NULL, name text NOT NULL,
  UNIQUE (org_id,project_id,type,code),
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id)
);
CREATE TABLE process_nodes (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, parent_id uuid,
  level integer NOT NULL CHECK (level BETWEEN 1 AND 4),
  parent_level integer GENERATED ALWAYS AS (level - 1) STORED,
  code text NOT NULL, name text NOT NULL, module text NOT NULL, in_scope boolean NOT NULL DEFAULT true,
  starting_point text CHECK (starting_point IN ('NON_SAP','EXISTING_SAP')),
  current_system text, process_owner_user_id uuid, consolidated_into_process_id uuid,
  CHECK ((level = 1 AND parent_id IS NULL) OR (level > 1 AND parent_id IS NOT NULL)),
  CHECK (consolidated_into_process_id IS DISTINCT FROM id),
  UNIQUE (org_id,id), UNIQUE (org_id,project_id,id), UNIQUE (org_id,project_id,id,level),
  UNIQUE (org_id,project_id,code),
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY (org_id,project_id,parent_id,parent_level) REFERENCES process_nodes(org_id,project_id,id,level),
  FOREIGN KEY (org_id,project_id,process_owner_user_id) REFERENCES project_memberships(org_id,project_id,user_id),
  FOREIGN KEY (org_id,project_id,consolidated_into_process_id) REFERENCES process_nodes(org_id,project_id,id)
);
CREATE INDEX process_parent_idx ON process_nodes(org_id,project_id,parent_id);
CREATE INDEX process_owner_idx ON process_nodes(org_id,project_id,process_owner_user_id);
CREATE INDEX process_consolidated_idx ON process_nodes(org_id,project_id,consolidated_into_process_id);
CREATE TABLE documents (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, process_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('AS_IS','GAP','TO_BE','CHANGE_DOC')),
  current_version_id uuid, UNIQUE (org_id,id), UNIQUE (org_id,process_id,type),
  FOREIGN KEY (org_id,process_id) REFERENCES process_nodes(org_id,id)
);
CREATE TABLE document_versions (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, document_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload @> '{"schemaVersion":1}'),
  upstream_version_ids jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(upstream_version_ids) = 'object'),
  created_by uuid NOT NULL, approved_by uuid, approved_at timestamptz, generated_by_job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR
    (status <> 'APPROVED' AND approved_by IS NULL AND approved_at IS NULL)),
  UNIQUE (org_id,id), UNIQUE (org_id,document_id,id), UNIQUE (org_id,document_id,version_no),
  FOREIGN KEY (org_id,document_id) REFERENCES documents(org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES users(org_id,id),
  FOREIGN KEY (org_id,approved_by) REFERENCES users(org_id,id)
);
ALTER TABLE documents ADD CONSTRAINT current_version_belongs_to_document
  FOREIGN KEY (org_id,id,current_version_id) REFERENCES document_versions(org_id,document_id,id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX versions_creator_idx ON document_versions(org_id,created_by);
CREATE INDEX versions_approver_idx ON document_versions(org_id,approved_by);
CREATE TABLE sap_references (
  id uuid PRIMARY KEY, org_id uuid REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('SCOPE_ITEM','TCODE','FIORI_APP','IMG_ACTIVITY','TABLE','BUSINESS_ROLE')),
  code text NOT NULL CHECK (code = upper(btrim(code)) AND length(code) > 0),
  title text NOT NULL, module text NOT NULL, target_products text[] NOT NULL,
  summary text NOT NULL, source_note text NOT NULL, created_by uuid,
  CHECK (cardinality(target_products) > 0 AND array_position(target_products,NULL) IS NULL AND
    target_products <@ ARRAY['S4HANA_CLOUD_PUBLIC','S4HANA_CLOUD_PRIVATE','S4HANA_ON_PREMISE']::text[]),
  CHECK (org_id IS NOT NULL OR created_by IS NULL),
  UNIQUE NULLS NOT DISTINCT (org_id,kind,code),
  FOREIGN KEY (org_id,created_by) REFERENCES users(org_id,id)
);
CREATE INDEX references_creator_idx ON sap_references(org_id,created_by);
CREATE TABLE blueprints (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0), status text NOT NULL CHECK (status IN ('FINAL','DRAFT')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload @> '{"schemaVersion":1}'),
  included_change_doc_version_ids uuid[] NOT NULL DEFAULT '{}',
  excluded_process_ids uuid[] NOT NULL DEFAULT '{}', unverified_ref_count integer NOT NULL DEFAULT 0 CHECK (unverified_ref_count >= 0),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id), UNIQUE (org_id,project_id,version_no),
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES users(org_id,id)
);
CREATE INDEX blueprints_creator_idx ON blueprints(org_id,created_by);
CREATE TABLE exports (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, blueprint_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('DOCX','PDF')),
  status text NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  storage_key text, error text, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'SUCCEEDED' AND storage_key IS NOT NULL AND error IS NULL) OR
    (status = 'FAILED' AND storage_key IS NULL AND error IS NOT NULL) OR
    (status IN ('PENDING','RUNNING') AND storage_key IS NULL AND error IS NULL)),
  FOREIGN KEY (org_id,blueprint_id) REFERENCES blueprints(org_id,id)
);
CREATE INDEX exports_blueprint_idx ON exports(org_id,blueprint_id);
CREATE INDEX projects_creator_idx ON projects(org_id,created_by);

CREATE FUNCTION protect_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'blueprints' OR OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'Snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_approved_version BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION protect_snapshot();
CREATE TRIGGER immutable_blueprint BEFORE UPDATE OR DELETE ON blueprints
  FOR EACH ROW EXECUTE FUNCTION protect_snapshot();

-- Business payload schemas, upstream lineage and leaf/consolidation rules are
-- validated in the document/workflow repositories introduced in later phases.
-- FORCE also protects the table owner; PostgreSQL superusers still bypass RLS.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['organizations','users','projects','project_memberships',
    'org_units','process_nodes','documents','document_versions','blueprints','exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (%I = nullif(current_setting(''app.org_id'', true), '''')::uuid)
      WITH CHECK (%I = nullif(current_setting(''app.org_id'', true), '''')::uuid)',
      table_name, CASE WHEN table_name = 'organizations' THEN 'id' ELSE 'org_id' END,
      CASE WHEN table_name = 'organizations' THEN 'id' ELSE 'org_id' END);
  END LOOP;
END;
$$;
ALTER TABLE sap_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE sap_references FORCE ROW LEVEL SECURITY;
CREATE POLICY reference_read ON sap_references FOR SELECT
  USING (org_id IS NULL OR org_id = nullif(current_setting('app.org_id',true),'')::uuid);
CREATE POLICY reference_insert ON sap_references FOR INSERT
  WITH CHECK (org_id = nullif(current_setting('app.org_id',true),'')::uuid);
CREATE POLICY reference_update ON sap_references FOR UPDATE
  USING (org_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id',true),'')::uuid);
CREATE POLICY reference_delete ON sap_references FOR DELETE
  USING (org_id = nullif(current_setting('app.org_id',true),'')::uuid);
