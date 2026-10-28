import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client, Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthService } from "../src/lib/auth";
import { createProjectRepository } from "../src/lib/tenant";
import { createDiscoveryWorkspaceRepository } from "../src/lib/discovery-workspace";
import { createConsultantJobs } from "../src/lib/consultant-jobs";
import { createJobService } from "../src/lib/jobs";

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("workspace trial, suspension and daily AI quota", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const database = `sap_limits_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 10, statement_timeout: 10000 });
  pool.on("error", () => {});
  const queue = new PgBoss({ connectionString: url.href });
  queue.on("error", () => {});
  const auth = createAuthService(pool, { secret: "synthetic-limits-secret-for-tests-only-123", appUrl: "http://127.0.0.1:3017" });
  const projects = createProjectRepository(pool, auth);
  const workspaces = createDiscoveryWorkspaceRepository(pool, auth);
  const consultant = createConsultantJobs(pool, auth, queue, async () => {});
  const analysis = createJobService(pool, auth, queue, async () => {});
  let created = false;

  type Owner = Awaited<ReturnType<typeof org>>;
  const org = (set = "") => auth.signup({ name: "Limits lead", email: `limits-${randomUUID()}@test.local`,
    password: "Password123!", orgName: "Limits org" }).then(async (owner) => {
    if (set) await pool.query(`UPDATE organizations SET ${set} WHERE id=$1`, [owner.user.orgId]);
    return owner;
  });
  const project = (owner: Owner) => projects.create(owner.token, { name: "Limits", clientName: "Synthetic Rental",
    problemStatement: "Manual rental dispatch and invoice handoffs cause repeated entry, delays and reconciliation errors.",
    targetProduct: "S4HANA_CLOUD_PRIVATE", modules: ["SD"] }, randomUUID());
  const runAnalysis = async (owner: Owner) => analysis.enqueue(owner.token, (await project(owner)).id, randomUUID());
  const runConsultant = async (owner: Owner) => {
    const p = await project(owner);
    const initial = await workspaces.create(owner.token, p.id, "RENTAL", { variantName: "Equipment rental", targetRelease: null }, randomUUID());
    const sent = await workspaces.command(owner.token, p.id, "RENTAL", initial.state.revision, randomUUID(), { type: "SEND_MESSAGE", text: "Dispatch is tracked in a spreadsheet." });
    return consultant.enqueue(owner.token, p.id, "RENTAL", { kind: "INTERVIEW", expectedRevision: sent.state.revision, messageId: sent.state.messages.at(-1)!.id }, randomUUID());
  };
  const kinds = { analysis: runAnalysis, consultant: runConsultant };
  const rows = async (owner: Owner) => (await pool.query(`SELECT (SELECT count(*) FROM jobs WHERE org_id=$1)::int +
    (SELECT count(*) FROM consultant_jobs WHERE org_id=$1)::int AS n`, [owner.user.orgId])).rows[0].n as number;

  beforeAll(async () => {
    await admin.connect(); await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)("pnpm", ["db:seed"], { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
    await queue.start(); await consultant.initialize(); await analysis.initialize();
  }, 40000);
  afterAll(async () => {
    await queue.stop({ graceful: true }); await pool.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }, 15000);

  it.each(Object.entries(kinds))("refuses a suspended workspace for %s jobs and inserts nothing", async (_name, run) => {
    const owner = await org("suspended_at=now()");
    await expect(run(owner)).rejects.toMatchObject({ code: "ORG_SUSPENDED", status: 403, message: "This workspace is suspended. Contact support." });
    expect(await rows(owner)).toBe(0);
  });

  it.each(Object.entries(kinds))("refuses an expired trial for %s jobs but allows a NULL trial", async (_name, run) => {
    const expired = await org("trial_ends_at=now()-interval '1 minute'");
    await expect(run(expired)).rejects.toMatchObject({ code: "TRIAL_EXPIRED", status: 403 });
    expect(await rows(expired)).toBe(0);
    const open = await org("trial_ends_at=NULL");
    await expect(run(open)).resolves.toBeTruthy();
    const future = await org("trial_ends_at=now()+interval '1 day'");
    await expect(run(future)).resolves.toBeTruthy();
  });

  it("counts both job tables against the quota, per organization", async () => {
    const owner = await org("daily_ai_job_quota=2");
    await runAnalysis(owner); await runConsultant(owner);
    for (const run of Object.values(kinds)) {
      await expect(run(owner)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429,
        message: "Daily AI limit reached for this workspace. Try again tomorrow." });
    }
    expect(await rows(owner)).toBe(2);
    const other = await org("daily_ai_job_quota=2");
    await expect(runAnalysis(other)).resolves.toBeTruthy();
    await pool.query("UPDATE jobs SET created_at=now()-interval '25 hours' WHERE org_id=$1", [owner.user.orgId]);
    await expect(runConsultant(owner)).resolves.toBeTruthy();
  });

  // Background extraction rows are cost records of the same chat turn: copy the org's INTERVIEW row n times as EXTRACTION rows.
  const addExtractions = async (owner: Owner, n: number) => {
    const { rowCount } = await pool.query(`INSERT INTO consultant_jobs (id,org_id,project_id,variant_code,kind,input_revision,message_id,
      requested_by,request_key,request_hash,status,result,finished_at)
      SELECT gen_random_uuid(),org_id,project_id,variant_code,'EXTRACTION',input_revision,message_id,requested_by,gen_random_uuid(),request_hash,
        'SUCCEEDED','{}'::jsonb,now() FROM consultant_jobs c, generate_series(1,$2) WHERE org_id=$1 AND kind='INTERVIEW'`, [owner.user.orgId, n]);
    expect(rowCount).toBe(n);
  };

  it("does not count background EXTRACTION rows against the daily quota, but still counts INTERVIEW rows", async () => {
    const owner = await org("daily_ai_job_quota=2");
    await runConsultant(owner);
    await addExtractions(owner, 6);
    await expect(runConsultant(owner)).resolves.toBeTruthy();
    await expect(runConsultant(owner)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(await rows(owner)).toBe(8);
  });

  it("does not count EXTRACTION rows against the consultant daily cap either", async () => {
    const capped = createConsultantJobs(pool, auth, queue, async () => {}, { dailyJobLimit: 2 });
    const owner = await org("daily_ai_job_quota=100");
    const turn = async () => {
      const p = await project(owner);
      const initial = await workspaces.create(owner.token, p.id, "RENTAL", { variantName: "Equipment rental", targetRelease: null }, randomUUID());
      const sent = await workspaces.command(owner.token, p.id, "RENTAL", initial.state.revision, randomUUID(), { type: "SEND_MESSAGE", text: "Dispatch is tracked in a spreadsheet." });
      return capped.enqueue(owner.token, p.id, "RENTAL", { kind: "INTERVIEW", expectedRevision: sent.state.revision, messageId: sent.state.messages.at(-1)!.id }, randomUUID());
    };
    await turn();
    await addExtractions(owner, 6);
    await expect(turn()).resolves.toBeTruthy();
    await expect(turn()).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
  });

  it("lets exactly one of two concurrent enqueues through at quota-1", async () => {
    const owner = await org("daily_ai_job_quota=2");
    await runAnalysis(owner);
    const [a, b, c] = await Promise.all([project(owner), project(owner), project(owner)]);
    const results = await Promise.allSettled([a, b, c].map((p) => analysis.enqueue(owner.token, p.id, randomUUID())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "RATE_LIMITED" });
    expect(await rows(owner)).toBe(2);
  });
});
