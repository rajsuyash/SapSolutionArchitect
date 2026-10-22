import type { PoolClient } from "pg";
import { AuthError } from "./auth";

type Limits = { suspended: boolean; expired: boolean; quota: number; used: number; retry: number | null };

/** Trial, suspension and daily-quota gate for every AI job enqueue. Call inside the enqueue transaction,
 * before inserting. The tenant role cannot read these organization columns (0008), so the reads run on
 * the trusted connection role, the same restoration the pg-boss insert uses, then the tenant role returns.
 * The per-org advisory lock serializes concurrent enqueues until commit, so two requests cannot both pass
 * at quota-1. The window is the rolling 24 hours the consultant limit already uses, counted across both
 * job tables. */
export async function assertOrgCanRunAi(client: PoolClient, orgId: string): Promise<void> {
  await client.query("SET LOCAL ROLE NONE");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ai-quota:${orgId}`]);
  const limits = (await client.query<Limits>(`SELECT o.suspended_at IS NOT NULL AS suspended,
    COALESCE(o.trial_ends_at<=clock_timestamp(),false) AS expired, o.daily_ai_job_quota AS quota,
    u.n AS used, u.retry FROM organizations o, LATERAL (
      SELECT count(*)::int AS n, ceil(extract(epoch FROM min(created_at)+interval '24 hours'-clock_timestamp()))::int AS retry
      FROM (SELECT created_at FROM jobs WHERE org_id=o.id UNION ALL SELECT created_at FROM consultant_jobs WHERE org_id=o.id) j
      WHERE created_at>clock_timestamp()-interval '24 hours') u WHERE o.id=$1`, [orgId])).rows[0];
  if (!limits || limits.suspended) throw new AuthError("ORG_SUSPENDED", 403, "This workspace is suspended. Contact support.");
  if (limits.expired) throw new AuthError("TRIAL_EXPIRED", 403, "Your trial has ended. Contact us to continue.");
  if (limits.used >= limits.quota) throw new AuthError("RATE_LIMITED", 429,
    "Daily AI limit reached for this workspace. Try again tomorrow.", undefined, Math.max(60, limits.retry ?? 3600));
  await client.query("SET LOCAL ROLE sap_pm_tenant");
}
