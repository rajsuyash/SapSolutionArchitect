import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { AuthError, transaction, type AuthService, type SessionUser } from "./auth";
import type { Environment } from "./env";

export type PlatformAdminConfig = Pick<Environment, "PLATFORM_ADMIN_EMAILS" | "AI_PRICE_INPUT_USD_PER_MTOK" | "AI_PRICE_OUTPUT_USD_PER_MTOK" | "AI_MODEL_PRICES">;
// A bare date means "through the end of that UTC day"; a full timestamp is taken as given.
const trialEnd = z.union([z.iso.date().transform((day) => `${day}T23:59:59.999Z`), z.iso.datetime({ offset: true })]);
export const orgPatchSchema = z.strictObject({
  trialEndsAt: trialEnd.nullable().optional(),
  dailyAiJobQuota: z.number().int().min(1).max(10000).optional(),
  suspended: z.boolean().optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined));
export type OrgPatch = z.infer<typeof orgPatchSchema>;

const notFound = () => new AuthError("NOT_FOUND", 404, "Route not found");
const iso = (value: Date | null) => value?.toISOString() ?? null;
/** Price tokens by the model recorded in job metrics; a model without an entry (or none recorded) uses the default prices. */
const cost = (model: string | null, input: number, output: number, config: PlatformAdminConfig) => {
  const [inputPrice, outputPrice] = (model !== null && Object.hasOwn(config.AI_MODEL_PRICES, model) ? config.AI_MODEL_PRICES[model] : undefined)
    ?? [config.AI_PRICE_INPUT_USD_PER_MTOK, config.AI_PRICE_OUTPUT_USD_PER_MTOK];
  return (input * inputPrice + output * outputPrice) / 1e6;
};

type OrgRow = { id: string; name: string; created_at: Date; trial_ends_at: Date | null; daily_ai_job_quota: number;
  suspended_at: Date | null; user_count: number; project_count: number; last_login_at: Date | null;
  jobs_24h: number; jobs_30d: number; input_tokens_30d: string; output_tokens_30d: string };
type UsageRow = { org_id: string; model: string | null; input_tokens_30d: string; output_tokens_30d: string };
type UserRow = { id: string; email: string; name: string; org_id: string; org_name: string; org_role: string;
  created_at: Date; last_login_at: Date | null; has_password: boolean; has_google: boolean };

/** Platform-operator surface. Cross-tenant data comes only from the SECURITY DEFINER functions of
 * migration 0009 (owner connection, not callable by sap_pm_tenant); authorization is the session
 * email being in PLATFORM_ADMIN_EMAILS. Anyone else gets 404 so the area is not advertised. */
export function createPlatformAdmin(pool: Pool, auth: AuthService, config: PlatformAdminConfig) {
  const admins = new Set(config.PLATFORM_ADMIN_EMAILS);
  const isAdminEmail = (email: string) => admins.has(email.trim().toLowerCase());

  async function requireAdmin(token: string | null): Promise<SessionUser> {
    const user = await auth.authenticate(token);
    if (!user) throw new AuthError("UNAUTHENTICATED", 401, "Sign in to continue");
    if (!isAdminEmail(user.email)) throw notFound();
    return user;
  }

  return {
    isAdminEmail, requireAdmin,
    async overview(token: string | null) {
      await requireAdmin(token);
      const { orgs, users, usage } = await transaction(pool, async (client) => ({
        orgs: (await client.query<OrgRow>("SELECT * FROM platform_admin_orgs()")).rows,
        usage: (await client.query<UsageRow>("SELECT * FROM platform_admin_usage_by_model()")).rows,
        users: (await client.query<UserRow>("SELECT * FROM platform_admin_users()")).rows,
      }));
      const costByOrg = new Map<string, number>();
      for (const u of usage) {
        costByOrg.set(u.org_id, (costByOrg.get(u.org_id) ?? 0) + cost(u.model, Number(u.input_tokens_30d), Number(u.output_tokens_30d), config));
      }
      const organizations = orgs.map((o) => {
        const inputTokens30d = Number(o.input_tokens_30d), outputTokens30d = Number(o.output_tokens_30d);
        return { id: o.id, name: o.name, createdAt: o.created_at.toISOString(), trialEndsAt: iso(o.trial_ends_at),
          dailyAiJobQuota: o.daily_ai_job_quota, suspendedAt: iso(o.suspended_at), userCount: o.user_count,
          projectCount: o.project_count, lastLoginAt: iso(o.last_login_at), jobsToday: o.jobs_24h, jobs30d: o.jobs_30d,
          inputTokens30d, outputTokens30d, estimatedCostUsd30d: costByOrg.get(o.id) ?? 0 };
      });
      return {
        totals: { users: users.length, workspaces: organizations.length,
          jobsToday: organizations.reduce((sum, o) => sum + o.jobsToday, 0),
          estimatedCostUsd30d: organizations.reduce((sum, o) => sum + o.estimatedCostUsd30d, 0) },
        pricing: { inputUsdPerMTok: config.AI_PRICE_INPUT_USD_PER_MTOK, outputUsdPerMTok: config.AI_PRICE_OUTPUT_USD_PER_MTOK,
          models: Object.keys(config.AI_MODEL_PRICES).length },
        organizations,
        users: users.map((u) => ({ id: u.id, email: u.email, name: u.name, orgId: u.org_id, orgName: u.org_name, orgRole: u.org_role,
          signIn: (u.has_google && u.has_password ? "both" : u.has_google ? "google" : "password") as "both" | "google" | "password",
          createdAt: iso(u.created_at), lastLoginAt: iso(u.last_login_at) })),
      };
    },
    /** `patch` is already validated (orgPatchSchema); the caller owns same-origin and body parsing. */
    async updateOrganization(admin: SessionUser, orgId: string, patch: OrgPatch) {
      if (!z.uuid().safeParse(orgId).success) throw notFound();
      const set = (value: unknown) => value !== undefined;
      const row = (await pool.query<{ trial_ends_at: Date | null; daily_ai_job_quota: number; suspended_at: Date | null }>(
        "SELECT * FROM platform_admin_update_org($1,$2,$3,$4,$5,$6,$7)",
        [orgId, set(patch.trialEndsAt), patch.trialEndsAt ?? null, set(patch.dailyAiJobQuota), patch.dailyAiJobQuota ?? null,
          set(patch.suspended), patch.suspended ?? null])).rows[0];
      if (!row) throw notFound();
      // One structured audit line per change: who (hash), what, where. No secrets or emails.
      console.info(JSON.stringify({ event: "platform_admin_change", admin: createHash("sha256").update(admin.email.toLowerCase()).digest("hex").slice(0, 16),
        orgId, changes: patch }));
      return { id: orgId, trialEndsAt: iso(row.trial_ends_at), dailyAiJobQuota: row.daily_ai_job_quota, suspendedAt: iso(row.suspended_at) };
    },
  };
}
export type PlatformAdmin = ReturnType<typeof createPlatformAdmin>;
