import { CONTEXT_FIELD_IDS } from "./support/context-fields";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import bcrypt from "bcryptjs";
import { Client, Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthService, sessionCookie } from "../src/lib/auth";
import { handleProjects, type HttpRuntime } from "../src/lib/auth-http";
import { deriveKey } from "../src/lib/consultant-http";
import { createProjectRepository } from "../src/lib/tenant";
import { createJobService } from "../src/lib/jobs";
import { createDiscoveryWorkspaceRepository } from "../src/lib/discovery-workspace";
import { createConsultantJobs } from "../src/lib/consultant-jobs";
import type { createStageRunner } from "../src/lib/ai/runStage";
import type { ToBeInput } from "../src/lib/ai/to-be";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";

describe("derived idempotency keys", () => {
  it("is a stable, distinct, valid UUID per purpose and leaves invalid input to the repository", () => {
    const key = randomUUID();
    expect(deriveKey(key, "interview")).toBe(deriveKey(key, "interview"));
    expect(deriveKey(key, "interview")).not.toBe(deriveKey(key, "other"));
    expect(deriveKey(key, "interview")).not.toBe(key);
    expect(deriveKey(key, "interview")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveKey("not-a-uuid", "interview")).toBe("not-a-uuid");
    expect(deriveKey(null, "interview")).toBeNull();
  });
});

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("consultant HTTP boundary", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const database = `sap_consultant_http_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 8, statement_timeout: 10000 });
  pool.on("error", () => {});
  const queue = new PgBoss({ connectionString: url.href });
  queue.on("error", () => {});
  const origin = "http://127.0.0.1:3017";
  const auth = createAuthService(pool, { secret: "synthetic-consultant-http-secret-for-tests-only", appUrl: origin });
  const projects = createProjectRepository(pool, auth);
  const workspaces = createDiscoveryWorkspaceRepository(pool, auth);
  const consultantJobs = createConsultantJobs(pool, auth, queue, async () => {});
  const runtime: HttpRuntime = { config: { APP_URL: origin }, auth, projects, workspaces, consultantJobs,
    jobs: createJobService(pool, auth, queue, async () => {}) };
  const cookie = sessionCookie(null, origin).name;
  let created = false;

  type Options = { token?: string | null; body?: unknown; key?: string | null; origin?: string | null; raw?: string };
  async function call(method: string, path: string, options: Options = {}) {
    const headers: Record<string, string> = {};
    if (options.token) headers.cookie = `${cookie}=${options.token}`;
    if (options.origin !== null && method === "POST") headers.origin = options.origin ?? origin;
    if (options.key !== null && method === "POST") headers["idempotency-key"] = options.key ?? randomUUID();
    const hasBody = options.body !== undefined || options.raw !== undefined;
    if (hasBody) headers["content-type"] = "application/json";
    const request = new Request(`${origin}/api/projects/${path}`, { method, headers,
      body: hasBody ? options.raw ?? JSON.stringify(options.body) : undefined });
    const response = await handleProjects(request, path.split("/"), () => runtime);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  }

  async function fixture() {
    const owner = await auth.signup({ name: "Synthetic lead", email: `chttp-${randomUUID()}@test.local`,
      password: "Password123!", orgName: "Consultant http" });
    const project = await projects.create(owner.token, { name: "Hire returns", clientName: "Synthetic client",
      problemStatement: "Manual recording of equipment returns causes delayed updates and disputed invoices for fictional customers.",
      targetProduct: "S4HANA_CLOUD_PRIVATE" }, randomUUID());
    return { owner, project, path: `${project.id}/consultant/RENTAL` };
  }
  async function member(orgId: string, projectId: string, role: string, orgRole = "MEMBER") {
    const id = randomUUID(); const email = `member-${id}@test.local`;
    await pool.query(`INSERT INTO users(id,org_id,email,name,org_role,password_hash) VALUES($1,$2,$3,'Synthetic member',$4,$5)`,
      [id, orgId, email, orgRole, await bcrypt.hash("Password123!", 12)]);
    await pool.query(`INSERT INTO project_memberships(org_id,project_id,user_id,project_role) VALUES($1,$2,$3,$4)`, [orgId, projectId, id, role]);
    return { id, token: (await auth.login({ email, password: "Password123!" })).token };
  }
  async function started() {
    const f = await fixture();
    const made = await call("POST", f.path, { token: f.owner.token, body: { variantName: "Equipment hire" } });
    expect(made.status).toBe(201);
    return { ...f, revision: made.body.data.state.revision as number };
  }
  const command = (f: Awaited<ReturnType<typeof started>>, revision: number, body: object, token = f.owner.token) =>
    call("POST", `${f.path}/commands`, { token, body: { expectedRevision: revision, command: body } });
  /** Drive a workspace to a confirmed state through the public HTTP commands only. */
  async function confirmed() {
    const f = await started(); let revision = f.revision;
    const run = async (body: object) => {
      const response = await command(f, revision, body);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      revision = response.body.data.state.revision;
      return response;
    };
    for (const [fieldId, value] of [["process_owner", "Rental lead"], ["scope_boundary", "From dispatch to final invoice"],
      ["current_trigger", "Asset dispatched"], ["desired_outcome", "Accurate final invoices"],
      ["current_systems", "Spreadsheet and paper return note"], ["current_rules", "Stores records the date before billing review"],
      ["current_exceptions", "Missing return date is escalated to the stores lead"],
      ["current_financial", "Billing adjusts the final invoice after return"], ["desired_controls", "Require a dated return record for audit"],
    ] as const) await run({ type: "SET_FIELD", fieldId, status: "KNOWN", value, rationale: null, owner: null, sourceId: null, quote: null });
    for (const fieldId of CONTEXT_FIELD_IDS) await run({ type: "SET_FIELD", fieldId, status: "KNOWN", value: `Synthetic answer for ${fieldId}`,
      rationale: null, owner: null, sourceId: null, quote: null });
    await run({ type: "ADD_STEP", step: { name: "Record return", actor: "Stores clerk", system: "Spreadsheet",
      trigger: "Asset physically returned", description: "Record the return date in the spreadsheet.",
      inputs: ["Return note"], outputs: ["Return record"], controls: [], exceptions: [] } });
    const state = (await call("GET", f.path, { token: f.owner.token })).body.data.state;
    await run({ type: "ADD_REQUIREMENT", requirement: { asIsStepId: state.steps[0].id, kind: "TO_BE_REQUIREMENT",
      statement: "Require a return date before invoicing.", critical: true } });
    const done = await run({ type: "CONFIRM" });
    return { ...f, revision, confirmation: done.body.data };
  }

  beforeAll(async () => {
    await admin.connect(); await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)("pnpm", ["db:seed"], { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
    await queue.start(); await consultantJobs.initialize();
  }, 40000);
  afterAll(async () => {
    await queue.stop({ graceful: true }); await pool.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }, 15000);

  it("rejects unauthenticated and cross-origin requests before touching a service", async () => {
    const f = await started();
    for (const [method, path, body] of [["GET", `${f.project.id}/consultant`], ["GET", f.path], ["GET", `${f.path}/jobs`],
      ["POST", `${f.path}/commands`, { expectedRevision: 1, command: { type: "START_STEP_DRAFT" } }],
      ["POST", `${f.path}/messages`, { expectedRevision: 1, text: "Hello" }],
      ["POST", `${f.path}/to-be`, { expectedRevision: 1 }]] as const) {
      const response = await call(method, path, { body, token: null });
      expect([method, path, response.status]).toEqual([method, path, 401]);
      expect(response.body).toMatchObject({ success: false, error: { code: "UNAUTHENTICATED" } });
    }
    for (const bad of ["https://evil.example", null]) {
      const response = await call("POST", `${f.path}/messages`, { token: f.owner.token, origin: bad, body: { expectedRevision: f.revision, text: "Hello" } });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
    const after = await call("GET", f.path, { token: f.owner.token });
    expect(after.body.data.state.revision).toBe(f.revision);
    expect(after.headers.get("cache-control")).toContain("no-store");
  });

  it("hides another tenant's workspaces, commands and jobs behind 404", async () => {
    const f = await started(); const other = await fixture();
    const probes = [["GET", `${f.project.id}/consultant`], ["GET", f.path], ["GET", `${f.path}/jobs`],
      ["POST", `${f.path}/commands`, { expectedRevision: f.revision, command: { type: "START_STEP_DRAFT" } }],
      ["POST", `${f.path}/messages`, { expectedRevision: f.revision, text: "Hello from outside" }],
      ["POST", `${f.path}/to-be`, { expectedRevision: f.revision }]] as const;
    for (const [method, path, body] of probes) {
      const response = await call(method, path, { token: other.owner.token, body });
      expect([method, path, response.status]).toEqual([method, path, 404]);
      expect(JSON.stringify(response.body)).not.toContain("Equipment hire");
    }
    expect((await call("GET", f.path, { token: f.owner.token })).body.data.state.revision).toBe(f.revision);
  });

  it("creates, sends messages idempotently and reports stale revisions without exposing sources", async () => {
    const f = await fixture(); const key = randomUUID();
    const first = await call("POST", f.path, { token: f.owner.token, key, body: { variantName: "Equipment hire" } });
    const replay = await call("POST", f.path, { token: f.owner.token, key, body: { variantName: "Equipment hire" } });
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(first.body.data).toMatchObject({ canEdit: true, canConfirm: true, readiness: { ready: false } });
    expect(first.body.data.state.sources).toBeUndefined();
    expect((await call("GET", f.path, { token: f.owner.token })).body.data.state.sources).toBeUndefined();
    expect((await call("GET", `${f.project.id}/consultant`, { token: f.owner.token })).body.data.variants)
      .toMatchObject([{ variantCode: "RENTAL", revision: 1 }]);

    const messageKey = randomUUID(); const body = { expectedRevision: 1, text: "A clerk records returns on paper." };
    const sent = await call("POST", `${f.path}/messages`, { token: f.owner.token, key: messageKey, body });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(sent.body.data.job).toMatchObject({ kind: "INTERVIEW", status: "QUEUED", inputRevision: 2 });
    expect(sent.body.data.workspace.state.messages).toHaveLength(1);
    const again = await call("POST", `${f.path}/messages`, { token: f.owner.token, key: messageKey, body });
    expect(again.status).toBe(202);
    expect(again.body.data.job.id).toBe(sent.body.data.job.id);
    expect((await pool.query("SELECT 1 FROM discovery_workspace_revisions WHERE project_id=$1", [f.project.id])).rowCount).toBe(2);
    const jobs = await call("GET", `${f.path}/jobs`, { token: f.owner.token });
    expect(jobs.body.data.jobs).toMatchObject([{ id: sent.body.data.job.id, status: "QUEUED", result: null }]);
    expect(JSON.stringify(jobs.body)).not.toContain("metrics");

    const stale = await call("POST", `${f.path}/messages`, { token: f.owner.token, body });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("WORKSPACE_CONFLICT");
    const busy = await call("POST", `${f.path}/messages`, { token: f.owner.token, body: { expectedRevision: 2, text: "One more detail." } });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("JOB_ALREADY_RUNNING");
    const reused = await call("POST", `${f.path}/commands`, { token: f.owner.token, key: messageKey,
      body: { expectedRevision: 2, command: { type: "START_STEP_DRAFT" } } });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("validates routes, methods, bodies and keys strictly", async () => {
    const f = await started(); const token = f.owner.token;
    expect((await call("GET", `${f.path}/unknown`, { token })).status).toBe(404);
    expect((await call("GET", `${f.path}/commands`, { token })).status).toBe(405);
    expect((await call("POST", `${f.path}/jobs`, { token, body: {} })).status).toBe(405);
    expect((await call("POST", `${f.project.id}/consultant`, { token, body: {} })).status).toBe(405);
    expect((await call("GET", `${f.path}/jobs/extra`, { token })).status).toBe(404);
    expect((await call("GET", `${f.project.id}/consultant/rental`, { token })).status).toBe(404);
    const extra = await call("POST", `${f.path}/commands`, { token, body: { expectedRevision: f.revision, command: { type: "START_STEP_DRAFT" }, actorId: "x" } });
    expect([extra.status, extra.body.error.code]).toEqual([400, "INVALID_REQUEST"]);
    const unknown = await command(f, f.revision, { type: "DELETE_EVERYTHING" });
    expect([unknown.status, unknown.body.error.code]).toEqual([400, "INVALID_WORKSPACE_COMMAND"]);
    const smuggled = await command(f, f.revision, { type: "START_STEP_DRAFT", id: "st_forced" });
    expect(smuggled.status).toBe(400);
    const textual = await call("POST", `${f.path}/commands`, { token, body: { expectedRevision: "2", command: { type: "START_STEP_DRAFT" } } });
    expect(textual.status).toBe(400);
    const noKey = await call("POST", `${f.path}/commands`, { token, key: null, body: { expectedRevision: f.revision, command: { type: "START_STEP_DRAFT" } } });
    expect([noKey.status, noKey.body.error.code]).toEqual([400, "INVALID_IDEMPOTENCY_KEY"]);
    const negative = await call("POST", `${f.path}/to-be`, { token, body: { expectedRevision: -1 } });
    expect([negative.status, negative.body.error.code]).toEqual([400, "INVALID_REQUEST"]);
    expect((await call("POST", `${f.path}/commands`, { token, raw: "{broken" })).status).toBe(400);
    expect((await call("POST", `${f.path}/messages`, { token, body: { expectedRevision: f.revision, text: "   " } })).status).toBe(400);
    expect((await call("GET", f.path, { token })).body.data.state.revision).toBe(f.revision);
  });

  it("refuses To-Be generation server-side until a lead or consultant has confirmed a ready discovery", async () => {
    const f = await started();
    const direct = await call("POST", `${f.path}/to-be`, { token: f.owner.token, body: { expectedRevision: f.revision } });
    expect([direct.status, direct.body.error.code]).toEqual([409, "DISCOVERY_NOT_CONFIRMED"]);
    const early = await command(f, f.revision, { type: "CONFIRM" });
    expect([early.status, early.body.error.code]).toEqual([409, "WORKSPACE_NOT_READY"]);
    expect((await pool.query("SELECT 1 FROM consultant_jobs WHERE project_id=$1", [f.project.id])).rowCount).toBe(0);

    const c = await confirmed();
    expect(c.confirmation).toMatchObject({ canConfirm: true, readiness: { ready: true } });
    expect(c.confirmation.confirmedSnapshotId).toEqual(expect.any(String));
    const edited = await command(c, c.revision, { type: "START_STEP_DRAFT" });
    expect(edited.body.data.confirmedSnapshotId).toBeNull();
    const withdrawn = await call("POST", `${c.path}/to-be`, { token: c.owner.token, body: { expectedRevision: edited.body.data.state.revision } });
    expect([withdrawn.status, withdrawn.body.error.code]).toEqual([409, "DISCOVERY_NOT_CONFIRMED"]);
  });

  it("generates only from the confirmed revision and returns a minimal, truthful result", async () => {
    const c = await confirmed();
    const stale = await call("POST", `${c.path}/to-be`, { token: c.owner.token, body: { expectedRevision: c.revision - 1 } });
    expect([stale.status, stale.body.error.code]).toEqual([409, "STALE_INPUT"]);
    const key = randomUUID();
    const queued = await call("POST", `${c.path}/to-be`, { token: c.owner.token, key, body: { expectedRevision: c.revision } });
    expect(queued.status).toBe(202);
    expect(queued.body.data.job).toMatchObject({ kind: "TO_BE", status: "QUEUED", inputRevision: c.revision });
    expect((await call("POST", `${c.path}/to-be`, { token: c.owner.token, key, body: { expectedRevision: c.revision } })).body.data.job.id)
      .toBe(queued.body.data.job.id);
    const runner = (async (_stage: string, raw: unknown) => {
      const input = raw as ToBeInput; const step = input.discovery.asIsSteps[0]!; const req = input.discovery.requirements[0]!;
      const tb = rentalDraft.steps[0]!;
      const design = { ...rentalDraft, steps: [{ ...tb, asIsStepIds: [step.id], requirementIds: [req.id],
        acceptanceTests: tb.acceptanceTests.map(t => ({ ...t, requirementIds: [req.id] })) }],
      coverage: [{ requirementId: req.id, disposition: "IMPLEMENTED", stepIds: [tb.id], decisionId: null, rationale: "Covered by the proposed hire step." }],
      conflictDecisions: [], openQuestions: [] };
      return { payload: { design }, metrics: { stage: "to_be", provider: "anthropic", model: "synthetic-test-double", inputTokens: 1,
        outputTokens: 1, latencyMs: 1, attempts: 1, validationErrors: [] } };
    }) as ReturnType<typeof createStageRunner>;
    await consultantJobs.execute(queued.body.data.job.id, new AbortController().signal, runner);
    const done = (await call("GET", `${c.path}/jobs`, { token: c.owner.token })).body.data.jobs[0];
    expect(done).toMatchObject({ kind: "TO_BE", status: "SUCCEEDED", result: { sourceRevision: c.revision } });
    expect(["BLOCKED", "HUMAN_REVIEW_REQUIRED"]).toContain(done.result.status);
    expect(Object.keys(done.result).sort()).toEqual(["blockerCount", "sourceRevision", "status"]);
    expect(JSON.stringify(done)).not.toMatch(/approved|steps|coverage|metrics/i);
  }, 20000);

  const scripted = (async (_stage: string, raw: unknown) => {
    const input = raw as ToBeInput; const step = input.discovery.asIsSteps[0]!; const req = input.discovery.requirements[0]!;
    const tb = rentalDraft.steps[0]!;
    const design = { ...rentalDraft, steps: [{ ...tb, asIsStepIds: [step.id], requirementIds: [req.id],
      acceptanceTests: tb.acceptanceTests.map(t => ({ ...t, requirementIds: [req.id] })) }],
    coverage: [{ requirementId: req.id, disposition: "IMPLEMENTED", stepIds: [tb.id], decisionId: null, rationale: "Covered by the proposed hire step." }],
    conflictDecisions: [], openQuestions: [] };
    return { payload: { design }, metrics: { stage: "to_be", provider: "anthropic", model: "synthetic-secret-model-name", inputTokens: 1,
      outputTokens: 1, latencyMs: 1, attempts: 1, validationErrors: [] } };
  }) as ReturnType<typeof createStageRunner>;
  async function reported() {
    const c = await confirmed();
    const queued = await call("POST", `${c.path}/to-be`, { token: c.owner.token, body: { expectedRevision: c.revision } });
    const jobId = queued.body.data.job.id as string;
    return { ...c, jobId, run: () => consultantJobs.execute(jobId, new AbortController().signal, scripted) };
  }

  it("serves the full validated To-Be report only for a finished job in the caller's own workspace", async () => {
    const r = await reported();
    const url = `${r.path}/to-be/${r.jobId}`;
    const pending = await call("GET", url, { token: r.owner.token });
    expect([pending.status, pending.body.error.code]).toEqual([404, "REPORT_NOT_FOUND"]);
    await r.run();

    const anonymous = await call("GET", url, { token: null });
    expect([anonymous.status, anonymous.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
    const outsider = await fixture();
    const foreign = await call("GET", url, { token: outsider.owner.token });
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain("Hire returns");
    const otherVariant = await call("POST", `${r.project.id}/consultant/OTHER`, { token: r.owner.token, body: { variantName: "Other process" } });
    expect(otherVariant.status).toBe(201);
    expect((await call("GET", `${r.project.id}/consultant/OTHER/to-be/${r.jobId}`, { token: r.owner.token })).status).toBe(404);
    expect((await call("GET", `${r.path}/to-be/${randomUUID()}`, { token: r.owner.token })).status).toBe(404);
    expect((await call("GET", `${r.path}/to-be/not-a-uuid`, { token: r.owner.token })).status).toBe(404);

    const ok = await call("GET", url, { token: r.owner.token });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("no-store");
    const report = ok.body.data.report;
    expect(Object.keys(report).sort()).toEqual(["blockers", "design", "discovery", "generatedAt", "jobId", "project", "references",
      "sourceRevision", "targetProduct", "targetRelease", "unresolvedInputQuestions", "variant"]);
    expect(report).toMatchObject({ jobId: r.jobId, project: { name: "Hire returns" }, variant: { code: "RENTAL", name: "Equipment hire" },
      sourceRevision: r.revision, design: { schemaVersion: 1 } });
    expect(report.design.steps.length).toBeGreaterThan(0);
    expect(report.discovery.asIsSteps[0].name).toBe("Record return");
    const wire = JSON.stringify(ok.body);
    expect(wire).not.toMatch(/metrics|synthetic-secret-model-name|inputTokens|"text"/);
    expect(report.discovery.sources.every((source: object) => !("text" in source))).toBe(true);

    const guest = await member(r.owner.user.orgId, r.project.id, "PROCESS_OWNER", "GUEST");
    expect((await call("GET", url, { token: guest.token })).status).toBe(200);
    expect((await call("POST", url, { token: r.owner.token, body: {} })).status).toBe(405);
  }, 30000);

  it("downloads the Markdown report and traceability CSV as attachments", async () => {
    const r = await reported(); await r.run();
    const md = await call("GET", `${r.path}/to-be/${r.jobId}/report.md`, { token: r.owner.token });
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(md.headers.get("content-disposition")).toMatch(/^attachment; filename="to-be-hire-returns-rental-r\d+\.md"$/);
    expect(md.headers.get("cache-control")).toBe("private, no-store");
    expect(md.headers.get("x-content-type-options")).toBe("nosniff");
    expect(md.body).toContain("## As-Is vs To-Be comparison");
    expect(md.body).toContain("Specified — not executed");
    expect(md.body).toContain("Record return");
    expect(md.body).not.toMatch(/synthetic-secret-model-name|metrics/);
    const csv = await call("GET", `${r.path}/to-be/${r.jobId}/traceability.csv`, { token: r.owner.token });
    expect(csv.headers.get("content-disposition")).toContain("traceability.csv");
    expect(csv.headers.get("cache-control")).toBe("private, no-store");
    expect(csv.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await call("GET", `${r.path}/to-be/${r.jobId}/constructor`, { token: r.owner.token })).status).toBe(404);
    expect((await call("GET", `${r.path}/to-be/${r.jobId}/__proto__`, { token: r.owner.token })).status).toBe(404);
    expect(csv.body.split("\r\n")[0]).toContain("Requirement,Type");
    expect((await call("GET", `${r.path}/to-be/${r.jobId}/other.txt`, { token: r.owner.token })).status).toBe(404);
    expect((await call("GET", `${r.path}/jobs/${r.jobId}`, { token: r.owner.token })).status).toBe(404);
    expect((await call("GET", `${r.path}/to-be/${r.jobId}/report.md`, { token: null })).status).toBe(401);
    const outsider = await fixture();
    expect((await call("GET", `${r.path}/to-be/${r.jobId}/report.md`, { token: outsider.owner.token })).status).toBe(404);
  }, 30000);

  it("lets a process owner contribute but never confirm or generate, and blocks guests", async () => {
    const c = await confirmed();
    const owner = await member(c.owner.user.orgId, c.project.id, "PROCESS_OWNER");
    const read = await call("GET", c.path, { token: owner.token });
    expect(read.body.data).toMatchObject({ canEdit: true, canConfirm: false });
    const edit = await command(c, c.revision, { type: "START_STEP_DRAFT" }, owner.token);
    expect(edit.status).toBe(200);
    const revision = edit.body.data.state.revision;
    const confirm = await command(c, revision, { type: "CONFIRM" }, owner.token);
    expect([confirm.status, confirm.body.error.code]).toEqual([403, "FORBIDDEN"]);
    const generate = await call("POST", `${c.path}/to-be`, { token: owner.token, body: { expectedRevision: revision } });
    expect(generate.status).toBe(409);
    expect(generate.body.error.code).toBe("DISCOVERY_NOT_CONFIRMED");
    const guest = await member(c.owner.user.orgId, c.project.id, "PROCESS_OWNER", "GUEST");
    expect((await call("GET", c.path, { token: guest.token })).body.data).toMatchObject({ canEdit: false, canConfirm: false });
    const blocked = await call("POST", `${c.path}/messages`, { token: guest.token, body: { expectedRevision: revision, text: "Guest note" } });
    expect([blocked.status, blocked.body.error.code]).toEqual([403, "FORBIDDEN"]);
    expect((await call("GET", c.path, { token: c.owner.token })).body.data.state.revision).toBe(revision);
  }, 20000);
});
