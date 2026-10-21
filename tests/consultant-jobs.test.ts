import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import bcrypt from "bcryptjs";
import { Client, Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthService } from "../src/lib/auth";
import { createProjectRepository, withTenantSession } from "../src/lib/tenant";
import { createDiscoveryWorkspaceRepository } from "../src/lib/discovery-workspace";
import { CONSULTANT_QUEUE, createConsultantJobs } from "../src/lib/consultant-jobs";
import type { createStageRunner } from "../src/lib/ai/runStage";
import type { InterviewInput } from "../src/lib/ai/discovery-interview";
import type { ToBeInput } from "../src/lib/ai/to-be";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("durable consultant conversations", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const database = `sap_consultant_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 8, statement_timeout: 10000 });
  pool.on("error", () => {});
  const queue = new PgBoss({ connectionString: url.href });
  queue.on("error", () => {});
  const auth = createAuthService(pool, { secret: "synthetic-consultant-secret-for-tests-only", appUrl: "http://127.0.0.1:3017" });
  const projects = createProjectRepository(pool, auth);
  const workspaces = createDiscoveryWorkspaceRepository(pool, auth);
  const jobs = createConsultantJobs(pool, auth, queue, async () => {});
  let created = false;
  const runner = (observe?: (input: InterviewInput) => Promise<void>): ReturnType<typeof createStageRunner> =>
    (async (_stage: string, raw: unknown) => {
      const input = raw as InterviewInput;
      await observe?.(input);
      return { payload: { schemaVersion: 1, contextRevision: input.contextRevision,
        reply: "Thank you for that context.", questions: [], proposedUpdates: [], observations: [] },
      metrics: { stage: "interview_turn", provider: "anthropic", model: "synthetic-test-double", inputTokens: 1,
        outputTokens: 1, latencyMs: 1, attempts: 1, validationErrors: [] } };
    }) as ReturnType<typeof createStageRunner>;
  async function draft() {
    const owner = await auth.signup({ name: "Synthetic participant", email: `consultant-${randomUUID()}@test.local`,
      password: "Password123!", orgName: "Consultant test" });
    const project = await projects.create(owner.token, { name: "Rental discovery", clientName: "Synthetic Rental",
      problemStatement: "Manual rental dispatch and invoice handoffs cause repeated entry, delays and reconciliation errors.",
      targetProduct: "S4HANA_CLOUD_PRIVATE", modules: ["SD"] }, randomUUID());
    const initial = await workspaces.create(owner.token, project.id, "RENTAL", { variantName: "Equipment rental", targetRelease: null }, randomUUID());
    const current = await workspaces.command(owner.token, project.id, "RENTAL", initial.state.revision, randomUUID(),
      { type: "SEND_MESSAGE", text: "The rental coordinator tracks dispatch in a spreadsheet today." });
    return { ...owner, project, state: current.state, messageId: current.state.messages.at(-1)!.id };
  }
  const enqueue = (owner: Awaited<ReturnType<typeof draft>>, key = randomUUID()) => jobs.enqueue(owner.token, owner.project.id,
    "RENTAL", { kind: "INTERVIEW", expectedRevision: owner.state.revision, messageId: owner.messageId }, key);
  const execute = (id: string, run = runner()) => jobs.execute(id, new AbortController().signal, run);


  /** A runner for the To-Be stage that maps the benchmark design onto the confirmed workspace's own ids. */
  const toBeRunner = (observe?: (input: ToBeInput) => Promise<void>): ReturnType<typeof createStageRunner> =>
    (async (_stage: string, raw: unknown) => {
      const input = raw as ToBeInput; await observe?.(input);
      const step = input.discovery.asIsSteps[0]!; const req = input.discovery.requirements[0]!;
      const tb = rentalDraft.steps[0]!;
      const design = { ...rentalDraft, steps: [{ ...tb, asIsStepIds: [step.id], requirementIds: [req.id],
        acceptanceTests: tb.acceptanceTests.map(t => ({ ...t, requirementIds: [req.id] })) }],
      coverage: [{ requirementId: req.id, disposition: "IMPLEMENTED", stepIds: [tb.id], decisionId: null, rationale: "Covered by the proposed hire step." }],
      conflictDecisions: [], openQuestions: [] };
      return { payload: { design }, metrics: { stage: "to_be", provider: "anthropic", model: "synthetic-test-double", inputTokens: 1,
        outputTokens: 1, latencyMs: 1, attempts: 1, validationErrors: [] } };
    }) as ReturnType<typeof createStageRunner>;
  async function confirmed() {
    const owner = await draft(); let current = await workspaces.get(owner.token, owner.project.id, "RENTAL");
    const run = async (command: object) => {
      current = await workspaces.command(owner.token, owner.project.id, "RENTAL", current.state!.revision, randomUUID(), command);
    };
    for (const [fieldId, value] of [["process_owner", "Rental lead"], ["scope_boundary", "From dispatch to final invoice"],
      ["current_trigger", "Asset dispatched"], ["desired_outcome", "Accurate final invoices"],
      ["current_systems", "Spreadsheet and paper return note"], ["current_rules", "Stores records the date before billing review"],
      ["current_exceptions", "Missing return date is escalated to the stores lead"],
      ["current_financial", "Billing adjusts the final invoice after return"], ["desired_controls", "Require a dated return record for audit"],
    ] as const) await run({ type: "SET_FIELD", fieldId, status: "KNOWN", value, rationale: null, owner: null, sourceId: null, quote: null });
    await run({ type: "ADD_STEP", step: { name: "Record return", actor: "Stores clerk", system: "Spreadsheet",
      trigger: "Asset physically returned", description: "Record the return date in the spreadsheet.",
      inputs: ["Return note"], outputs: ["Return record"], controls: [], exceptions: [] } });
    await run({ type: "ADD_REQUIREMENT", requirement: { asIsStepId: current.state!.steps[0]!.id,
      kind: "TO_BE_REQUIREMENT", statement: "Require a return date before invoicing.", critical: true } });
    await run({ type: "CONFIRM" });
    return { ...owner, state: current.state!, snapshotId: current.confirmedSnapshotId! };
  }
  const enqueueToBe = (c: Awaited<ReturnType<typeof confirmed>>) => jobs.enqueue(c.token, c.project.id, "RENTAL",
    { kind: "TO_BE", expectedRevision: c.state.revision }, randomUUID());

  beforeAll(async () => {
    await admin.connect(); await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)("pnpm", ["db:seed"], { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
    await queue.start(); await jobs.initialize();
  }, 40000);
  afterAll(async () => {
    await queue.stop({ graceful: true }); await pool.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }, 15000);

  it("replays concurrent same-key submissions, rejects different pending keys and rolls back queue failures", async () => {
    const owner = await draft(); const key = randomUUID();
    const [a, b] = await Promise.all([enqueue(owner, key), enqueue(owner, key)]);
    expect(a.id).toBe(b.id);
    expect((await queue.getJobById(CONSULTANT_QUEUE, a.id))?.data).toEqual({ jobId: a.id });
    await expect(enqueue(owner)).rejects.toMatchObject({ code: "JOB_ALREADY_RUNNING" });
    await expect(jobs.enqueue(owner.token, owner.project.id, "RENTAL", { kind: "TO_BE", expectedRevision: owner.state.revision }, key))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const other = await draft();
    const original = queue.send.bind(queue);
    const spy = vi.spyOn(queue, "send").mockImplementationOnce(async (...args: Parameters<typeof queue.send>) => {
      await original(...args); throw new Error("Injected queue failure");
    });
    try { await expect(enqueue(other)).rejects.toThrow("Injected queue failure"); } finally { spy.mockRestore(); }
    expect((await pool.query("SELECT id FROM consultant_jobs WHERE project_id=$1", [other.project.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM pgboss.job WHERE name=$1 AND data->>'jobId' NOT IN (SELECT id::text FROM consultant_jobs)", [CONSULTANT_QUEUE])).rowCount).toBe(0);
  });

  it("persists exactly one turn and never sends actor or organization identity to the model", async () => {
    const owner = await draft(); const job = await enqueue(owner); const seen = vi.fn();
    // Either concurrent caller may win the QUEUED->RUNNING claim; both observe so the winner is irrelevant.
    await Promise.all([execute(job.id, runner(async input => { seen(input); })), execute(job.id, runner(async input => { seen(input); }))]);
    expect(seen).toHaveBeenCalledOnce();
    const context = JSON.stringify(seen.mock.calls[0]![0]);
    for (const identity of [owner.user.id, owner.user.orgId, owner.user.email, owner.project.id]) expect(context).not.toContain(identity);
    const result = (await jobs.latest(owner.token, owner.project.id, "RENTAL")).jobs[0]!;
    expect(result).toMatchObject({ status: "SUCCEEDED", result: { workspaceRevision: owner.state.revision + 1 } });
    const saved = await workspaces.get(owner.token, owner.project.id, "RENTAL");
    expect(saved.state?.messages.filter(m => m.role === "assistant")).toHaveLength(1);
    expect((await enqueue(owner, (await pool.query("SELECT request_key FROM consultant_jobs WHERE id=$1", [job.id])).rows[0].request_key)).id).toBe(job.id);
  });

  it("discards a late response after a user edit and after access revocation", async () => {
    const owner = await draft(); const job = await enqueue(owner);
    await execute(job.id, runner(async () => {
      await workspaces.command(owner.token, owner.project.id, "RENTAL", owner.state.revision, randomUUID(),
        { type: "SEND_MESSAGE", text: "Correction: a warehouse clerk records the physical dispatch." });
    }));
    expect((await jobs.latest(owner.token, owner.project.id, "RENTAL")).jobs[0]).toMatchObject({ status: "FAILED", error: { code: "STALE_INPUT" }, result: null });
    expect((await workspaces.get(owner.token, owner.project.id, "RENTAL")).state?.messages.filter(m => m.role === "assistant")).toHaveLength(0);
    const other = await draft(); const revoked = await enqueue(other);
    await execute(revoked.id, runner(async () => { await pool.query("UPDATE users SET org_role='GUEST' WHERE id=$1", [other.user.id]); }));
    expect((await pool.query("SELECT status,result FROM consultant_jobs WHERE id=$1", [revoked.id])).rows[0]).toEqual({ status: "FAILED", result: null });
  });

  it("blocks unconfirmed To-Be jobs, cross-tenant reads and tenant completion writes while process owners can interview", async () => {
    const owner = await draft(); const other = await draft();
    await expect(jobs.enqueue(owner.token, owner.project.id, "RENTAL", { kind: "TO_BE", expectedRevision: owner.state.revision }, randomUUID()))
      .rejects.toMatchObject({ code: "DISCOVERY_NOT_CONFIRMED" });
    await pool.query("UPDATE project_memberships SET project_role='PROCESS_OWNER' WHERE project_id=$1", [owner.project.id]);
    const job = await enqueue(owner);
    await expect(jobs.latest(other.token, owner.project.id, "RENTAL")).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    await withTenantSession(pool, auth, other.token, async ({ client }) => {
      expect((await client.query("SELECT id FROM consultant_jobs WHERE id=$1", [job.id])).rowCount).toBe(0);
    });
    await expect(withTenantSession(pool, auth, owner.token, ({ client }) => client.query("UPDATE consultant_jobs SET status='SUCCEEDED' WHERE id=$1", [job.id])))
      .rejects.toMatchObject({ code: "42501" });
    await execute(job.id);
    expect((await jobs.latest(owner.token, owner.project.id, "RENTAL")).jobs[0]?.status).toBe("SUCCEEDED");
  });

  it("fences timed-out and recovered jobs even if a provider returns successfully later", async () => {
    const owner = await draft(); const job = await enqueue(owner);
    await execute(job.id, runner(async () => {
      await pool.query("UPDATE consultant_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
      await jobs.recover();
    }));
    expect((await jobs.latest(owner.token, owner.project.id, "RENTAL")).jobs[0]).toMatchObject({ status: "FAILED", error: { code: "AI_TIMEOUT" }, result: null });
    expect((await workspaces.get(owner.token, owner.project.id, "RENTAL")).state?.messages.filter(m => m.role === "assistant")).toHaveLength(0);
  });
  it("completes a To-Be job from a confirmed revision and stores the validated design on the job", async () => {
    const c = await confirmed(); const job = await enqueueToBe(c);
    await execute(job.id, toBeRunner());
    const done = (await jobs.latest(c.token, c.project.id, "RENTAL")).jobs[0]!;
    expect(done).toMatchObject({ kind: "TO_BE", status: "SUCCEEDED", error: null });
    expect(done.result).toMatchObject({ sourceRevision: c.state.revision, snapshotId: c.snapshotId });
    expect((done.result as { design: { steps: unknown[] } }).design.steps).toHaveLength(1);
    expect((done.result as { status: string }).status).toMatch(/^(BLOCKED|HUMAN_REVIEW_REQUIRED)$/);
  });

  it("fences a To-Be job whose workspace revision changed after enqueue", async () => {
    const c = await confirmed(); const job = await enqueueToBe(c);
    await execute(job.id, toBeRunner(async () => {
      await workspaces.command(c.token, c.project.id, "RENTAL", c.state.revision, randomUUID(),
        { type: "SEND_MESSAGE", text: "Correction: billing also reviews every return." });
    }));
    expect((await jobs.latest(c.token, c.project.id, "RENTAL")).jobs[0]).toMatchObject({ status: "FAILED", error: { code: "STALE_INPUT" }, result: null });
  });

  it("denies workspace reads, writes and job enqueue once a tenant user's membership is removed", async () => {
    const owner = await draft(); const id = randomUUID(); const email = `removed-${id}@test.local`;
    await pool.query(`INSERT INTO users(id,org_id,email,name,org_role,password_hash) VALUES($1,$2,$3,'Removed member','MEMBER',$4)`,
      [id, owner.user.orgId, email, await bcrypt.hash("Password123!", 12)]);
    await pool.query(`INSERT INTO project_memberships(org_id,project_id,user_id,project_role) VALUES($1,$2,$3,'CONSULTANT')`,
      [owner.user.orgId, owner.project.id, id]);
    const { token } = await auth.login({ email, password: "Password123!" });
    expect((await workspaces.get(token, owner.project.id, "RENTAL")).state?.revision).toBe(owner.state.revision);
    await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [owner.project.id, id]);
    await expect(workspaces.get(token, owner.project.id, "RENTAL")).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    await expect(workspaces.command(token, owner.project.id, "RENTAL", owner.state.revision, randomUUID(),
      { type: "SEND_MESSAGE", text: "I should not be able to write this." })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    await expect(jobs.enqueue(token, owner.project.id, "RENTAL", { kind: "INTERVIEW", expectedRevision: owner.state.revision,
      messageId: owner.messageId }, randomUUID())).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    expect((await workspaces.get(owner.token, owner.project.id, "RENTAL")).state?.messages.at(-1)?.id).toBe(owner.messageId);
  });
});
