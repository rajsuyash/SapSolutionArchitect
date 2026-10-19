import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import bcrypt from "bcryptjs";

const products = z.enum(["S4HANA_CLOUD_PUBLIC", "S4HANA_CLOUD_PRIVATE", "S4HANA_ON_PREMISE"]);
const referenceSchema = z.object({
  kind: z.enum(["SCOPE_ITEM", "TCODE", "FIORI_APP", "IMG_ACTIVITY", "TABLE", "BUSINESS_ROLE"]),
  code: z.string().trim().min(1).transform((value) => value.toUpperCase()),
  title: z.string().trim().min(1), module: z.string().trim().min(1),
  targetProducts: z.array(products).min(1), summary: z.string().trim().min(1),
});
class SeedError extends Error {}

// RFC-style quoting, including embedded newlines; reject malformed quotes rather
// than silently shifting columns. This parser is for the trusted seed, not uploads.
export function parseReferences(input: string): z.infer<typeof referenceSchema>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const source = input.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const pushField = () => { row.push(field); field = ""; closed = false; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ",") pushField();
    else if (char === "\n") { pushField(); rows.push(row); row = []; }
    else if (char === '"' && field === "" && !closed) quoted = true;
    else if (char === '"' || closed || char === "\r") throw new SeedError("Malformed reference CSV");
    else field += char;
  }
  if (quoted) throw new SeedError("Unclosed reference CSV field");
  if (row.length || field || closed) { pushField(); rows.push(row); }
  const header = ["kind", "code", "title", "module", "targetProducts", "summary"];
  if (JSON.stringify(rows.shift()) !== JSON.stringify(header) || !rows.length) {
    throw new SeedError("Invalid or empty reference CSV");
  }
  const seen = new Set<string>();
  return rows.map((values, index) => {
    if (values.length !== 6) throw new SeedError(`Invalid reference CSV row ${index + 2}`);
    const [kind, code, title, module, targets, summary] = values;
    const result = referenceSchema.safeParse({ kind, code, title, module, summary,
      targetProducts: targets!.split("|").map((value) => value.trim()) });
    if (!result.success) throw new SeedError(`Invalid reference CSV row ${index + 2}`);
    const key = `${result.data.kind}:${result.data.code}`;
    if (seen.has(key)) throw new SeedError(`Duplicate reference CSV row ${index + 2}`);
    seen.add(key);
    return result.data;
  });
}

// Stable RFC 9562 version-8 UUIDs with a project namespace. No random identifiers
// are regenerated on repeat seeds; conflicts on other unique keys fail loudly.
export function fixtureId(label: string): string {
  const hash = createHash("sha256").update(`sap-pm:foundation:v1:${label}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Caller owns the transaction and advisory lock, so DDL + ledger + fixtures commit
// atomically. Never edit an applied migration; add a new numbered SQL file instead.
export async function applyMigration(client: Client, name: string, sql: string): Promise<void> {
  const checksum = createHash("sha256").update(sql).digest("hex");
  const existing = await client.query<{ checksum: string }>("SELECT checksum FROM sap_pm_migrations WHERE version=$1", [name]);
  if (existing.rows[0]) {
    if (existing.rows[0].checksum !== checksum) throw new SeedError(`Migration checksum mismatch: ${name}`);
    return;
  }
  await client.query(sql);
  await client.query("INSERT INTO sap_pm_migrations(version,checksum) VALUES($1,$2)", [name, checksum]);
}

async function fixturePasswordHash(): Promise<string> {
  // Synthetic local fixture password: LocalSeed123! (never a production account).
  // PRD §11 requires bcrypt cost >= 12 (or Argon2id).
  return bcrypt.hash("LocalSeed123!", 12);
}

async function seedFixtures(client: Client, references: z.infer<typeof referenceSchema>[]): Promise<void> {
  for (const ref of references) {
    await client.query(`INSERT INTO sap_references(id,org_id,kind,code,title,module,target_products,summary,source_note)
      VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
    [fixtureId(`reference:${ref.kind}:${ref.code}`), ref.kind, ref.code, ref.title, ref.module, ref.targetProducts,
      ref.summary, "SAP Help: Sales Orders app details; https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/7b24a64d9d0941bda1afa753263d9e39/eb016223cf56498daad29de59b167e01.html"]);
  }
  for (const [key, name] of [["acme", "Acme Consulting"], ["other", "Other Co"]]) {
    await client.query("INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [fixtureId(key!), name]);
  }
  for (const [key, org, email, name, role] of [
    ["lead", "acme", "lead@test.local", "Acme Lead", "ADMIN"],
    ["owner", "acme", "owner@test.local", "Acme Process Owner", "GUEST"],
    ["other-lead", "other", "other@test.local", "Other Lead", "ADMIN"],
  ]) {
    const id = fixtureId(key!);
    if ((await client.query("SELECT id FROM users WHERE id=$1", [id])).rowCount) continue;
    await client.query(`INSERT INTO users(id,org_id,email,name,org_role,password_hash)
      VALUES($1,$2,$3,$4,$5,$6)`, [id, fixtureId(org!), email, name, role, await fixturePasswordHash()]);
  }
  for (const [org, title, lead] of [
    ["acme", "Acme O2C Transformation", "lead"], ["other", "Other Co O2C", "other-lead"],
  ]) {
    await client.query(`INSERT INTO projects(id,org_id,name,client_name,problem_statement,target_product,
      starting_landscape,modules,setup_status,created_by) VALUES($1,$2,$3,$4,$5,'S4HANA_CLOUD_PRIVATE',
      'NON_SAP',ARRAY['SD'],'ACTIVE',$6) ON CONFLICT(id) DO NOTHING`,
    [fixtureId(`${org}-project`), fixtureId(org!), title, org === "acme" ? "Acme" : "Other Co",
      "Synthetic fixture: move manual order handling to SAP.", fixtureId(lead!)]);
    await client.query(`INSERT INTO project_memberships(org_id,project_id,user_id,project_role)
      VALUES($1,$2,$3,'LEAD') ON CONFLICT DO NOTHING`, [fixtureId(org!), fixtureId(`${org}-project`), fixtureId(lead!)]);
  }
  await client.query(`INSERT INTO project_memberships(org_id,project_id,user_id,project_role)
    VALUES($1,$2,$3,'PROCESS_OWNER') ON CONFLICT DO NOTHING`, [fixtureId("acme"), fixtureId("acme-project"), fixtureId("owner")]);
  for (const code of ["1000", "2000"]) {
    await client.query(`INSERT INTO org_units(id,org_id,project_id,type,code,name)
      VALUES($1,$2,$3,'PLANT',$4,$5) ON CONFLICT(id) DO NOTHING`,
    [fixtureId(`plant-${code}`), fixtureId("acme"), fixtureId("acme-project"), code, `Plant ${code}`]);
  }
  const nodes: [string, string, string | null, number, string, string][] = [
    ["o2c", "acme", null, 1, "O2C", "Order to cash"],
    ["orders", "acme", "o2c", 2, "O2C-01", "Sales order processing"],
    ["sales", "acme", "orders", 3, "O2C-01-01", "Standard sales order"],
    ["phone", "acme", "orders", 3, "O2C-01-02", "Phone orders"],
    ["returns", "acme", "orders", 3, "O2C-01-03", "Returns"],
    ["other-o2c", "other", null, 1, "O2C", "Order to cash"],
    ["other-orders", "other", "other-o2c", 2, "O2C-01", "Sales order processing"],
    ["other-sales", "other", "other-orders", 3, "O2C-01-01", "Other sales orders"],
  ];
  for (const [key, org, parent, level, code, name] of nodes) {
    await client.query(`INSERT INTO process_nodes(id,org_id,project_id,parent_id,level,code,name,module,
      starting_point,current_system,process_owner_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,'SD',$8,$9,$10)
      ON CONFLICT(id) DO NOTHING`, [fixtureId(key), fixtureId(org), fixtureId(`${org}-project`),
      parent ? fixtureId(parent) : null, level, code, name, level === 3 ? "NON_SAP" : null,
      level === 3 ? "Email and spreadsheets" : null, key === "sales" ? fixtureId("owner") : null]);
  }
  for (const [key, org, creator] of [["sales", "acme", "lead"], ["phone", "acme", "lead"], ["other-sales", "other", "other-lead"]]) {
    const document = fixtureId(`${key}-doc`);
    const version = fixtureId(`${key}-version`);
    await client.query(`INSERT INTO documents(id,org_id,process_id,type,current_version_id)
      VALUES($1,$2,$3,'AS_IS',$4) ON CONFLICT(id) DO NOTHING`, [document, fixtureId(org!), fixtureId(key!), version]);
    const payload = { schemaVersion: 1, summary: "Synthetic draft for local testing.", actors: ["Sales clerk"],
      systems: ["Email"], steps: [{ id: "AS-1", seq: 1, actor: "Sales clerk", system: "Email",
        action: "Record the customer's order request.", inputs: ["Customer request"], outputs: ["Recorded order"],
        documents: [], controls: [], volume: "", painPointIds: [], sapRefs: [], customObjects: [] }],
      painPoints: [], followUpQuestions: [], inputTruncated: false };
    await client.query(`INSERT INTO document_versions(id,org_id,document_id,version_no,status,payload,created_by)
      VALUES($1,$2,$3,1,'DRAFT',$4,$5) ON CONFLICT(id) DO NOTHING`,
    [version, fixtureId(org!), document, JSON.stringify(payload), fixtureId(creator!)]);
  }
  await client.query(`INSERT INTO sap_references(id,org_id,kind,code,title,module,target_products,summary,source_note,created_by)
    VALUES($1,$2,'TCODE','ZOTHER','Other Co private transaction','SD',ARRAY['S4HANA_CLOUD_PRIVATE'],
    'Synthetic tenant isolation fixture.','FIX-10; not a standard SAP transaction.',$3) ON CONFLICT(id) DO NOTHING`,
  [fixtureId("other-reference"), fixtureId("other"), fixtureId("other-lead")]);
  await client.query(`INSERT INTO blueprints(id,org_id,project_id,version_no,status,payload,created_by)
    VALUES($1,$2,$3,1,'DRAFT',$4,$5) ON CONFLICT(id) DO NOTHING`,
  [fixtureId("other-blueprint"), fixtureId("other"), fixtureId("other-project"),
    JSON.stringify({ schemaVersion: 1, fixture: "FIX-10", summary: "Synthetic isolation snapshot; not a generated Blueprint." }), fixtureId("other-lead")]);
  await client.query(`INSERT INTO exports(id,org_id,blueprint_id,format,status,error)
    VALUES($1,$2,$3,'PDF','FAILED','FIXTURE_NOT_GENERATED') ON CONFLICT(id) DO NOTHING`,
  [fixtureId("other-export"), fixtureId("other"), fixtureId("other-blueprint")]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--migrate-only")) {
    throw new SeedError("Supported commands: db:seed (FIX-1, FIX-2, FIX-10) or db:migrate");
  }
  const seed = !args.includes("--migrate-only");
  if (seed && process.env.NODE_ENV === "production") throw new SeedError("Fixture seeding is disabled in production");
  const database = z.url().refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol))
    .safeParse(process.env.DATABASE_URL);
  if (!database.success) throw new SeedError("DATABASE_URL must be a PostgreSQL URL");
  const references = seed ? parseReferences(await readFile(new URL("../seed/reference-library.csv", import.meta.url), "utf8")) : [];
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!migrations.length) throw new SeedError("No migrations found");
  const client = new Client({ connectionString: database.data, connectionTimeoutMillis: 5000,
    statement_timeout: 30000, application_name: "sap-pm-migrate" });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(71399201)");
    await client.query(`CREATE TABLE IF NOT EXISTS sap_pm_migrations(
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const name of migrations) await applyMigration(client, name, await readFile(new URL(name, directory), "utf8"));
    if (seed) await seedFixtures(client, references);
    await client.query("COMMIT");
    console.log(seed ? "Database seeded: reference library + FIX-1, FIX-2, FIX-10" : "Database migrations applied");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    // Do not print pg errors: they may include connection details or row contents.
    console.error(error instanceof SeedError ? error.message : "Database setup failed; verify service availability, migration permissions and constraints.");
    process.exitCode = 1;
  });
}
