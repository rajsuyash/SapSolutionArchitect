import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DENIED = { code: "42501" };
const FUNCTIONS = ["platform_admin_orgs()", "platform_admin_users()",
  "platform_admin_update_org(uuid,boolean,timestamptz,boolean,integer,boolean,boolean)"];

// The whole database is migrated and queried by a NON-superuser, NOBYPASSRLS owner role, like Cloud SQL.
// A superuser would bypass RLS and make every assertion below pass vacuously.
describe.skipIf(process.env.RUN_DB_TESTS !== "1")("platform admin SQL under a non-bypass owner", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `sap_padmin_${suffix}`, owner = `sap_owner_${suffix}`, stranger = `sap_stranger_${suffix}`;
  const base = new URL(parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8")).DATABASE_URL!);
  const admin = new Client({ connectionString: base.href, connectionTimeoutMillis: 3000 });
  const ownerUrl = new URL(base.href);
  ownerUrl.pathname = `/${database}`;
  ownerUrl.username = owner;
  const superUrl = new URL(ownerUrl.href);
  superUrl.username = base.username;
  const ownerPool = new Pool({ connectionString: ownerUrl.href, max: 4, statement_timeout: 10000 });
  const superPool = new Pool({ connectionString: superUrl.href, max: 2, statement_timeout: 10000 });
  ownerPool.on("error", () => {});
  superPool.on("error", () => {});
  const orgA = randomUUID(), orgB = randomUUID(), userA = randomUUID(), userB = randomUUID(), userB2 = randomUUID();
  const projA = randomUUID(), projB = randomUUID();
  let created = false;

  async function inTxn<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query("BEGIN"); return await work(client); }
    finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
  }
  async function asTenant<T>(work: (client: PoolClient) => Promise<T>, orgId = orgA): Promise<T> {
    return inTxn(ownerPool, async (client) => {
      await client.query("SET LOCAL ROLE sap_pm_tenant");
      await client.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true),set_config('app.org_role','ADMIN',true)",
        [orgId, userA]);
      return work(client);
    });
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE ROLE ${owner} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`CREATE ROLE ${stranger} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    // Only when an earlier run already created the cluster-wide tenant role: let the owner grant it, as the migration does.
    await admin.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sap_pm_tenant') THEN
      GRANT sap_pm_tenant TO ${owner} WITH ADMIN OPTION; END IF; END $$`);
    await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`); created = true;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/seed.ts", "--migrate-only"],
      { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: ownerUrl.href }, timeout: 30000 });
    // Fixtures are written by the superuser: the owner role itself cannot insert across tenants (that is the point).
    const q = (sql: string, params: unknown[] = []) => superPool.query(sql, params);
    await q("INSERT INTO organizations(id,name) VALUES($1,'Org A'),($2,'Org B')", [orgA, orgB]);
    for (const [id, org, email, hash] of [[userA, orgA, "a@test.local", "x"], [userB, orgB, "b@test.local", null], [userB2, orgB, "b2@test.local", "x"]]) {
      await q("INSERT INTO users(id,org_id,email,name,org_role,password_hash,last_login_at) VALUES($1,$2,$3,'N','ADMIN',$4,now())", [id, org, email, hash]);
    }
    await q("INSERT INTO auth.oauth_identities(provider,subject,user_id,email) VALUES('google','sub-b',$1,'b@test.local'),('google','sub-b2',$2,'b2@test.local')", [userB, userB2]);
    for (const [id, org, by] of [[projA, orgA, userA], [projB, orgB, userB]]) {
      await q(`INSERT INTO projects(id,org_id,name,client_name,target_product,starting_landscape,setup_status,created_by)
        VALUES($1,$2,'P','C','S4HANA_CLOUD_PRIVATE','MIXED','DRAFT',$3)`, [id, org, by]);
    }
    await q(`INSERT INTO jobs(id,org_id,project_id,kind,requested_by,request_id,status,metrics,finished_at)
      VALUES($1,$2,$3,'PROBLEM_ANALYSIS',$4,$5,'SUCCEEDED','{"inputTokens":1000,"outputTokens":200}',now())`, [randomUUID(), orgB, projB, userB, randomUUID()]);
  }, 60000);

  afterAll(async () => {
    await ownerPool.end(); await superPool.end();
    try {
      if (created) await admin.query(`DROP DATABASE ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${owner}`);
      await admin.query(`DROP ROLE IF EXISTS ${stranger}`);
    } finally { await admin.end(); }
  }, 15000);

  it("is really a non-superuser owner that cannot read tenant tables directly", async () => {
    const role = (await ownerPool.query("SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    expect(role).toEqual({ u: owner, rolsuper: false, rolbypassrls: false });
    // Negative control: without the admin functions, FORCE RLS leaves the owner blind. This is what the policies exist for.
    for (const table of ["organizations", "users", "projects", "jobs"]) {
      expect((await ownerPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
    }
  });

  it("returns cross-tenant rows and aggregates through the functions, then switches the gate off", async () => {
    await inTxn(ownerPool, async (client) => {
      const orgs = (await client.query("SELECT * FROM platform_admin_orgs()")).rows;
      expect(orgs.sort((a, b) => a.name.localeCompare(b.name)).map((o) => [o.name, o.user_count, o.project_count, o.jobs_30d, o.input_tokens_30d, o.output_tokens_30d]))
        .toEqual([["Org A", 1, 1, 0, "0", "0"], ["Org B", 2, 1, 1, "1000", "200"]]);
      const users = (await client.query("SELECT email,org_name,has_password,has_google FROM platform_admin_users()")).rows
        .sort((a, b) => (a.email < b.email ? -1 : 1));
      expect(users).toEqual([
        { email: "a@test.local", org_name: "Org A", has_password: true, has_google: false },
        { email: "b2@test.local", org_name: "Org B", has_password: true, has_google: true },
        { email: "b@test.local", org_name: "Org B", has_password: false, has_google: true }]);
      expect((await client.query("SELECT current_setting('app.platform_admin', true) AS gate")).rows[0].gate).toBe("");
      expect((await client.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(0);
    });
  });

  it("updates only the three allowed columns and reports an unknown organization as no row", async () => {
    await inTxn(ownerPool, async (client) => {
      const run = (args: unknown[]) => client.query("SELECT * FROM platform_admin_update_org($1,$2,$3,$4,$5,$6,$7)", args);
      const first = (await run([orgA, true, "2030-01-02T23:59:59.999Z", true, 25, true, true])).rows[0];
      expect(first.trial_ends_at.toISOString()).toBe("2030-01-02T23:59:59.999Z");
      expect(first).toMatchObject({ daily_ai_job_quota: 25 });
      expect(first.suspended_at).toBeInstanceOf(Date);
      const again = (await run([orgA, false, null, false, null, true, true])).rows[0];
      expect(again.suspended_at.getTime()).toBe(first.suspended_at.getTime()); // idempotent: keeps the first suspension time
      const cleared = (await run([orgA, true, null, false, null, true, false])).rows[0];
      expect(cleared).toEqual({ trial_ends_at: null, daily_ai_job_quota: 25, suspended_at: null });
      expect((await run([randomUUID(), true, null, false, null, false, null])).rowCount).toBe(0);
      await expect(run([orgA, false, null, true, 0, false, null])).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("denies the tenant role every admin function, directly and through PUBLIC", async () => {
    for (const sql of ["SELECT * FROM platform_admin_orgs()", "SELECT * FROM platform_admin_users()",
      `SELECT * FROM platform_admin_update_org('${orgA}',true,null,true,5000,true,true)`]) {
      await expect(asTenant((client) => client.query(sql)), sql).rejects.toMatchObject(DENIED);
    }
    for (const fn of FUNCTIONS) {
      const rows = (await ownerPool.query(`SELECT has_function_privilege('sap_pm_tenant', '${fn}', 'EXECUTE') AS tenant,
        has_function_privilege('${stranger}', '${fn}', 'EXECUTE') AS other,
        (SELECT proacl::text FROM pg_proc WHERE oid='${fn}'::regprocedure) AS acl`)).rows[0];
      expect(rows, fn).toMatchObject({ tenant: false, other: false });
      expect(rows.acl, fn).not.toMatch(/(^|[{,])=/); // no PUBLIC grantee entry
    }
  });

  it("gives the tenant role no new data access, even when it forges the admin GUC", async () => {
    const seen = await asTenant(async (client) => {
      await client.query("SELECT set_config('app.platform_admin','on',true)");
      const count = async (sql: string) => (await client.query(sql)).rows.map((r) => r.n);
      return { orgs: await count("SELECT name AS n FROM organizations"), users: await count("SELECT email AS n FROM users"),
        projects: await count("SELECT id AS n FROM projects"), jobs: await count("SELECT id AS n FROM jobs") };
    });
    expect(seen).toEqual({ orgs: ["Org A"], users: ["a@test.local"], projects: [projA], jobs: [] });
    await expect(asTenant((client) => client.query("SELECT trial_ends_at FROM organizations"))).rejects.toMatchObject(DENIED);
    await expect(asTenant(async (client) => {
      await client.query("SELECT set_config('app.platform_admin','on',true)");
      await client.query("UPDATE organizations SET daily_ai_job_quota=9999");
    })).rejects.toMatchObject(DENIED);
  });
});
