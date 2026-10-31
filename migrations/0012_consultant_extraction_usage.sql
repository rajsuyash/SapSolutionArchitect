-- Background extraction (one model call per interview message) is billable work that no chat or To-Be job row recorded.
-- Record each completed extraction as a terminal consultant_jobs row so the per-org daily job limit (which counts this table)
-- and the platform-admin cost views (platform_admin_orgs, platform_admin_usage_by_model, which sum consultant_jobs.metrics)
-- see it without changing either. Rows are written by the trusted worker only, always SUCCEEDED, so they never take the
-- workspace's one_pending_consultation slot; the tenant INSERT policy (status='QUEUED') already refuses them.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'consultant_jobs'::regclass AND contype = 'c'
    AND (pg_get_constraintdef(oid) LIKE '%''TO_BE''%') LOOP
    EXECUTE format('ALTER TABLE consultant_jobs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE consultant_jobs
  ADD CONSTRAINT consultant_jobs_kind_check CHECK (kind IN ('INTERVIEW','TO_BE','EXTRACTION')),
  ADD CONSTRAINT consultant_jobs_kind_shape CHECK (
    (kind IN ('INTERVIEW','EXTRACTION') AND message_id IS NOT NULL AND snapshot_id IS NULL)
    OR (kind='TO_BE' AND message_id IS NULL AND snapshot_id IS NOT NULL)),
  ADD CONSTRAINT consultant_jobs_extraction_terminal CHECK (kind <> 'EXTRACTION' OR status = 'SUCCEEDED');
