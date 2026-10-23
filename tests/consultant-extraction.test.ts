import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client, Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthService } from "../src/lib/auth";
import { createProjectRepository } from "../src/lib/tenant";
import { createDiscoveryWorkspaceRepository } from "../src/lib/discovery-workspace";
import { workConsultantQueues } from "../src/lib/consultant-workers";
import { createConsultantJobs } from "../src/lib/consultant-jobs";
import { awaitExtraction, CONSULTANT_EXTRACT_QUEUE, executeExtraction, extractMessage } from "../src/lib/consultant-extraction";
import type { createStageRunner } from "../src/lib/ai/runStage";
import type { InterviewInput } from "../src/lib/ai/discovery-interview";
import { askFirstGap } from "./support/context-fields";

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };
const metrics = (stage: "interview_turn" | "extraction_turn") => ({ stage, provider: "anthropic", model: "synthetic-test-double",
  inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1, validationErrors: [] });

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("background extraction of interview messages", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const database = `sap_extract_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 8, statement_timeout: 10000 });
  pool.on("error", () => {});
  const queue = new PgBoss({ connectionString: url.href });
  queue.on("error", () => {});
  const auth = createAuthService(pool, { secret: "synthetic-extraction-secret-for-tests-only", appUrl: "http://127.0.0.1:3017" });
  const projects = createProjectRepository(pool, auth);
  const workspaces = createDiscoveryWorkspaceRepository(pool, auth);
  const jobs = createConsultantJobs(pool, auth, queue, async () => {});
  let created = false;

  /** Chat answers with its first open gap; extraction proposes `current_systems` from the first sentence of its message. */
  const stage = (hooks: { chat?: (input: InterviewInput) => Promise<void>; extract?: (input: InterviewInput) => Promise<void> } = {}) =>
    (async (name: string, raw: unknown) => {
      const input = raw as InterviewInput;
      if (name === "interview_turn") {
        await hooks.chat?.(input);
        return { payload: { schemaVersion: 1, contextRevision: input.contextRevision, reply: "Thank you for that context.",
          questions: askFirstGap(input).map(q => ({ ...q, question: `${q.question} (${input.history.length})` })), proposedUpdates: [], proposedSteps: [], proposedRequirements: [], observations: [] }, metrics: metrics("interview_turn") };
      }
      await hooks.extract?.(input);
      const sentence = input.currentMessage.text.split(/(?<=\.)\s/)[0]!;
      const open = input.fields.find(field => field.id === "current_systems" && field.status === "EMPTY");
      return { payload: { schemaVersion: 1, contextRevision: input.contextRevision, reply: "Thank you for that context.", questions: [],
        proposedUpdates: open ? [{ fieldId: open.id, operation: "PROPOSE_SET", previousValue: null, sourceId: input.currentMessage.id, quote: sentence, value: sentence }] : [],
        proposedSteps: [], proposedRequirements: [], observations: [] }, metrics: metrics("extraction_turn") };
    }) as unknown as ReturnType<typeof createStageRunner>;

  async function start(text = "The rental coordinator tracks dispatch in a spreadsheet today. Returns are logged late.") {
    const owner = await auth.signup({ name: "Synthetic participant", email: `extract-${randomUUID()}@test.local`,
      password: "Password123!", orgName: "Extraction test" });
    const project = await projects.create(owner.token, { name: "Rental discovery", clientName: "Synthetic Rental",
      problemStatement: "Manual rental dispatch and invoice handoffs cause repeated entry, delays and reconciliation errors.",
      targetProduct: "S4HANA_CLOUD_PRIVATE", modules: ["SD"] }, randomUUID());
    const initial = await workspaces.create(owner.token, project.id, "RENTAL", { variantName: "Equipment rental", targetRelease: null }, randomUUID());
    const ctx = { owner, project, revision: initial.state.revision, messageId: "" };
    await say(ctx, text);
    return ctx;
  }
  async function say(ctx: Awaited<ReturnType<typeof start>>, text: string) {
    const current = await workspaces.command(ctx.owner.token, ctx.project.id, "RENTAL", (await state(ctx)).revision, randomUUID(), { type: "SEND_MESSAGE", text });
    ctx.revision = current.state.revision;
    ctx.messageId = current.state.messages.findLast(message => message.role === "user")!.id;
  }
  const state = async (ctx: { owner: { token: string }; project: { id: string } }) => (await workspaces.get(ctx.owner.token, ctx.project.id, "RENTAL")).state!;
  const worker = (ctx: Awaited<ReturnType<typeof start>>) => ({ orgId: ctx.owner.user.orgId, projectId: ctx.project.id, variantCode: "RENTAL", requestedBy: ctx.owner.user.id });
  const enqueue = (ctx: Awaited<ReturnType<typeof start>>, key = randomUUID()) => jobs.enqueue(ctx.owner.token, ctx.project.id, "RENTAL",
    { kind: "INTERVIEW", expectedRevision: ctx.revision, messageId: ctx.messageId }, key);
  const extractJobs = async (projectId: string) => (await pool.query(`SELECT id,data,state FROM pgboss.job WHERE name=$1 AND data->>'projectId'=$2 ORDER BY (data->>'seq')::int`,
    [CONSULTANT_EXTRACT_QUEUE, projectId])).rows;
  const chatStatus = async (ctx: Awaited<ReturnType<typeof start>>) => (await jobs.latest(ctx.owner.token, ctx.project.id, "RENTAL")).jobs[0]!.status;
  /** Park every extraction/chat job left over from other tests so a started worker only sees this test's jobs. */
  const park = async (keepProject: string) => {
    await pool.query(`UPDATE consultant_jobs SET status='FAILED',finished_at=clock_timestamp() WHERE status='QUEUED' AND project_id<>$1`, [keepProject]);
    await pool.query(`UPDATE pgboss.job SET state='cancelled' WHERE name=$1 AND state='created' AND data->>'projectId'<>$2`, [CONSULTANT_EXTRACT_QUEUE, keepProject]);
  };

  beforeAll(async () => {
    await admin.connect(); await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)("pnpm", ["db:seed"], { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
    await queue.start(); await jobs.initialize();
  }, 40000);
  afterAll(async () => {
    await queue.stop({ graceful: true }); await pool.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }, 15000);

  it("queues exactly one extraction job with each interview turn, in the same transaction, and not again on replay", async () => {
    const ctx = await start(); const key = randomUUID();
    const first = await enqueue(ctx, key); await enqueue(ctx, key);
    const queued = await extractJobs(ctx.project.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.data).toMatchObject({ projectId: ctx.project.id, variantCode: "RENTAL", requestedBy: ctx.owner.user.id, messageId: ctx.messageId, seq: 1 });
    expect(queued[0]!.id).not.toBe(first.id);
    // A failure while queueing the extraction rolls the whole enqueue back: no chat job row, no extraction job.
    const other = await start();
    const original = queue.send.bind(queue);
    const spy = vi.spyOn(queue, "send").mockImplementation(async (...args: Parameters<typeof queue.send>) => {
      if (args[0] === CONSULTANT_EXTRACT_QUEUE) { await original(...args); throw new Error("Injected extraction queue failure"); }
      return original(...args);
    });
    try { await expect(enqueue(other)).rejects.toThrow("Injected extraction queue failure"); } finally { spy.mockRestore(); }
    expect((await pool.query("SELECT 1 FROM consultant_jobs WHERE project_id=$1", [other.project.id])).rowCount).toBe(0);
    expect(await extractJobs(other.project.id)).toHaveLength(0);
  });

  it("answers while the extraction is still running, tells the interviewer which messages are not extracted, and keeps message order", async () => {
    const ctx = await start("We use a spreadsheet to track dispatch. Returns are logged late.");
    const first = ctx.messageId;
    const firstJob = await enqueue(ctx);
    await park(ctx.project.id);
    const hold = gate(); const order: string[] = []; let chatInput: InterviewInput | undefined;
    const shutdown = new AbortController();
    const workers = await workConsultantQueues(queue, jobs, stage({
      extract: async input => { order.push(`start:${input.currentMessage.id === first ? "first" : "second"}`); if (input.currentMessage.id === first) await hold.promise; },
      chat: async input => { chatInput = input; },
    }), { chatConcurrency: 1, batchConcurrency: 1, shutdown: shutdown.signal, pollingIntervalSeconds: 0.5,
      extract: { pool, concurrency: 2, maxWaitSeconds: 30 } });
    try {
      // The reply arrives while the first message is still being read.
      await expect.poll(() => chatStatus(ctx), { timeout: 15000, interval: 200 }).toBe("SUCCEEDED");
      expect((await state(ctx)).extractedMessageIds ?? []).not.toContain(first);
      // The participant answers; the second turn is accepted although the revision moved on (a reply was recorded).
      await say(ctx, "Dispatch is booked by phone. The coordinator keeps the list.");
      const second = ctx.messageId;
      const secondJob = await enqueue(ctx);
      await expect.poll(() => chatStatus(ctx), { timeout: 15000, interval: 200 }).toBe("SUCCEEDED");
      expect(secondJob.id).not.toBe(firstJob.id);
      // The interviewer was told message 1 is not extracted and was given its full text.
      expect(chatInput!.unextractedMessageIds).toEqual([first]);
      expect(chatInput!.evidence.find(source => source.id === first)!.text).toContain("spreadsheet to track dispatch");
      // Message 2's extraction never starts while message 1's is held.
      await new Promise(resolve => setTimeout(resolve, 1500));
      expect(order).toEqual(["start:first"]);
      hold.open();
      await awaitExtraction(async () => state(ctx), second, { timeoutMs: 20000, pollMs: 200 });
      expect(order).toEqual(["start:first", "start:second"]);
      const final = await state(ctx);
      expect(final.extractedMessageIds).toEqual([first, second]);
      expect(final.messages.filter(message => message.role === "assistant")).toHaveLength(2); // extraction adds no assistant message
      expect(final.proposals.filter(p => p.status === "PENDING")).toMatchObject([{ fieldId: "current_systems", sourceId: first, quote: "We use a spreadsheet to track dispatch." }]);
    } finally { hold.open(); shutdown.abort(); await workers.stop(); }
  }, 60000);

  it("records a message's extraction once, however often the job runs", async () => {
    const ctx = await start("Dispatch uses a whiteboard. Nothing else is recorded.");
    const extract = vi.fn(async () => {});
    const run = stage({ extract });
    const key = randomUUID();
    const [a, b] = await Promise.all([extractMessage(pool, run, worker(ctx), ctx.messageId, key), extractMessage(pool, run, worker(ctx), ctx.messageId, key)]);
    expect([a.status, b.status].filter(status => status === "RECORDED").length).toBeGreaterThanOrEqual(1);
    const again = await extractMessage(pool, run, worker(ctx), ctx.messageId, randomUUID());
    expect(again.status).toBe("ALREADY_EXTRACTED");
    const final = await state(ctx);
    expect(final.extractedMessageIds).toEqual([ctx.messageId]);
    expect(final.proposals).toHaveLength(1);
    expect(final.proposals[0]).toMatchObject({ operation: "PROPOSE_SET", quote: "Dispatch uses a whiteboard.", value: "Dispatch uses a whiteboard." });
  });

  it("lets a failed extraction leave the message unextracted, still visible to the interviewer, without blocking the next one", async () => {
    const ctx = await start("A clerk keys returns into a sheet. They are late.");
    const failing = stage({ extract: async () => { throw new Error("provider down"); } });
    await expect(extractMessage(pool, failing, worker(ctx), ctx.messageId, randomUUID())).rejects.toThrow("provider down");
    expect((await state(ctx)).extractedMessageIds ?? []).toEqual([]);
    const first = ctx.messageId;
    await say(ctx, "Billing waits for the sheet. Invoices go out on Friday.");
    const outcome = await extractMessage(pool, stage(), worker(ctx), ctx.messageId, randomUUID());
    expect(outcome.status).toBe("RECORDED");
    // The first message is still listed as unextracted for the chat call.
    const { buildInterviewInput } = await import("../src/lib/discovery-workspace-model");
    expect(buildInterviewInput(await state(ctx), ctx.messageId).unextractedMessageIds).toEqual([first]);
  });

  it("ignores malformed queue payloads, and awaitExtraction fails closed on timeout", async () => {
    const ctx = await start("Stores log returns on paper. Some are lost.");
    expect(await executeExtraction(pool, stage(), { id: randomUUID(), data: { nonsense: true } }, new AbortController().signal, 5)).toBeUndefined();
    await expect(awaitExtraction(async () => state(ctx), ctx.messageId, { timeoutMs: 400, pollMs: 100 })).rejects.toThrow("EXTRACTION_AWAIT_TIMEOUT");
  });
});
