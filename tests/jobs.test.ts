import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthService } from "../src/lib/auth";
import { createProjectRepository, withTenantSession } from "../src/lib/tenant";
import { ANALYSIS_QUEUE, createJobService } from "../src/lib/jobs";
import { createStageRunner } from "../src/lib/ai/runStage";
import { parseEnvironment } from "../src/lib/env";

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("durable analysis jobs on PostgreSQL", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const database = `sap_jobs_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 8, statement_timeout: 10000 });
  const ended: Promise<void>[] = [];
  pool.on("connect", (client) => ended.push(new Promise<void>((resolve) => client.once("end", resolve))));
  pool.on("error", () => {});
  const queue = new PgBoss({ connectionString: url.href });
  queue.on("error", () => {});
  const auth = createAuthService(pool, { secret: "synthetic-job-secret-for-tests-only-123456", appUrl: "http://127.0.0.1:3017" });
  const projects = createProjectRepository(pool, auth);
  const jobs = createJobService(pool, auth, queue, async () => {});
  const config = parseEnvironment({ ...local, NODE_ENV: "test", AI_PROVIDER: "stub" });
  const runner = () => createStageRunner(config);
  const details = { name: "Order transformation", clientName: "Acme", problemStatement: "Our manual order processing causes delays and errors across deliveries to customers.", targetProduct: "S4HANA_CLOUD_PUBLIC", modules: ["SD"] };
  let created = false;
  async function actor() {
    return auth.signup({ name: "Job lead", email: `jobs-${randomUUID()}@test.local`, password: "Password123!", orgName: "Jobs test" });
  }
  async function draft() {
    const user = await actor();
    const project = await projects.create(user.token, details, randomUUID());
    return { ...user, project };
  }
  const enqueue = (owner: Awaited<ReturnType<typeof draft>>) => jobs.enqueue(owner.token, owner.project.id, randomUUID());
  const execute = (id: string, run = runner(), signal = new AbortController().signal) => jobs.execute(id, signal, run);

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)("pnpm", ["db:seed"], { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
    await queue.start(); await jobs.initialize();
  }, 40000);
  afterAll(async () => {
    await queue.stop({ graceful: true });
    await pool.end(); await Promise.all(ended);
    try { if (created) await admin.query(`DROP DATABASE ${database}`); }
    finally { await admin.end(); }
  }, 15000);

  it("serializes concurrent submissions and commits the application and queue entries together", async () => {
    const owner = await draft();
    const results = await Promise.allSettled([enqueue(owner), enqueue(owner), enqueue(owner)]);
    const successes = results.filter((result) => result.status === "fulfilled");
    expect(successes).toHaveLength(1);
    const id = successes[0]!.value.jobId;
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "JOB_ALREADY_RUNNING", jobId: id });
    expect((await queue.getJobById(ANALYSIS_QUEUE, id))?.data).toEqual({ jobId: id });
    expect(await jobs.get(owner.token, id)).toMatchObject({ id, status: "QUEUED", error: null, result: null });
    await expect(jobs.retry(owner.token, id, randomUUID())).rejects.toMatchObject({ code: "INVALID_STATE" });
    const originalSend = queue.send.bind(queue);
    let rolledBackId: string | null = null;
    const spy = vi.spyOn(queue, "send").mockImplementationOnce(async (...args: Parameters<typeof queue.send>) => {
      rolledBackId = await originalSend(...args);
      throw new Error("injected queue failure");
    });
    const second = await draft();
    try { await expect(enqueue(second)).rejects.toThrow("injected queue failure"); }
    finally { spy.mockRestore(); }
    expect(rolledBackId).toBeTruthy();
    expect(await queue.getJobById(ANALYSIS_QUEUE, rolledBackId!)).toBeNull();
    expect((await pool.query("SELECT id FROM jobs WHERE project_id=$1", [second.project.id])).rowCount).toBe(0);
    expect((await enqueue(second)).jobId).toBeTruthy();
  });

  it("blocks foreign organizations, non-members, process owners, guests, active projects and demo writes", async () => {
    const owner = await draft(); const other = await actor();
    const { jobId } = await enqueue(owner);
    await expect(jobs.get(null, jobId)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(jobs.get(other.token, jobId)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(jobs.retry(other.token, jobId, randomUUID())).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(jobs.enqueue(other.token, owner.project.id, randomUUID())).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await pool.query("UPDATE project_memberships SET project_role='PROCESS_OWNER' WHERE project_id=$1", [owner.project.id]);
    await expect(enqueue(owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await pool.query("DELETE FROM project_memberships WHERE project_id=$1", [owner.project.id]);
    await expect(enqueue(owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await pool.query("UPDATE users SET org_role='GUEST' WHERE id=$1", [owner.user.id]);
    await expect(jobs.get(owner.token, jobId)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(enqueue(owner)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    const fresh = await draft();
    await pool.query("UPDATE projects SET is_demo=true WHERE id=$1", [fresh.project.id]);
    await expect(enqueue(fresh)).rejects.toMatchObject({ code: "DEMO_READ_ONLY" });
    await pool.query("UPDATE projects SET is_demo=false,setup_status='ACTIVE' WHERE id=$1", [fresh.project.id]);
    await expect(enqueue(fresh)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("enforces queue write and result isolation in SQL, including same-org guests", async () => {
    const owner = await draft(); const other = await actor();
    const { jobId } = await enqueue(owner);
    await execute(jobId);
    await withTenantSession(pool, auth, other.token, async ({ client }) => {
      expect((await client.query("SELECT * FROM jobs WHERE id=$1", [jobId])).rowCount).toBe(0);
      expect((await client.query("SELECT * FROM problem_analyses WHERE job_id=$1", [jobId])).rowCount).toBe(0);
    });
    await expect(withTenantSession(pool, auth, owner.token, ({ client }) => client.query("UPDATE jobs SET status='FAILED' WHERE id=$1", [jobId])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(withTenantSession(pool, auth, owner.token, ({ client }) => client.query("SELECT * FROM pgboss.job")))
      .rejects.toMatchObject({ code: "42501" });
    await pool.query("UPDATE users SET org_role='GUEST' WHERE id=$1", [owner.user.id]);
    expect((await jobs.get(owner.token, jobId)).status).toBe("SUCCEEDED");
    await expect(enqueue(owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await pool.query("DELETE FROM project_memberships WHERE project_id=$1", [owner.project.id]);
    await withTenantSession(pool, auth, owner.token, async ({ client }) => {
      expect((await client.query("SELECT * FROM jobs WHERE id=$1", [jobId])).rowCount).toBe(0);
      expect((await client.query("SELECT * FROM problem_analyses WHERE job_id=$1", [jobId])).rowCount).toBe(0);
    });
  });

  it("stores one validated analysis with repair metrics and never passes identity fields to the model", async () => {
    const owner = await draft(); const { jobId } = await enqueue(owner);
    const repair = createStageRunner({ ...config, AI_FAULT_INJECTION: "problem_analysis:invalid:once" });
    const spy = vi.fn(repair);
    await Promise.all([execute(jobId, spy), execute(jobId, spy)]);
    expect(spy).toHaveBeenCalledOnce();
    const input = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["candidates", "clientName", "modules", "name", "orgUnits", "problemStatement", "startingLandscape", "targetProduct"]);
    const record = (await pool.query("SELECT metrics,result,status FROM jobs WHERE id=$1", [jobId])).rows[0];
    expect(record).toMatchObject({ status: "SUCCEEDED", metrics: { attempts: 2, stage: "problem_analysis", provider: "stub" }, result: { analysisId: expect.any(String) } });
    expect(record.metrics.validationErrors.length).toBeGreaterThan(0);
    expect((await pool.query("SELECT id FROM problem_analyses WHERE job_id=$1", [jobId])).rows).toEqual([{ id: record.result.analysisId }]);
    expect((await projects.get(owner.token, owner.project.id)).setupStatus).toBe("SCOPE_PROPOSED");
    await expect(jobs.retry(owner.token, jobId, randomUUID())).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("persists failures without scope changes and retries with a new durable job", async () => {
    const owner = await draft(); const { jobId } = await enqueue(owner);
    const fault = createStageRunner({ ...config, AI_FAULT_INJECTION: "problem_analysis:timeout:once" });
    await execute(jobId, fault);
    expect(await jobs.get(owner.token, jobId)).toMatchObject({ status: "FAILED", error: { code: "AI_TIMEOUT" }, result: null });
    expect((await projects.get(owner.token, owner.project.id)).setupStatus).toBe("DRAFT");
    const retry = await jobs.retry(owner.token, jobId, randomUUID());
    expect(retry.jobId).not.toBe(jobId);
    await execute(retry.jobId, fault);
    expect((await jobs.get(owner.token, retry.jobId)).status).toBe("SUCCEEDED");
    expect((await pool.query("SELECT retry_of FROM jobs WHERE id=$1", [retry.jobId])).rows[0].retry_of).toBe(jobId);
  });

  it("recovers a dead worker and fences its late result after a successful retry", async () => {
    const owner = await draft(); const { jobId } = await enqueue(owner);
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const real = runner();
    const old = execute(jobId, async (...args) => { entered(); await pending; return real(...args); });
    await started;
    await pool.query("UPDATE jobs SET deadline_at=now()-interval '1 second' WHERE id=$1", [jobId]);
    await jobs.recover();
    expect((await jobs.get(owner.token, jobId)).status).toBe("FAILED");
    const retry = await jobs.retry(owner.token, jobId, randomUUID());
    await execute(retry.jobId);
    release(); await old;
    expect((await pool.query("SELECT job_id FROM problem_analyses WHERE project_id=$1", [owner.project.id])).rows).toEqual([{ job_id: retry.jobId }]);
    expect((await jobs.get(owner.token, jobId)).error?.code).toBe("AI_TIMEOUT");
  });

  it("reconciles cancelled queue entries, rejects revoked authorization and sanitizes unexpected errors", async () => {
    const owner = await draft(); const { jobId } = await enqueue(owner);
    await queue.cancel(ANALYSIS_QUEUE, jobId); await jobs.recover();
    expect((await jobs.get(owner.token, jobId)).error?.code).toBe("JOB_INTERRUPTED");
    const retry = await jobs.retry(owner.token, jobId, randomUUID());
    await pool.query("UPDATE project_memberships SET project_role='PROCESS_OWNER' WHERE project_id=$1", [owner.project.id]);
    const run = vi.fn(runner());
    await execute(retry.jobId, run); expect(run).not.toHaveBeenCalled();
    expect((await jobs.get(owner.token, retry.jobId)).status).toBe("FAILED");
    const fresh = await draft(); const secretJob = await enqueue(fresh);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await execute(secretJob.jobId, async () => { throw new Error("secret-raw-provider-response"); });
      expect(JSON.stringify(await jobs.get(fresh.token, secretJob.jobId))).not.toContain("secret-raw");
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-raw");
    } finally { log.mockRestore(); }
  });

  it.each(["deadline", "cancel"])("rolls back completion when %s occurs during a database lock wait", async (mode) => {
    const owner = await draft(); const { jobId } = await enqueue(owner);
    const blocker = await pool.connect();
    const controller = new AbortController();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = runner();
    const pending = execute(jobId, async (...args) => { entered(); await gate; return real(...args); }, controller.signal);
    await started;
    await blocker.query("BEGIN");
    try {
      await blocker.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [owner.project.id]);
      if (mode === "deadline") await pool.query("UPDATE jobs SET deadline_at=clock_timestamp()+interval '1 second' WHERE id=$1", [jobId]);
      release();
      const limit = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < limit) {
        blocked = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE projects SET setup_status%'", [database])).rowCount! > 0;
        if (blocked) break;
        await delay(10);
      }
      expect(blocked).toBe(true);
      if (mode === "cancel") controller.abort();
      else {
        while ((await pool.query("SELECT deadline_at>clock_timestamp() AS pending FROM jobs WHERE id=$1", [jobId])).rows[0].pending) await delay(20);
      }
    } finally { release(); await blocker.query("ROLLBACK"); blocker.release(); }
    await pending;
    expect(await jobs.get(owner.token, jobId)).toMatchObject({ status: "FAILED", result: null,
      error: { code: mode === "deadline" ? "AI_TIMEOUT" : "AI_CANCELLED" } });
    expect((await pool.query("SELECT id FROM problem_analyses WHERE job_id=$1", [jobId])).rowCount).toBe(0);
    expect((await projects.get(owner.token, owner.project.id)).setupStatus).toBe("DRAFT");
  });
});
