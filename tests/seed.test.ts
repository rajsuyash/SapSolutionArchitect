import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigration, fixtureId, parseReferences } from "../scripts/seed";

const run = promisify(execFile);
const header = "kind,code,title,module,targetProducts,summary\n";
// Every checked-in migration must be applied; derive the list so new migrations cannot silently drift.
// Floor guards against an empty/misresolved directory making the equality vacuous.
const migrationFiles = readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
if (migrationFiles.length < 7) throw new Error("migrations directory not resolved");
const csv = () => readFileSync(new URL("../seed/reference-library.csv", import.meta.url), "utf8");

describe("reference seed validation", () => {
  it("loads unique, normalized library entries", () => {
    const rows = parseReferences(csv());
    expect(rows.map((row) => row.code)).toEqual(["VA01", "VA02", "VA03"]);
    expect(rows.every((row) => row.targetProducts.includes("S4HANA_CLOUD_PRIVATE"))).toBe(true);
  });

  it("handles quoted commas, escaped quotes, CRLF and multiline fields", () => {
    const rows = parseReferences(header + 'TCODE, va01 ,Create,SD,S4HANA_ON_PREMISE,"A, B\r\n""quoted"""\r\n');
    expect(rows[0]?.code).toBe("VA01");
    expect(rows[0]?.summary).toBe('A, B\n"quoted"');
  });

  it.each([
    "wrong,header\n", header,
    header + 'TCODE,VA01,Create,SD,S4HANA_ON_PREMISE,"unclosed',
    header + 'TCODE,VA01,Create,SD,S4HANA_ON_PREMISE,"closed"junk\n',
    header + "TCODE,VA01,Create,SD,UNKNOWN,Summary\n",
    header + "UNKNOWN,VA01,Create,SD,S4HANA_ON_PREMISE,Summary\n",
    header + "TCODE,VA01,,SD,S4HANA_ON_PREMISE,Summary\n",
    header + "TCODE,VA01,Create,SD,S4HANA_ON_PREMISE,Summary,Extra\n",
    header + "TCODE,VA01,Create,SD,S4HANA_ON_PREMISE,Summary\nTCODE,va01,Duplicate,SD,S4HANA_ON_PREMISE,Summary\n",
  ])("rejects invalid CSV before connecting to the database", (input) => {
    expect(() => parseReferences(input)).toThrow();
  });

  it("refuses production fixtures and unsupported fixture options", async () => {
    for (const args of [[], ["--fixture=FIX-7"]]) {
      await expect(run(process.execPath, ["--import", "tsx", "scripts/seed.ts", ...args], {
        env: { ...process.env, NODE_ENV: args.length ? "test" : "production", DATABASE_URL: "invalid-secret-url" },
      })).rejects.toMatchObject({ code: 1, stderr: expect.not.stringContaining("invalid-secret-url") });
    }
  });
});

// Always create an isolated database on the checked-in local service. Never reset the app DB.
describe.skipIf(process.env.RUN_DB_TESTS !== "1")("foundation database", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const database = `sap_seed_test_${suffix}`;
  const role = `sap_seed_role_${suffix}`;
  const url = new URL(parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8")).DATABASE_URL!);
  const admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  let databaseCreated = false;
  let roleCreated = false;
  let clientConnected = false;
  const tables = ["organizations", "users", "projects", "project_memberships", "org_units", "process_nodes",
    "documents", "document_versions", "sap_references", "blueprints", "exports"];
  const acme = fixtureId("acme");
  const other = fixtureId("other");
  const seedCommand = () => run("pnpm", ["db:seed"], {
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000,
  });
  const snapshot = async () => {
    const entries = [];
    for (const table of tables) entries.push([table, (await client.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows]);
    return Object.fromEntries(entries);
  };
  const scoped = async (org: string | null, action: () => Promise<void>) => {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${role}`);
      if (org) await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await action();
    } finally {
      await client.query("ROLLBACK");
    }
  };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    databaseCreated = true;
    await client.connect();
    clientConnected = true;
  }, 10000);

  afterAll(async () => {
    if (clientConnected) await client.end();
    try {
      if (databaseCreated) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      if (roleCreated) await admin.query(`DROP ROLE ${role}`);
    } finally {
      await admin.end();
    }
  }, 10000);

  it("seeds an empty database twice through the actual package command without changing any row", async () => {
    expect((await seedCommand()).stdout).toContain("Database seeded");
    const first = await snapshot();
    expect(first.sap_references).toHaveLength(4);
    expect(first.organizations).toHaveLength(2);
    expect(first.users).toHaveLength(3);
    expect(first.projects).toHaveLength(2);
    expect(first.process_nodes).toHaveLength(8);
    expect(first.documents).toHaveLength(3);
    expect(first.blueprints).toHaveLength(1);
    expect(first.exports).toHaveLength(1);
    expect((await seedCommand()).stdout).toContain("Database seeded");
    expect(await snapshot()).toEqual(first);
    expect((await client.query("SELECT version FROM sap_pm_migrations ORDER BY version")).rows)
      .toEqual(migrationFiles.map((version) => ({ version })));
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    roleCreated = true;
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables.join(", ")} TO ${role}`);
  }, 60000);

  it("creates the exact FIX-1, FIX-2 and FIX-10 relationships", async () => {
    const project = (await client.query("SELECT * FROM projects WHERE id=$1", [fixtureId("acme-project")])).rows[0];
    expect(project).toMatchObject({ name: "Acme O2C Transformation", setup_status: "ACTIVE",
      target_product: "S4HANA_CLOUD_PRIVATE", starting_landscape: "NON_SAP" });
    expect((await client.query("SELECT code FROM org_units WHERE org_id=$1 ORDER BY code", [acme])).rows)
      .toEqual([{ code: "1000" }, { code: "2000" }]);
    expect((await client.query("SELECT org_role FROM users WHERE email='owner@test.local'")).rows[0].org_role).toBe("GUEST");
    expect((await client.query("SELECT project_role FROM project_memberships WHERE user_id=$1", [fixtureId("owner")])).rows[0].project_role).toBe("PROCESS_OWNER");
    expect((await client.query("SELECT process_owner_user_id FROM process_nodes WHERE id=$1", [fixtureId("sales")])).rows[0].process_owner_user_id).toBe(fixtureId("owner"));
    expect((await client.query("SELECT id FROM documents WHERE process_id=$1", [fixtureId("returns")])).rowCount).toBe(0);
    expect((await client.query("SELECT id FROM documents WHERE current_version_id IS NULL")).rowCount).toBe(0);
    expect((await client.query("SELECT payload->>'schemaVersion' AS version FROM document_versions")).rows)
      .toEqual([{ version: "1" }, { version: "1" }, { version: "1" }]);
    expect((await client.query("SELECT status, storage_key FROM exports")).rows[0])
      .toEqual({ status: "FAILED", storage_key: null });
  });

  it("preserves user edits and serializes concurrent repeat seeds", async () => {
    await client.query("UPDATE projects SET name='User edited project' WHERE id=$1", [fixtureId("acme-project")]);
    const before = await snapshot();
    await Promise.all([seedCommand(), seedCommand()]);
    expect(await snapshot()).toEqual(before);
  }, 60000);

  it("hashes each fixture password with distinct bcrypt salts at PRD cost 12", async () => {
    const { rows } = await client.query<{ password_hash: string }>("SELECT password_hash FROM users");
    expect(new Set(rows.map((row) => row.password_hash)).size).toBe(3);
    for (const { password_hash: hash } of rows) {
      expect(bcrypt.getRounds(hash)).toBe(12);
      expect(await bcrypt.compare("LocalSeed123!", hash)).toBe(true);
      expect(await bcrypt.compare("wrong-password", hash)).toBe(false);
    }
  }, 10000);

  it("fails closed without tenant context and isolates every tenant table under a restricted role", async () => {
    const all = await snapshot();
    await scoped(null, async () => {
      for (const table of tables.filter((name) => name !== "sap_references")) {
        expect((await client.query(`SELECT * FROM ${table}`)).rowCount, table).toBe(0);
      }
      expect((await client.query("SELECT * FROM sap_references")).rowCount).toBe(3);
    });
    for (const tenant of [acme, other]) await scoped(tenant, async () => {
      expect((await client.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0])
        .toEqual({ rolsuper: false, rolbypassrls: false });
      for (const table of tables) {
        const rows = (await client.query(`SELECT * FROM ${table}`)).rows;
        const expected = all[table].filter((row: { id: string; org_id: string | null }) =>
          (table === "organizations" ? row.id : row.org_id) === tenant || (table === "sap_references" && row.org_id === null));
        expect(rows.length, `${table} visible row count`).toBe(expected.length);
        expect(rows.every((row) => (table === "organizations" ? row.id : row.org_id) === tenant ||
          (table === "sap_references" && row.org_id === null)), table).toBe(true);
      }
      expect((await client.query("SELECT * FROM sap_references WHERE code='ZOTHER'")).rowCount).toBe(tenant === other ? 1 : 0);
      expect((await client.query("UPDATE projects SET name='Intrusion' WHERE org_id=$1", [tenant === acme ? other : acme])).rowCount).toBe(0);
      expect((await client.query("DELETE FROM sap_references WHERE org_id IS NULL")).rowCount).toBe(0);
      expect((await client.query("UPDATE sap_references SET title='Intrusion' WHERE org_id IS NULL")).rowCount).toBe(0);
      expect((await client.query("UPDATE projects SET name='Allowed edit' WHERE org_id=$1", [tenant])).rowCount).toBe(1);
    });
    await scoped(acme, async () => {
      await expect(client.query("INSERT INTO organizations(id,name) VALUES($1,'Intrusion')", [randomUUID()]))
        .rejects.toMatchObject({ code: "42501" });
    });
    await scoped(acme, async () => {
      await expect(client.query(`INSERT INTO sap_references(id,kind,code,title,module,target_products,summary,source_note)
        VALUES($1,'TCODE','FORGED','Forged','SD',ARRAY['S4HANA_ON_PREMISE'],'Forged','Forged')`, [randomUUID()]))
        .rejects.toMatchObject({ code: "42501" });
    });
  });

  it("blocks forged cross-tenant and cross-project relationships even for a bypass role", async () => {
    await expect(client.query("UPDATE process_nodes SET process_owner_user_id=$1 WHERE id=$2",
      [fixtureId("other-lead"), fixtureId("sales")])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query("UPDATE documents SET process_id=$1 WHERE id=$2",
      [fixtureId("other-sales"), fixtureId("sales-doc")])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query("UPDATE documents SET current_version_id=$1 WHERE id=$2",
      [fixtureId("phone-version"), fixtureId("sales-doc")])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query("UPDATE process_nodes SET parent_id=id WHERE id=$1", [fixtureId("sales")]))
      .rejects.toMatchObject({ code: "23503" });
    await client.query("BEGIN");
    const secondProject = randomUUID();
    await client.query(`INSERT INTO projects SELECT $1,org_id,'Same tenant project',client_name,problem_statement,
      target_product,starting_landscape,modules,setup_status,is_demo,created_by,created_at FROM projects WHERE id=$2`,
    [secondProject, fixtureId("acme-project")]);
    await expect(client.query("UPDATE process_nodes SET project_id=$1 WHERE id=$2", [secondProject, fixtureId("phone")]))
      .rejects.toMatchObject({ code: "23503" });
    await client.query("ROLLBACK");
    await expect(client.query("INSERT INTO sap_references SELECT $1, org_id,kind,code,title,module,target_products,summary,source_note,created_by FROM sap_references WHERE code='VA01'", [randomUUID()]))
      .rejects.toMatchObject({ code: "23505" });
  });

  it("keeps approved document versions and blueprint snapshots immutable", async () => {
    const id = fixtureId("sales-version");
    await client.query("BEGIN");
    await client.query("UPDATE document_versions SET status='APPROVED',approved_by=$1,approved_at=now() WHERE id=$2", [fixtureId("lead"), id]);
    await expect(client.query("UPDATE document_versions SET payload='{}' WHERE id=$1", [id]))
      .rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK");
    await expect(client.query("UPDATE blueprints SET payload='{}'"))
      .rejects.toMatchObject({ code: "55000" });
    await expect(client.query("DELETE FROM blueprints"))
      .rejects.toMatchObject({ code: "55000" });
  });

  it("detects edited applied migrations and rolls back a failing migration transaction", async () => {
    await expect(applyMigration(client, "0001_foundation.sql", "SELECT 1"))
      .rejects.toThrow("checksum mismatch");
    await client.query("BEGIN");
    await expect(applyMigration(client, "broken.sql", "CREATE TABLE never_committed(id int); SELECT missing_column;"))
      .rejects.toMatchObject({ code: "42703" });
    await client.query("ROLLBACK");
    expect((await client.query("SELECT to_regclass('public.never_committed') AS table_name")).rows[0].table_name).toBeNull();
    expect((await client.query("SELECT * FROM sap_pm_migrations")).rowCount).toBe(migrationFiles.length);
  });
});
