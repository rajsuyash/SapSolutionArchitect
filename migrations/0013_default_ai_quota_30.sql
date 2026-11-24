-- A new trial workspace gets 30 AI jobs per rolling 24 hours instead of 10 (failed jobs no longer count, see src/lib/org-limits.ts).
-- Raise organizations still on the old default of 10. An organization an admin deliberately set to exactly 10 is indistinguishable
-- from one that never changed it, so it is raised too.
ALTER TABLE organizations ALTER COLUMN daily_ai_job_quota SET DEFAULT 30;
UPDATE organizations SET daily_ai_job_quota = 30 WHERE daily_ai_job_quota = 10;
