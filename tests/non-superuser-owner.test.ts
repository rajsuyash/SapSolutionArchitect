import { askFirstGap } from "./support/context-fields";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client, Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthService } from "../src/lib/auth";
import { createProjectRepository, withTenantSession } from "../src/lib/tenant";
import { createDiscoveryWorkspaceRepository } from "../src/lib/discovery-workspace";
import { createJobService } from "../src/lib/jobs";
import { createConsultantJobs } from "../src/lib/consultant-jobs";
import { createPlatformAdmin } from "../src/lib/platform-admin";
import { createStageRunner } from "../src/lib/ai/runStage";
import { parseEnvironment } from "../src/lib/env";
import type { InterviewInput } from "../src/lib/ai/discovery-interview";

// Mirrors production (Cloud SQL): the migration/runtime role is NOSUPERUSER NOBYPASSRLS CREATEROLE and owns every
// table. The rest of the suite runs as a superuser, which bypasses RLS and hid this class of bug (FORCE RLS made the
// owner's trusted, org-less connection blind: login, signup, session resolution and worker claims all saw zero rows).
describe.skipIf(process.env.RUN_DB_TESTS !== "1")("app services on a NOSUPERUSER NOBYPASSRLS owner (Cloud SQL shape)", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `sap_nso_${suffix}`, owner = `sap_nso_owner_${suffix}`;
  const base = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: base.href, connectionTimeoutMillis: 3000 });
  const ownerUrl = new URL(base.href);
  ownerUrl.pathname = `/${database}`;
  ownerUrl.username = owner;
  const pool = new Pool({ connectionString: ownerUrl.href, max: 8, statement_timeout: 10000 });
  pool.on("error", () => {});
  const queue = new PgBoss({ connectionString: ownerUrl.href });
  queue.on("error", () => {});
  const origin = "http://127.0.0.1:3017";
  const auth = createAuthService(pool, { secret: "synthetic-non-superuser-secret-for-tests-only", appUrl: origin });
  const projects = createProjectRepository(pool, auth);
  const workspaces = createDiscoveryWorkspaceRepository(pool, auth);
  const jobs = createJobService(pool, auth, queue, async () => {});
  const consultantJobs = createConsultantJobs(pool, auth, queue, async () => {});
  const config = parseEnvironment({ ...local, NODE_ENV: "test", AI_PROVIDER: "stub", PLATFORM_ADMIN_EMAILS: "ops@test.local" });
  const platformAdmin = createPlatformAdmin(pool, auth, config);
  const password = "Password123!";
  const details = { name: "Order transformation", clientName: "Acme", targetProduct: "S4HANA_CLOUD_PUBLIC", modules: ["SD"],
    problemStatement: "Our manual order processing causes delays and errors across deliveries to customers." };
  let created = false;
  let ops: Awaited<ReturnType<typeof auth.signup>>, a: Awaited<ReturnType<typeof auth.signup>>, b: Awaited<ReturnType<typeof auth.signup>>;
  const ids = {} as Record<"projA" | "projB" | "jobA" | "jobB" | "cjA" | "cjB", string>;

  const interviewRunner = (async (_stage: string, raw: unknown) => {
    const input = raw as InterviewInput;
    return { payload: { schemaVersion: 1, contextRevision: input.contextRevision, reply: "Thank you for that context.", questions: askFirstGap(input), proposedUpdates: [], observations: [] },
      metrics: { stage: "interview_turn", provider: "anthropic", model: "synthetic-test-double", inputTokens: 1, outputTokens: 1,
        latencyMs: 1, attempts: 1, validationErrors: [] } };
  }) as ReturnType<typeof createStageRunner>;
  const signal = () => new AbortController().signal;

  async function consultantEnqueue(token: string, projectId: string) {
    const initial = await workspaces.create(token, projectId, "RENTAL", { variantName: "Equipment rental", targetRelease: null }, randomUUID());
    const current = await workspaces.command(token, projectId, "RENTAL", initial.state.revision, randomUUID(),
      { type: "SEND_MESSAGE", text: "The rental coordinator tracks dispatch in a spreadsheet today." });
    return consultantJobs.enqueue(token, projectId, "RENTAL",
      { kind: "INTERVIEW", expectedRevision: current.state.revision, messageId: current.state.messages.at(-1)!.id }, randomUUID());
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE ROLE ${owner} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS`);
    // A cluster-wide tenant role left by an earlier run: let the owner grant it, as migration 0002 does.
    await admin.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sap_pm_tenant') THEN
      GRANT sap_pm_tenant TO ${owner} WITH ADMIN OPTION; END IF; END $$`);
    await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`); created = true;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/seed.ts", "--migrate-only"],
      { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: ownerUrl.href }, timeout: 30000 });
    await queue.start(); await jobs.initialize(); await consultantJobs.initialize();
  }, 60000);

  afterAll(async () => {
    await queue.stop({ graceful: true }).catch(() => {});
    await pool.end();
    try {
      if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${owner}`);
    } finally { await admin.end(); }
  }, 20000);

  it("is really a non-superuser, non-bypass owner of the tables", async () => {
    const role = (await pool.query("SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    expect(role).toEqual({ u: owner, rolsuper: false, rolbypassrls: false });
    const owners = (await pool.query(`SELECT DISTINCT pg_get_userbyid(relowner) AS o FROM pg_class
      WHERE relname IN ('organizations','users','projects','jobs','consultant_jobs')`)).rows;
    expect(owners).toEqual([{ o: owner }]);
    // RLS stays enabled everywhere (tenant isolation), but nothing is FORCEd on the owner.
    const tables = (await pool.query(`SELECT count(*) FILTER (WHERE relrowsecurity)::int AS rls,
      count(*) FILTER (WHERE relforcerowsecurity)::int AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='r' AND n.nspname IN ('public','auth')`)).rows[0];
    expect(tables.rls).toBeGreaterThanOrEqual(17);
    expect(tables.forced).toBe(0);
  });

  it("signs up, logs in and resolves a session through the owner connection", async () => {
    ops = await auth.signup({ name: "Operator", email: "ops@test.local", password, orgName: "Ops" });
    a = await auth.signup({ name: "Lead A", email: "a@test.local", password, orgName: "Org A" });
    b = await auth.signup({ name: "Lead B", email: "b@test.local", password, orgName: "Org B" });
    expect((await pool.query("SELECT count(*)::int AS n FROM organizations")).rows[0].n).toBe(3);
    const login = await auth.login({ email: "A@test.local", password });
    expect(login.user).toMatchObject({ id: a.user.id, orgId: a.user.orgId, email: "a@test.local" });
    expect(await auth.authenticate(login.token)).toMatchObject({ id: a.user.id, orgId: a.user.orgId });
    expect(await auth.authenticate(b.token)).toMatchObject({ id: b.user.id, orgId: b.user.orgId });
    await expect(auth.login({ email: "a@test.local", password: "wrong-Password1!" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect((await pool.query("SELECT last_login_at FROM users WHERE id=$1", [a.user.id])).rows[0].last_login_at).toBeInstanceOf(Date);
  });

  it("creates projects through the tenant path and enqueues + executes an analysis job on the worker connection", async () => {
    ids.projA = (await projects.create(a.token, details, randomUUID())).id;
    ids.projB = (await projects.create(b.token, details, randomUUID())).id;
    expect((await projects.list(a.token)).map((p) => p.id)).toEqual([ids.projA]);
    ids.jobA = (await jobs.enqueue(a.token, ids.projA, randomUUID())).jobId;
    ids.jobB = (await jobs.enqueue(b.token, ids.projB, randomUUID())).jobId;
    // Worker side: the org-less owner connection must see (claim) the queued job.
    expect((await pool.query("SELECT status FROM jobs WHERE id=$1", [ids.jobA])).rows).toEqual([{ status: "QUEUED" }]);
    await jobs.recover();
    expect((await pool.query("SELECT status FROM jobs WHERE id=$1", [ids.jobA])).rows).toEqual([{ status: "QUEUED" }]);
    await jobs.execute(ids.jobA, signal(), createStageRunner(config));
    await jobs.execute(ids.jobB, signal(), createStageRunner(config));
    expect((await pool.query("SELECT id,status FROM jobs ORDER BY id")).rows.map((r) => r.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect((await pool.query("SELECT count(*)::int AS n FROM problem_analyses")).rows[0].n).toBe(2);
    expect(await jobs.get(a.token, ids.jobA)).toMatchObject({ id: ids.jobA, status: "SUCCEEDED" });
  }, 30000);

  it("enqueues and executes a consultant job on the worker connection", async () => {
    ids.cjA = (await consultantEnqueue(a.token, ids.projA)).id;
    ids.cjB = (await consultantEnqueue(b.token, ids.projB)).id;
    expect((await pool.query("SELECT status FROM consultant_jobs WHERE id=$1", [ids.cjA])).rows).toEqual([{ status: "QUEUED" }]);
    await consultantJobs.execute(ids.cjA, signal(), interviewRunner);
    await consultantJobs.execute(ids.cjB, signal(), interviewRunner);
    expect((await pool.query("SELECT status,error FROM consultant_jobs ORDER BY id")).rows).toEqual([{status:"SUCCEEDED",error:null},{status:"SUCCEEDED",error:null}]);
  }, 30000);

  it("shows the platform admin every organization", async () => {
    const overview = await platformAdmin.overview(ops.token);
    expect(overview.organizations.map((o) => o.name).sort()).toEqual(["Org A", "Org B", "Ops"].sort());
    expect(overview.organizations.find((o) => o.name === "Org A")).toMatchObject({ userCount: 1, projectCount: 1, jobs30d: 2 });
    expect(overview.totals).toMatchObject({ users: 3, workspaces: 3 });
  });

  it("keeps tenants isolated from each other and read-only on organizations", async () => {
    const seen = await withTenantSession(pool, auth, a.token, async ({ client }) => {
      const col = async (sql: string) => (await client.query(sql)).rows.map((r) => r.v as string).sort();
      return { orgs: await col("SELECT name AS v FROM organizations"), users: await col("SELECT email AS v FROM users"),
        projects: await col("SELECT id AS v FROM projects"), jobs: await col("SELECT id AS v FROM jobs"),
        consultant: await col("SELECT id AS v FROM consultant_jobs") };
    });
    expect(seen).toEqual({ orgs: ["Org A"], users: ["a@test.local"], projects: [ids.projA], jobs: [ids.jobA], consultant: [ids.cjA] });
    // Cross-tenant writes: no privilege (organizations) or invisible rows (everything else); nothing changes.
    await expect(withTenantSession(pool, auth, a.token, ({ client }) =>
      client.query("UPDATE organizations SET name='Hijacked' WHERE id=$1", [b.user.orgId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenantSession(pool, auth, a.token, ({ client }) =>
      client.query("UPDATE organizations SET name='Hijacked'"))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenantSession(pool, auth, a.token, ({ client }) =>
      client.query("UPDATE projects SET name='Hijacked' WHERE id=$1", [ids.projB]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenantSession(pool, auth, a.token, ({ client }) =>
      client.query(`INSERT INTO projects(id,org_id,name,client_name,target_product,starting_landscape,setup_status,created_by)
        VALUES($1,$2,'X','C','S4HANA_CLOUD_PRIVATE','MIXED','DRAFT',$3)`, [randomUUID(), b.user.orgId, a.user.id]))).rejects.toMatchObject({ code: "42501" });
    expect((await pool.query("SELECT name FROM organizations WHERE id=$1", [b.user.orgId])).rows[0].name).toBe("Org B");
    expect((await pool.query("SELECT name FROM projects WHERE id=$1", [ids.projB])).rows[0].name).toBe("Order transformation");
  });
});
