import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthService, sessionCookie } from "../src/lib/auth";
import { handleProjects, type HttpRuntime } from "../src/lib/auth-http";
import { createDiscoveryRepository, validateDiscovery, type DiscoveryInput } from "../src/lib/discovery";
import { createProjectRepository, withTenantSession } from "../src/lib/tenant";

// Fictional workshop notes; source text is deliberately not normalized.
const fixture = (): DiscoveryInput => ({
  schemaVersion: 1, variantName: "Equipment hire", targetRelease: null,
  sources: [{ id: "SRC-1", title: "Fictional workshop", revision: "2026-10-20 / v1", locator: "Returns!B2:C2",
    text: "  Today the clerk records returns in a spreadsheet.\r\nRequested: block completion if the return date is missing.  " }],
  asIsSteps: [{ id: "AS-1", sequence: 1, name: "Record return", actor: "Stores clerk", system: "Spreadsheet",
    trigger: "An asset returns", description: "Clerk records the return in a spreadsheet.",
    inputs: ["Return note"], outputs: ["Return entry"], controls: [], exceptions: [],
    evidence: { sourceId: "SRC-1", quote: "Today the clerk records returns in a spreadsheet." } }],
  requirements: [{ id: "R-1", asIsStepId: "AS-1", kind: "TO_BE_REQUIREMENT",
    statement: "Require an actual return date before completion", critical: true,
    evidence: { sourceId: "SRC-1", quote: "block completion if the return date is missing." } }],
  conflicts: [], openQuestions: [{ id: "Q-1", question: "Which timezone applies to the return?", owner: "Stores lead" }],
});

describe("discovery input validation", () => {
  it("preserves raw source text and separates current facts from future requirements", () => {
    const input = fixture();
    expect(validateDiscovery(input)).toEqual(input);
    expect(validateDiscovery(input).sources[0]!.text).toContain("\r\n");
    expect(validateDiscovery(input).asIsSteps[0]!.evidence.quote).not.toBe(input.requirements[0]!.evidence.quote);
  });
  it.each(["approvedDecisions", "references", "status", "orgId", "targetProduct"])("rejects client-supplied trusted field %s", key => {
    expect(() => validateDiscovery({ ...fixture(), [key]: [] })).toThrow("Check discovery fields");
  });
  it("rejects invented quotes, unknown sources and orphan requirements", () => {
    const input = fixture();
    input.requirements[0]!.evidence.quote = "An invented rule";
    expect(() => validateDiscovery(input)).toThrow();
    input.requirements[0]!.evidence = { sourceId: "SRC-FAKE", quote: "Existing words" };
    expect(() => validateDiscovery(input)).toThrow();
    input.requirements[0]!.evidence = fixture().requirements[0]!.evidence;
    input.requirements[0]!.asIsStepId = "AS-FAKE";
    expect(() => validateDiscovery(input)).toThrow();
  });
  it("rejects duplicates, missing steps, sequence gaps and dangling conflicts", () => {
    const input = fixture();
    input.sources.push({ ...input.sources[0]! });
    expect(() => validateDiscovery(input)).toThrow();
    input.sources.pop(); input.asIsSteps[0]!.sequence = 2;
    expect(() => validateDiscovery(input)).toThrow();
    input.asIsSteps[0]!.sequence = 1;
    input.conflicts = [{ id: "C-1", question: "Which rule applies?", sourceIds: ["SRC-FAKE"] }];
    expect(() => validateDiscovery(input)).toThrow();
    input.conflicts = []; input.asIsSteps = [];
    expect(() => validateDiscovery(input)).toThrow();
  });
  it("rejects unsupported payload size, blank evidence and null bytes without truncation", () => {
    const input = fixture();
    input.sources[0]!.text += "x".repeat(10000);
    expect(validateDiscovery(input).sources[0]!.text).toBe(input.sources[0]!.text);
    input.sources = fixture().sources;
    input.sources = Array.from({ length: 10 }, (_, i) => ({ ...input.sources[0]!, id: `SRC-${i + 1}`,
      text: input.sources[0]!.text + "x".repeat(30000) }));
    expect(() => validateDiscovery(input)).toThrow();
    const blank = fixture(); blank.asIsSteps[0]!.evidence.quote = " ";
    expect(() => validateDiscovery(blank)).toThrow();
    const nul = fixture(); nul.sources[0]!.text += "\0";
    expect(() => validateDiscovery(nul)).toThrow();
  });
});

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("discovery capture on PostgreSQL and HTTP boundary", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const database = `sap_discovery_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 8, statement_timeout: 10000 });
  const ended: Promise<void>[] = [];
  pool.on("connect", client => ended.push(new Promise<void>(resolve => client.once("end", resolve))));
  const appUrl = "http://127.0.0.1:3017";
  const auth = createAuthService(pool, { secret: "synthetic-discovery-test-secret-123456789", appUrl });
  const projects = createProjectRepository(pool, auth);
  const discovery = createDiscoveryRepository(pool, auth);
  const load = (): HttpRuntime => ({ config: { APP_URL: appUrl }, auth, projects, discovery, jobs: {} as HttpRuntime["jobs"] });
  let created = false;
  async function owner() {
    const account = await auth.signup({ name: "Fictional lead", email: `discovery-${randomUUID()}@test.local`,
      password: "SyntheticPassword123!", orgName: "Fictional discovery tenant" });
    const project = await projects.create(account.token, { name: "Hire transformation", clientName: "Fictional",
      problemStatement: "Manual return recording causes billing errors and delays for our equipment hire customers.",
      targetProduct: "S4HANA_CLOUD_PRIVATE" }, randomUUID());
    return { ...account, project };
  }
  type Owner = Awaited<ReturnType<typeof owner>>;
  const save = (actor: Owner, expectedVersion = 0, input = fixture(), key: string = randomUUID(), variant = "RENTAL") =>
    discovery.save(actor.token, actor.project.id, variant, { expectedVersion, input }, key);
  function request(actor: Owner, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}, suffix = "") {
    const cookie = sessionCookie(actor.token, appUrl);
    return new Request(`${appUrl}/api/projects/${actor.project.id}/discovery/RENTAL${suffix}`, {
      method, headers: { cookie: `${cookie.name}=${cookie.value}`, origin: appUrl, "content-type": "application/json",
        "idempotency-key": randomUUID(), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const route = (actor: Owner, req: Request) => handleProjects(req, [actor.project.id, "discovery", "RENTAL"], load);
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)("pnpm", ["db:seed"], {
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000,
    });
  }, 40000);
  afterAll(async () => {
    await pool.end(); await Promise.all(ended);
    try { if (created) await admin.query(`DROP DATABASE ${database}`); }
    finally { await admin.end(); }
  }, 15000);

  it("persists exact evidence, release uncertainty, source digests and immutable history across saves", async () => {
    const actor = await owner();
    expect(await discovery.get(actor.token, actor.project.id, "RENTAL")).toEqual({ snapshot: null, canEdit: true });
    const original = fixture(); const first = await save(actor, 0, original);
    expect(first).toMatchObject({ version: 1, targetProduct: "S4HANA_CLOUD_PRIVATE", status: "DRAFT",
      evidenceStatus: "USER_PROVIDED", input: original, createdBy: actor.user.id });
    expect(first.sourceDigests["SRC-1"]).toBe(createHash("sha256").update(original.sources[0]!.text).digest("hex"));
    const edited = fixture(); edited.sources[0]!.revision = "v2";
    edited.sources[0]!.text += "\r\nAdditional workshop note.";
    const second = await save(actor, 1, edited);
    expect(second.version).toBe(2);
    expect(second.sourceDigests).not.toEqual(first.sourceDigests);
    expect((await discovery.get(actor.token, actor.project.id, "RENTAL", 1)).snapshot).toEqual(first);
    expect((await discovery.get(actor.token, actor.project.id, "RENTAL")).snapshot).toEqual(second);
    expect(await discovery.list(actor.token, actor.project.id)).toEqual([{ variantCode: "RENTAL", version: 2, variantName: "Equipment hire" }]);
    await expect(pool.query("UPDATE discovery_versions SET payload='{}' WHERE id=$1", [first.id])).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM discovery_versions WHERE id=$1", [first.id])).rejects.toMatchObject({ code: "55000" });
  });

  it("deduplicates retries and prevents concurrent or stale editors overwriting prior work", async () => {
    const actor = await owner(); const key = randomUUID();
    const copies = await Promise.all([save(actor, 0, fixture(), key), save(actor, 0, fixture(), key.toUpperCase())]);
    expect(copies[0]!.id).toBe(copies[1]!.id);
    const changed = fixture(); changed.variantName = "Changed name";
    await expect(save(actor, 0, changed, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const competing = await Promise.allSettled([save(actor, 1), save(actor, 1, changed)]);
    expect(competing.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const failed = competing.find(item => item.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toMatchObject({ code: "DISCOVERY_CONFLICT" });
    expect(await save(actor, 0, fixture(), key)).toEqual(copies[0]); // Late response retry returns its original snapshot.
    expect((await pool.query("SELECT id FROM discovery_versions WHERE project_id=$1", [actor.project.id])).rowCount).toBe(2);
    await save(actor, 0, fixture(), randomUUID(), "SERVICE");
    expect(await discovery.list(actor.token, actor.project.id)).toHaveLength(2);
  });

  it("isolates organizations and requires project membership even for organization admins", async () => {
    const actor = await owner(); const outsider = await owner(); const snapshot = await save(actor);
    await expect(discovery.get(null, actor.project.id, "RENTAL")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(discovery.get(outsider.token, actor.project.id, "RENTAL")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(discovery.save(outsider.token, actor.project.id, "RENTAL", { expectedVersion: 1, input: fixture() }, randomUUID()))
      .rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await withTenantSession(pool, auth, outsider.token, async ({ client }) => {
      expect((await client.query("SELECT id FROM discovery_versions WHERE id=$1", [snapshot.id])).rowCount).toBe(0);
    });
    await withTenantSession(pool, auth, actor.token, async ({ client }) => {
      expect((await client.query("SELECT id FROM discovery_versions WHERE id=$1", [snapshot.id])).rowCount).toBe(1);
    });
    await pool.query("DELETE FROM project_memberships WHERE project_id=$1", [actor.project.id]);
    await expect(discovery.get(actor.token, actor.project.id, "RENTAL")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(save(actor, 1)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await withTenantSession(pool, auth, actor.token, async ({ client }) => {
      expect((await client.query("SELECT id FROM discovery_versions WHERE id=$1", [snapshot.id])).rowCount).toBe(0);
    });
  });

  it("allows read-only reviewers but denies guest, process-owner and demo writes at repository and SQL boundaries", async () => {
    const actor = await owner(); const first = await save(actor);
    const deniedInsert = () => withTenantSession(pool, auth, actor.token, ({ client }) => client.query(
      `INSERT INTO discovery_versions(id,org_id,project_id,variant_code,version_no,target_product,payload,source_digests,
       request_key,request_hash,created_by) SELECT $1,org_id,project_id,variant_code,2,target_product,payload,source_digests,
       $2,request_hash,created_by FROM discovery_versions WHERE id=$3`, [randomUUID(), randomUUID(), first.id]));
    await pool.query("UPDATE project_memberships SET project_role='PROCESS_OWNER' WHERE project_id=$1", [actor.project.id]);
    expect((await discovery.get(actor.token, actor.project.id, "RENTAL")).canEdit).toBe(false);
    await expect(save(actor, 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(deniedInsert()).rejects.toMatchObject({ code: "42501" });
    await pool.query("UPDATE project_memberships SET project_role='LEAD' WHERE project_id=$1", [actor.project.id]);
    await pool.query("UPDATE users SET org_role='GUEST' WHERE id=$1", [actor.user.id]);
    expect((await discovery.get(actor.token, actor.project.id, "RENTAL")).snapshot?.id).toBe(first.id);
    await expect(save(actor, 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(deniedInsert()).rejects.toMatchObject({ code: "42501" });
    await pool.query("UPDATE users SET org_role='ADMIN' WHERE id=$1", [actor.user.id]);
    await pool.query("UPDATE projects SET is_demo=true WHERE id=$1", [actor.project.id]);
    await expect(save(actor, 1)).rejects.toMatchObject({ code: "DEMO_READ_ONLY" });
    await expect(deniedInsert()).rejects.toMatchObject({ code: "42501" });
    await expect(withTenantSession(pool, auth, actor.token, ({ client }) => client.query(
      "DELETE FROM discovery_versions WHERE id=$1", [first.id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects invalid saves without creating a revision", async () => {
    const actor = await owner(); const bad = fixture(); bad.requirements[0]!.evidence.quote = "fabricated";
    await expect(save(actor, 0, bad)).rejects.toMatchObject({ code: "INVALID_DISCOVERY" });
    await expect(save(actor, 0, fixture(), "invalid")).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    await expect(save(actor, 2)).rejects.toMatchObject({ code: "DISCOVERY_CONFLICT" });
    expect(await discovery.list(actor.token, actor.project.id)).toEqual([]);
  });

  it("captures and retrieves via the HTTP boundary with request IDs and no caching", async () => {
    const actor = await owner(); const body = { expectedVersion: 0, input: fixture() };
    const response = await route(actor, request(actor, "POST", body));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    const saved = await response.json();
    const loaded = await route(actor, request(actor, "GET", undefined, {}, "?version=1"));
    expect((await loaded.json()).data.snapshot).toEqual(saved.data.snapshot);
    const list = await handleProjects(request(actor), [actor.project.id, "discovery"], load);
    expect((await list.json()).data.variants).toHaveLength(1);
    expect((await route(actor, request(actor, "POST", body))).status).toBe(409);
  });

  it("enforces origin, cookies, content limits, media type, method and revision parameters", async () => {
    const actor = await owner(); const body = { expectedVersion: 0, input: fixture() };
    const cases: [Request, number][] = [
      [request(actor, "POST", body, { origin: "https://foreign.invalid" }), 403],
      [request(actor, "POST", body, { cookie: "" }), 401],
      [request(actor, "POST", body, { "content-type": "text/plain" }), 415],
      [request(actor, "POST", body, { "content-length": "300000" }), 413],
      [request(actor, "POST", { ...body, ignored: "not allowed" }), 400],
      [request(actor, "POST", body, { "idempotency-key": "" }), 400],
      [request(actor, "PUT", body), 405],
      [request(actor, "GET", undefined, {}, "?version=-1"), 400],
      [request(actor, "GET", undefined, {}, "?version=1&version=2"), 400],
      [request(actor, "GET", undefined, {}, "?version=9999999999"), 400],
    ];
    for (const [req, status] of cases) {
      const response = await route(actor, req);
      expect(response.status).toBe(status);
      expect((await response.json()).success).toBe(false);
    }
    const cookie = sessionCookie(actor.token, appUrl);
    expect((await route(actor, request(actor, "POST", body,
      { cookie: `${cookie.name}=${cookie.value}; ${cookie.name}=${cookie.value}` }))).status).toBe(401);
    expect(await discovery.list(actor.token, actor.project.id)).toEqual([]);
  });
});
