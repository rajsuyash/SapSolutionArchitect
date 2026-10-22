import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigration } from "../scripts/seed";

const run = promisify(execFile);
const migrationsDir = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrationsDir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
// Floor: an empty/misresolved directory would make every equality below vacuous.
if (files.length < 7) throw new Error("migrations directory not resolved");
const baseline = files.slice(0, 4); // 0001-0004: the schema that shipped before discovery
const upgrades = files.slice(4);
const sha = (name: string) => createHash("sha256").update(readFileSync(new URL(name, migrationsDir), "utf8")).digest("hex");

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("migration upgrade path 0004 -> latest", () => {
  const database = `sap_upgrade_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8")).DATABASE_URL!);
  const admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  url.pathname = `/${database}`;
  const db = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  let created = false;
  let connected = false;
  const ids = Object.fromEntries(["org", "lead", "member", "project", "job", "analysis"].map((k) => [k, randomUUID()])) as Record<string, string>;
  const dataTables = ["organizations", "users", "projects", "project_memberships", "jobs", "problem_analyses"];
  // Columns added by later migrations: row preservation is judged on the pre-existing columns only.
  const addedColumns = new Set(["trial_ends_at", "daily_ai_job_quota", "suspended_at", "last_login_at"]);
  const withoutAdded = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !addedColumns.has(key)));
  const snapshot = async () => {
    const out: Record<string, unknown[]> = {};
    for (const t of dataTables) out[t] = (await db.query(`SELECT * FROM ${t} ORDER BY 1,2`)).rows.map(withoutAdded);
    return out;
  };
  const ledger = async () => (await db.query<{ version: string; checksum: string; applied_at: Date }>(
    "SELECT version,checksum,applied_at FROM sap_pm_migrations ORDER BY version")).rows;
  const migrateOnly = () => run(process.execPath, ["--import", "tsx", "scripts/seed.ts", "--migrate-only"],
    { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await db.connect(); connected = true;
    // The real runner always applies every file in the directory, so apply the 0001-0004 subset through the
    // same exported applyMigration (ledger + checksum) inside the runner's transaction + advisory-lock shape.
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(71399201)");
    await db.query(`CREATE TABLE IF NOT EXISTS sap_pm_migrations(
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const name of baseline) await applyMigration(db, name, readFileSync(new URL(name, migrationsDir), "utf8"));
    await db.query("COMMIT");
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Upgrade Org')", [ids.org]);
    for (const [id, email, role] of [[ids.lead, "lead", "ADMIN"], [ids.member, "member", "MEMBER"]]) {
      await db.query(`INSERT INTO users(id,org_id,email,name,org_role,password_hash) VALUES($1,$2,$3,'Synthetic','${role}','x')`,
        [id, ids.org, `${email}-${randomUUID()}@test.local`]);
    }
    await db.query(`INSERT INTO projects(id,org_id,name,client_name,problem_statement,target_product,starting_landscape,setup_status,created_by)
      VALUES($1,$2,'Legacy project','Client','Legacy problem statement','S4HANA_CLOUD_PRIVATE','MIXED','ACTIVE',$3)`,
    [ids.project, ids.org, ids.lead]);
    await db.query("INSERT INTO project_memberships(org_id,project_id,user_id,project_role) VALUES($1,$2,$3,'LEAD'),($1,$2,$4,'CONSULTANT')",
      [ids.org, ids.project, ids.lead, ids.member]);
    await db.query(`INSERT INTO jobs(id,org_id,project_id,kind,status,requested_by,request_id,result,finished_at)
      VALUES($1,$2,$3,'PROBLEM_ANALYSIS','SUCCEEDED',$4,$5,'{"ok":true}',now())`, [ids.job, ids.org, ids.project, ids.lead, randomUUID()]);
    await db.query("INSERT INTO problem_analyses(id,org_id,project_id,job_id,payload) VALUES($1,$2,$3,$4,'{\"summary\":\"legacy\"}')",
      [ids.analysis, ids.org, ids.project, ids.job]);
  }, 40000);
  afterAll(async () => {
    if (connected) await db.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); }
    finally { await admin.end(); }
  }, 15000);

  it("upgrades a 0004 database with data, preserves rows, records checksums and is idempotent", async () => {
    // Precondition: really at 0004 (the post-assertions would be vacuous otherwise).
    expect((await ledger()).map((r) => r.version)).toEqual(baseline);
    expect((await db.query<{ t: string | null }>("SELECT to_regclass('discovery_versions')::text AS t")).rows[0]!.t).toBeNull();
    for (const t of dataTables) expect((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBeGreaterThan(0);
    const before = await snapshot();
    const baselineLedger = await ledger();

    await migrateOnly();

    const after = await ledger();
    expect(after.map((r) => r.version)).toEqual(files);
    for (const row of after) expect(row.checksum).toBe(sha(row.version));
    for (const name of upgrades) expect(after.find((r) => r.version === name)).toBeDefined();
    // Baseline ledger rows are untouched (not re-applied or rewritten).
    expect(after.slice(0, 4)).toEqual(baselineLedger);
    expect(await snapshot()).toEqual(before);

    const exists = async (sql: string) => (await db.query(sql)).rowCount;
    for (const t of ["discovery_versions", "discovery_workspace_revisions", "consultant_jobs"]) {
      const r = await db.query<{ rls: boolean; forced: boolean }>(
        "SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname=$1 AND relnamespace='public'::regnamespace", [t]);
      expect(r.rows).toEqual([{ rls: true, forced: true }]);
    }
    expect(await exists("SELECT 1 FROM pg_constraint WHERE conname='discovery_snapshot_workspace_identity' AND contype='u'")).toBe(1);
    expect(await exists(`SELECT 1 FROM pg_constraint WHERE conrelid='discovery_workspace_revisions'::regclass
      AND contype='f' AND confrelid='discovery_versions'::regclass`)).toBe(1);
    // The 0004-era project is usable with the new tables on the upgraded schema.
    await db.query(`INSERT INTO discovery_workspace_revisions(id,org_id,project_id,variant_code,revision,operation,state,request_key,request_hash,created_by)
      VALUES($1,$2,$3,'LEGACY',1,'CREATE','{}',$4,$5,$6)`, [randomUUID(), ids.org, ids.project, randomUUID(), "a".repeat(64), ids.lead]);

    // Second run: strict no-op (same applied_at / checksums, no new rows).
    await migrateOnly();
    expect(await ledger()).toEqual(after);
    expect(await snapshot()).toEqual(before);
  }, 60000);

  it("refuses to run when an applied migration file was edited (checksum guard)", async () => {
    await expect(applyMigration(db, files[0]!, "-- tampered\n")).rejects.toThrow(/checksum mismatch/i);
  });
});

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("migration 0008 on a database already at 0007", () => {
  const atSeven = files.slice(0, files.indexOf("0008_saas_trials_google.sql")); // later migrations still apply on top
  const database = `sap_upgrade8_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8")).DATABASE_URL!);
  const admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  url.pathname = `/${database}`;
  const db = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  let created = false;
  let connected = false;
  const [org, user] = [randomUUID(), randomUUID()];

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await db.connect(); connected = true;
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(71399201)");
    await db.query(`CREATE TABLE IF NOT EXISTS sap_pm_migrations(
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const name of atSeven) await applyMigration(db, name, readFileSync(new URL(name, migrationsDir), "utf8"));
    await db.query("COMMIT");
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Pre-0008 Org')", [org]);
    await db.query("INSERT INTO users(id,org_id,email,name,org_role,password_hash) VALUES($1,$2,$3,'Legacy','ADMIN','x')",
      [user, org, `legacy-${randomUUID()}@test.local`]);
  }, 40000);
  afterAll(async () => {
    if (connected) await db.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); }
    finally { await admin.end(); }
  }, 15000);

  it("adds trial/quota/suspension columns, leaving existing organizations without expiry", async () => {
    expect(atSeven.at(-1)).toBe("0007_consultant_jobs.sql"); // precondition: the database really stops at 0007
    expect((await db.query("SELECT version FROM sap_pm_migrations ORDER BY version")).rows.at(-1)!.version).toBe(atSeven.at(-1));
    expect((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='organizations' AND column_name='trial_ends_at'")).rowCount).toBe(0);

    await run(process.execPath, ["--import", "tsx", "scripts/seed.ts", "--migrate-only"],
      { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });

    expect((await db.query("SELECT version FROM sap_pm_migrations ORDER BY version")).rows.at(-1)!.version).toBe(files.at(-1));
    const existing = (await db.query("SELECT trial_ends_at,daily_ai_job_quota,suspended_at FROM organizations WHERE id=$1", [org])).rows[0];
    expect(existing).toEqual({ trial_ends_at: null, daily_ai_job_quota: 10, suspended_at: null });
    const fresh = (await db.query(`INSERT INTO organizations(id,name) VALUES($1,'Fresh') RETURNING
      extract(epoch FROM trial_ends_at-clock_timestamp()) AS seconds`, [randomUUID()])).rows[0];
    // "14 days" is calendar arithmetic in the session time zone, so a DST change adds or removes an hour.
    expect(Math.abs(Number(fresh.seconds) - 14 * 86400)).toBeLessThan(2 * 3600);
    await expect(db.query("UPDATE organizations SET daily_ai_job_quota=0 WHERE id=$1", [org])).rejects.toMatchObject({ code: "23514" });
    // Legacy password user untouched; password_hash is now nullable; identity table exists.
    expect((await db.query("SELECT password_hash,last_login_at FROM users WHERE id=$1", [user])).rows[0]).toEqual({ password_hash: "x", last_login_at: null });
    await db.query("UPDATE users SET password_hash=NULL WHERE id=$1", [user]);
    expect((await db.query("SELECT count(*)::int AS n FROM auth.oauth_identities")).rows[0].n).toBe(0);
  }, 60000);
});
