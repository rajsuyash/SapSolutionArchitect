import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthService } from "../src/lib/auth";
import { parseEnvironment } from "../src/lib/env";
import { createPlatformAdmin } from "../src/lib/platform-admin";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const FLASH = "XiaomiMiMo/MiMo-V2.6-Flash", PRO = "XiaomiMiMo/MiMo-V2.6-Pro";
const prices = JSON.stringify({ [FLASH]: [0.14, 0.28], [PRO]: [0.43, 0.87] });
const envFor = (extra: Record<string, string> = {}) => parseEnvironment({ ...local, NODE_ENV: "test", AI_PROVIDER: "stub",
  PLATFORM_ADMIN_EMAILS: "admin@test.local", AI_MODEL_PRICES: prices, ...extra });

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("admin cost estimate prices tokens by the model recorded in job metrics", () => {
  const database = `sap_padmin_model_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 4, statement_timeout: 10000 });
  pool.on("error", () => {});
  const auth = createAuthService(pool, { secret: "synthetic-platform-admin-secret-for-tests-only", appUrl: "http://127.0.0.1:3017" });
  let created = false;
  let token: string, alpha: string, beta: string;

  async function job(orgId: string, projectId: string, userId: string, metrics: object | null, ago = "1 hour") {
    await pool.query(`INSERT INTO jobs(id,org_id,project_id,kind,requested_by,request_id,status,metrics,created_at,finished_at)
      VALUES($1,$2,$3,'PROBLEM_ANALYSIS',$4,$5,'SUCCEEDED',$6,now()-$7::interval,now())`,
    [randomUUID(), orgId, projectId, userId, randomUUID(), metrics, ago]);
  }
  const usage = (model: string | null, inputTokens = 1_000_000, outputTokens = 1_000_000) =>
    ({ stage: "problem_analysis", provider: "deepinfra", ...(model ? { model } : {}), inputTokens, outputTokens, latencyMs: 1, attempts: 1, validationErrors: [] });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/seed.ts", "--migrate-only"],
      { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
    const a = await auth.signup({ name: "Operator", email: "admin@test.local", password: "Password123!", orgName: "Alpha" });
    const b = await auth.signup({ name: "Other", email: "other@test.local", password: "Password123!", orgName: "Beta" });
    token = a.token; alpha = a.user.orgId; beta = b.user.orgId;
    const project = async (org: string, user: string) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO projects(id,org_id,name,client_name,target_product,starting_landscape,setup_status,created_by)
        VALUES($1,$2,'P','C','S4HANA_CLOUD_PRIVATE','MIXED','DRAFT',$3)`, [id, org, user]);
      return id;
    };
    const pa = await project(alpha, a.user.id), pb = await project(beta, b.user.id);
    await job(alpha, pa, a.user.id, usage(FLASH));
    await job(alpha, pa, a.user.id, usage(PRO));
    await job(alpha, pa, a.user.id, usage(PRO, 9_000_000, 9_000_000), "40 days"); // outside the 30-day window
    await job(beta, pb, b.user.id, usage(null));                  // metrics predate model recording
    await job(beta, pb, b.user.id, usage("some/unpriced-model", 1_000_000, 0));
    await job(beta, pb, b.user.id, null);                         // failed job without metrics
  }, 60000);

  afterAll(async () => {
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }, 15000);

  it("sums per-model prices, and falls back to the default prices for legacy and unpriced models", async () => {
    const { organizations, totals, pricing } = await createPlatformAdmin(pool, auth, envFor()).overview(token);
    const byId = Object.fromEntries(organizations.map((o) => [o.id, o]));
    // Alpha: Flash 1M/1M = 0.14 + 0.28; Pro 1M/1M = 0.43 + 0.87.
    expect(byId[alpha]!.estimatedCostUsd30d).toBeCloseTo(1.72, 9);
    expect(byId[alpha]).toMatchObject({ jobs30d: 2, inputTokens30d: 2_000_000, outputTokens30d: 2_000_000 });
    // Beta at the default $2 / $10: legacy 1M/1M = 12, unpriced model 1M/0 = 2.
    expect(byId[beta]!.estimatedCostUsd30d).toBeCloseTo(14, 9);
    expect(byId[beta]).toMatchObject({ jobs30d: 3, inputTokens30d: 2_000_000, outputTokens30d: 1_000_000 });
    expect(totals.estimatedCostUsd30d).toBeCloseTo(15.72, 9);
    expect(pricing).toEqual({ inputUsdPerMTok: 2, outputUsdPerMTok: 10, models: 2 });
  });

  it("is identical to the single-rate estimate when no model prices are configured", async () => {
    const { organizations } = await createPlatformAdmin(pool, auth, envFor({ AI_MODEL_PRICES: "" })).overview(token);
    const byId = Object.fromEntries(organizations.map((o) => [o.id, o]));
    expect(byId[alpha]!.estimatedCostUsd30d).toBeCloseTo(24, 9); // 2M in * 2 + 2M out * 10
    expect(byId[beta]!.estimatedCostUsd30d).toBeCloseTo(14, 9);
  });
});
