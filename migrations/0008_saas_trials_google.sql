-- SaaS trial/quota/suspension controls and Google sign-in identities.
-- Existing organizations keep trial_ends_at NULL (no expiry): the column is
-- added without a default, and the 14-day default is set for NEW rows only.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE organizations ALTER COLUMN trial_ends_at SET DEFAULT clock_timestamp() + interval '14 days';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS daily_ai_job_quota integer NOT NULL DEFAULT 10
  CHECK (daily_ai_job_quota BETWEEN 1 AND 10000);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_at timestamptz; -- NULL = active

-- 0001 granted table-level SELECT, which would expose every new column to the
-- tenant role. Narrow it to the original columns; trial/quota/suspension state
-- is read and written only by the trusted server connection.
REVOKE SELECT ON organizations FROM sap_pm_tenant;
GRANT SELECT(id,name,created_at) ON organizations TO sap_pm_tenant;

-- Google-only accounts have no password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Trusted auth boundary only (see 0002_auth.sql): sap_pm_tenant gets nothing here.
CREATE TABLE IF NOT EXISTS auth.oauth_identities (
  provider text NOT NULL CHECK (provider = 'google'),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS oauth_identities_user_idx ON auth.oauth_identities(user_id);
REVOKE ALL ON auth.oauth_identities FROM PUBLIC;
REVOKE ALL ON auth.oauth_identities FROM sap_pm_tenant;
