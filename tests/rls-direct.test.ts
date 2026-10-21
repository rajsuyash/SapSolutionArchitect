import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Session = { orgId: string; userId: string; orgRole: string };
const HASH = "a".repeat(64);
const DENIED = { code: "42501" };

// Raw SQL against the tenant role, exactly as withTenantSession (src/lib/tenant.ts) sets the session:
// SET LOCAL ROLE sap_pm_tenant, then set_config(app.org_id/app.user_id/app.org_role, ..., true).
// Every call runs in its own transaction that is always rolled back, so rows never leak between cases.
describe.skipIf(process.env.RUN_DB_TESTS !== "1")("direct RLS and grants for discovery tables", () => {
  const database = `sap_rls_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8")).DATABASE_URL!);
  const admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 4, statement_timeout: 10000 });
  pool.on("error", () => {});
  let created = false;

  const id = () => randomUUID();
  const orgA = id(), orgB = id();
  const u = { lead: id(), consultant: id(), owner: id(), guest: id(), outsider: id(), leadB: id() };
  const projA = id(), projDemo = id(), projB = id();
  const doneJob = id(), snapA = id(), rev1 = id(), rev2 = id(), demoRev1 = id();
  const sess = (orgId: string, userId: string, orgRole: string): Session => ({ orgId, userId, orgRole });
  const as = {
    lead: sess(orgA, u.lead, "ADMIN"), consultant: sess(orgA, u.consultant, "MEMBER"), owner: sess(orgA, u.owner, "MEMBER"),
    guest: sess(orgA, u.guest, "GUEST"), outsider: sess(orgA, u.outsider, "MEMBER"), leadB: sess(orgB, u.leadB, "ADMIN"),
  };

  async function tenant<T>(s: Session, work: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE sap_pm_tenant");
      await c.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true),set_config('app.org_role',$3,true)",
        [s.orgId, s.userId, s.orgRole]);
      return await work(c);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  }
  const count = (s: Session, table: string, where = "true") =>
    tenant(s, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n as number);
  const exec = (s: Session, sql: string, params: unknown[] = []) => tenant(s, (c) => c.query(sql, params));

  // ---- row builders: each returns a VALID insert for `session`; tests vary exactly one factor ----
  const revisionSql = `INSERT INTO discovery_workspace_revisions(id,org_id,project_id,variant_code,revision,operation,state,
    request_key,request_hash,created_by,confirmed_snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
  const revision = (o: Partial<{ org: string; project: string; variant: string; revision: number; operation: string; state: object;
    by: string; snapshot: string | null }> = {}) => [id(), o.org ?? orgA, o.project ?? projA, o.variant ?? "V1", o.revision ?? 3,
    o.operation ?? "COMMAND", JSON.stringify(o.state ?? { confirmation: null }), id(), HASH, o.by ?? u.consultant, o.snapshot ?? null];
  const versionSql = `INSERT INTO discovery_versions(id,org_id,project_id,variant_code,version_no,target_product,payload,source_digests,
    request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'{}',$8,$9,$10)`;
  const version = (o: Partial<{ org: string; project: string; product: string; by: string }> = {}) => [id(), o.org ?? orgA,
    o.project ?? projA, "V1", 2, o.product ?? "S4HANA_CLOUD_PRIVATE", '{"schemaVersion":1}', id(), HASH, o.by ?? u.consultant];
  const jobSql = `INSERT INTO consultant_jobs(id,org_id,project_id,variant_code,kind,input_revision,message_id,snapshot_id,
    requested_by,request_key,request_hash,status,run_token,deadline_at,error,result,metrics,finished_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`;
  const job = (o: Partial<{ org: string; project: string; kind: string; revision: number; snapshot: string | null; by: string;
    status: string; token: string | null; deadline: string | null; error: object | null; result: object | null; metrics: object | null;
    finished: string | null; variant: string }> = {}) => {
    const kind = o.kind ?? "INTERVIEW";
    const j = (v: object | null | undefined) => (v ? JSON.stringify(v) : null);
    return [id(), o.org ?? orgA, o.project ?? projA, o.variant ?? "V1", kind, o.revision ?? 1,
      kind === "INTERVIEW" ? "msg-1" : null, kind === "TO_BE" ? (o.snapshot === undefined ? snapA : o.snapshot) : null,
      o.by ?? u.consultant, id(), HASH, o.status ?? "QUEUED", o.token ?? null, o.deadline ?? null, j(o.error), j(o.result), j(o.metrics),
      o.finished ?? null];
  };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/seed.ts", "--migrate-only"],
      { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
    // Privileged fixtures (the pool connects as the migration owner/superuser; tenant access goes through tenant()).
    const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
    await q("INSERT INTO organizations(id,name) VALUES($1,'Org A'),($2,'Org B')", [orgA, orgB]);
    for (const [uid, org, role] of [[u.lead, orgA, "ADMIN"], [u.consultant, orgA, "MEMBER"], [u.owner, orgA, "MEMBER"],
      [u.guest, orgA, "GUEST"], [u.outsider, orgA, "MEMBER"], [u.leadB, orgB, "ADMIN"]]) {
      await q("INSERT INTO users(id,org_id,email,name,org_role,password_hash) VALUES($1,$2,$3,'Synthetic',$4,'x')",
        [uid, org, `${uid}@test.local`, role]);
    }
    for (const [pid, org, demo, by] of [[projA, orgA, false, u.lead], [projDemo, orgA, true, u.lead], [projB, orgB, false, u.leadB]] as const) {
      await q(`INSERT INTO projects(id,org_id,name,client_name,target_product,starting_landscape,setup_status,is_demo,created_by)
        VALUES($1,$2,'P','C','S4HANA_CLOUD_PRIVATE','MIXED','DRAFT',$3,$4)`, [pid, org, demo, by]);
    }
    // outsider is an org MEMBER with no project membership at all.
    for (const [pid, uid, role] of [[projA, u.lead, "LEAD"], [projA, u.consultant, "CONSULTANT"], [projA, u.owner, "PROCESS_OWNER"],
      [projA, u.guest, "PROCESS_OWNER"], [projDemo, u.lead, "LEAD"], [projDemo, u.consultant, "CONSULTANT"], [projB, u.leadB, "LEAD"]]) {
      await q("INSERT INTO project_memberships(org_id,project_id,user_id,project_role) VALUES($1,$2,$3,$4)",
        [pid === projB ? orgB : orgA, pid, uid, role]);
    }
    const state = JSON.stringify({ confirmation: { by: u.lead } });
    await q(revisionSql, [rev1, orgA, projA, "V1", 1, "CREATE", '{"confirmation":null}', id(), HASH, u.lead, null]);
    await q(revisionSql, [demoRev1, orgA, projDemo, "V1", 1, "CREATE", '{"confirmation":null}', id(), HASH, u.lead, null]);
    await q(revisionSql, [id(), orgB, projB, "V1", 1, "CREATE", '{"confirmation":null}', id(), HASH, u.leadB, null]);
    await q(versionSql, [snapA, orgA, projA, "V1", 1, "S4HANA_CLOUD_PRIVATE", '{"schemaVersion":1}', id(), HASH, u.lead]);
    await q(revisionSql, [rev2, orgA, projA, "V1", 2, "CONFIRM", state, id(), HASH, u.lead, snapA]);
    await q(jobSql, job({ org: orgB, project: projB, by: u.leadB }));
    // Finished (non-pending) org A job: visible to SELECT checks without tripping one_pending_consultation for enqueue controls.
    await q(jobSql, [doneJob, ...job({ status: "SUCCEEDED", result: { ok: true }, finished: "2026-01-01T00:00:00Z", by: u.lead }).slice(1)]);
    await q(versionSql, [id(), orgB, projB, "V1", 1, "S4HANA_CLOUD_PRIVATE", '{"schemaVersion":1}', id(), HASH, u.leadB]);
  }, 40000);
  afterAll(async () => {
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); }
    finally { await admin.end(); }
  }, 15000);

  it("runs as an unprivileged role: the fixture session really is sap_pm_tenant", async () => {
    const r = await tenant(as.lead, async (c) => (await c.query(
      "SELECT current_user AS u, current_setting('app.org_id') AS org, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS priv")).rows[0]);
    expect(r).toEqual({ u: "sap_pm_tenant", org: orgA, priv: false });
  });

  describe("discovery_workspace_revisions", () => {
    const t = "discovery_workspace_revisions";
    it("scopes SELECT to the caller's org and project membership", async () => {
      expect(await count(as.lead, t)).toBe(3); // projA rev1+rev2, demo rev1 - org B row hidden
      expect(await count(as.leadB, t)).toBe(1);
      expect(await count(as.leadB, t, `project_id='${projA}'`)).toBe(0);
      expect(await count(as.outsider, t)).toBe(0);
      expect(await count(as.guest, t, `project_id='${projA}'`)).toBe(2); // members read, whatever their org role
    });
    it("accepts valid LEAD/CONSULTANT/PROCESS_OWNER edits (positive controls)", async () => {
      for (const who of [as.consultant, as.owner]) expect((await exec(who, revisionSql, revision({ by: who.userId }))).rowCount).toBe(1);
      expect((await exec(as.consultant, revisionSql, revision({ operation: "CONFIRM", snapshot: snapA, state: { confirmation: { by: u.consultant } } }))).rowCount).toBe(1);
    });
    it("rejects a foreign org_id, a spoofed author, non-members, guests and demo projects", async () => {
      await expect(exec(as.leadB, revisionSql, revision({ org: orgA, by: u.leadB }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.leadB, revisionSql, revision({ org: orgB, project: projA, by: u.leadB }))).rejects.toMatchObject(DENIED); // RLS fires before the FK
      await expect(exec(as.consultant, revisionSql, revision({ by: u.lead }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.outsider, revisionSql, revision({ by: u.outsider }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.guest, revisionSql, revision({ by: u.guest }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.consultant, revisionSql, revision({ project: projDemo }))).rejects.toMatchObject(DENIED);
    });
    it("denies PROCESS_OWNER a CONFIRM revision", async () => {
      const confirm = { operation: "CONFIRM", snapshot: snapA, state: { confirmation: { by: u.owner } }, by: u.owner };
      await expect(exec(as.owner, revisionSql, revision(confirm))).rejects.toMatchObject(DENIED);
    });
    // A PROCESS_OWNER edit may only carry the previous revision's confirmation forward unchanged; it can never introduce one.
    it("PROCESS_OWNER cannot write a new confirmation under operation COMMAND, but may carry the existing one forward", async () => {
      const sneaky = { operation: "COMMAND", snapshot: snapA, state: { confirmation: { by: u.owner } }, by: u.owner };
      await expect(exec(as.owner, revisionSql, revision(sneaky))).rejects.toMatchObject(DENIED);
      const stateOnly = { operation: "COMMAND", state: { confirmation: { by: u.owner } }, by: u.owner };
      await expect(exec(as.owner, revisionSql, revision(stateOnly))).rejects.toMatchObject(DENIED);
      const carried = { operation: "COMMAND", snapshot: snapA, state: { confirmation: { by: u.lead } }, by: u.owner };
      expect((await exec(as.owner, revisionSql, revision(carried))).rowCount).toBe(1);
    });
    it("denies UPDATE and DELETE outright (no grant) and leaves rows untouched", async () => {
      await expect(exec(as.lead, `UPDATE ${t} SET state='{}' WHERE id=$1`, [rev1])).rejects.toMatchObject(DENIED);
      await expect(exec(as.lead, `DELETE FROM ${t} WHERE id=$1`, [rev1])).rejects.toMatchObject(DENIED);
      expect((await pool.query(`SELECT state FROM ${t} WHERE id=$1`, [rev1])).rows[0].state).toEqual({ confirmation: null });
    });
  });

  describe("discovery_versions", () => {
    const t = "discovery_versions";
    it("scopes SELECT to the caller's org and project membership", async () => {
      expect(await count(as.lead, t)).toBe(1);
      expect(await count(as.leadB, t)).toBe(1);
      expect(await count(as.leadB, t, `id='${snapA}'`)).toBe(0);
      expect(await count(as.outsider, t)).toBe(0);
    });
    it("accepts a CONSULTANT snapshot (positive control) and rejects every single-factor violation", async () => {
      expect((await exec(as.consultant, versionSql, version())).rowCount).toBe(1);
      await expect(exec(as.leadB, versionSql, version({ by: u.leadB }))).rejects.toMatchObject(DENIED); // foreign org_id
      await expect(exec(as.consultant, versionSql, version({ by: u.lead }))).rejects.toMatchObject(DENIED); // spoofed author
      await expect(exec(as.owner, versionSql, version({ by: u.owner }))).rejects.toMatchObject(DENIED); // PROCESS_OWNER cannot snapshot
      await expect(exec(as.guest, versionSql, version({ by: u.guest }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.outsider, versionSql, version({ by: u.outsider }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.consultant, versionSql, version({ project: projDemo }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.consultant, versionSql, version({ product: "S4HANA_ON_PREMISE" }))).rejects.toMatchObject(DENIED); // != project product
    });
    it("denies UPDATE and DELETE outright (no grant) and leaves the snapshot untouched", async () => {
      await expect(exec(as.lead, `UPDATE ${t} SET payload='{"schemaVersion":1,"x":1}' WHERE id=$1`, [snapA])).rejects.toMatchObject(DENIED);
      await expect(exec(as.lead, `DELETE FROM ${t} WHERE id=$1`, [snapA])).rejects.toMatchObject(DENIED);
      expect((await pool.query(`SELECT payload FROM ${t} WHERE id=$1`, [snapA])).rows[0].payload).toEqual({ schemaVersion: 1 });
    });
  });

  describe("consultant_jobs", () => {
    const t = "consultant_jobs";
    it("scopes SELECT to the caller's org and project membership", async () => {
      expect(await count(as.lead, t)).toBe(1); // the finished org A job
      expect(await count(as.leadB, t)).toBe(1);
      expect(await count(as.leadB, t, `id='${doneJob}'`)).toBe(0);
      expect(await count(as.outsider, t)).toBe(0);
    });
    it("accepts valid enqueues (positive controls): INTERVIEW by consultant/process owner, TO_BE by consultant", async () => {
      expect((await exec(as.consultant, jobSql, job())).rowCount).toBe(1);
      expect((await exec(as.owner, jobSql, job({ by: u.owner }))).rowCount).toBe(1);
      expect((await exec(as.consultant, jobSql, job({ kind: "TO_BE", revision: 2 }))).rowCount).toBe(1);
    });
    it("rejects foreign org, wrong requested_by, non-member, guest and demo project", async () => {
      await expect(exec(as.leadB, jobSql, job({ by: u.leadB }))).rejects.toMatchObject(DENIED); // org A row from org B session
      await expect(exec(as.consultant, jobSql, job({ by: u.lead }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.outsider, jobSql, job({ by: u.outsider }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.guest, jobSql, job({ by: u.guest }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.consultant, jobSql, job({ project: projDemo }))).rejects.toMatchObject(DENIED);
    });
    it("rejects pre-set worker-owned columns (status, run_token, deadline, error, result, metrics, finished_at)", async () => {
      const future = "2099-01-01T00:00:00Z";
      const running = { status: "RUNNING", token: randomUUID(), deadline: future };
      const done = { status: "SUCCEEDED", result: { ok: true }, finished: future };
      for (const preset of [running, done, { status: "FAILED", error: { m: "x" }, finished: future }, { error: { m: "x" } },
        { result: { ok: true } }, { metrics: { t: 1 } }, { finished: future }]) {
        await expect(exec(as.consultant, jobSql, job(preset))).rejects.toMatchObject(DENIED);
      }
      // A half-set run_token violates the table CHECK; either layer refusing it is acceptable but it must not insert.
      await expect(exec(as.consultant, jobSql, job({ token: randomUUID() }))).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) });
    });
    it("limits PROCESS_OWNER to INTERVIEW jobs and binds TO_BE to the confirmed snapshot revision", async () => {
      await expect(exec(as.owner, jobSql, job({ by: u.owner, kind: "TO_BE", revision: 2 }))).rejects.toMatchObject(DENIED);
      await expect(exec(as.consultant, jobSql, job({ kind: "TO_BE", revision: 1 }))).rejects.toMatchObject(DENIED); // rev1 not confirmed
      await expect(exec(as.consultant, jobSql, job({ kind: "TO_BE", revision: 2, snapshot: randomUUID() }))).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23503)$/) });
      await expect(exec(as.consultant, jobSql, job({ revision: 9 }))).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23503)$/) });
    });
    it("denies UPDATE and DELETE outright (no grant)", async () => {
      await tenant(as.consultant, async (c) => {
        const row = job();
        await c.query(jobSql, row);
        await c.query("SAVEPOINT s");
        await expect(c.query("UPDATE consultant_jobs SET status='FAILED' WHERE id=$1", [row[0]])).rejects.toMatchObject(DENIED);
        await c.query("ROLLBACK TO s");
        await expect(c.query("DELETE FROM consultant_jobs WHERE id=$1", [row[0]])).rejects.toMatchObject(DENIED);
      });
    });
  });
});
