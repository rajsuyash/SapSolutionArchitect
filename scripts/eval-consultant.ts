// Phase-0 evaluation harness for the discovery interviewer and To-Be generator.
//
//   node --import tsx --env-file-if-exists=.env scripts/eval-consultant.ts --replay <transcript.json> [--case fixtures/eval/pump-o2c.json]
//   node --import tsx --env-file-if-exists=.env scripts/eval-consultant.ts --live --provider <anthropic|deepinfra|openrouter> --model <id> [--runs N] [--max-turns 25] [--no-force-complete] [--no-tobe]
//
// --live --provider stub --model stub [--fake-model] is the offline dry run: plain stub stops at the first model call
// (runStage has no stub interviewer); --fake-model swaps in a scripted model to exercise the whole driver at zero cost.
//
// --tobe-only skips the interview: the discovery is entered from the fixture (As-Is steps, requirements, company context), confirmed,
// and the real To-Be stage runs; the run file has the same format, so eval-judge.ts --run accepts it.
// --no-tobe makes the run interview-only: no forced completion, no CONFIRM, no To-Be (a diagnostic of the interviewer alone).
//
// --replay scores a saved transcript: no network, no database.
// --live drives the REAL production path (workspace repositories, buildInterviewInput, runStage, persistWorkspaceTurn,
// compileDiscovery, runStage("to_be")) against a fresh disposable database on local PostgreSQL, with a simulated user that
// accepts every proposal and answers from the fixture's answerBank. It makes real model calls and costs money:
// the run aborts once cumulative output tokens exceed OUTPUT_TOKEN_CAP. Transcripts land in the gitignored test-results/eval/.
//
// The driver creates no steps or requirements: the interviewer proposes them from the conversation and the simulated user
// accepts every proposal in one DECIDE_PROPOSALS call. A step walkthrough question is answered with one natural paragraph
// built from that fixture step (what happens, who, system, controls, exceptions, pain points and wants).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client, Pool } from "pg";
import { AIStageError, createStageRunner, runStage, type StageMetrics } from "../src/lib/ai/runStage";
import { parseEnvironment } from "../src/lib/env";
import { loadToBeReferences, parseToBeInput, validateToBeOutput } from "../src/lib/ai/to-be";
import { createAuthService, transaction } from "../src/lib/auth";
import { createProjectRepository } from "../src/lib/tenant";
import { createDiscoveryWorkspaceRepository, persistWorkspaceTurn } from "../src/lib/discovery-workspace";
import { extractMessage } from "../src/lib/consultant-extraction";
import { buildInterviewInput, type WorkspaceState } from "../src/lib/discovery-workspace-model";
import { STEP_KEYS } from "../src/lib/workspace-fields";
import { answerFor, composeReply, factStatus, fieldCommand, firstSentence, planForcedCompletion, type Asked, type Command, type Fixture } from "../src/lib/eval-user";
import { toBeRun, toBeSummary } from "../src/lib/eval-tobe";
import { ScoringCaseSchema, scoreRun, summarize, TranscriptSchema, type Transcript } from "../src/lib/eval-score";

const OUTPUT_TOKEN_CAP = 400_000;
const DEFAULT_MAX_TURNS = 25;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_CASE = "fixtures/eval/pump-o2c.json";
const PROVIDERS = ["anthropic", "deepinfra", "openrouter", "stub"] as const;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const loadFixture = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Fixture;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// --- scripted model (driver self-test, --fake-model) -------------------------------------------------------------

/** Offline stand-in for runStage so the driver loop can be exercised end to end without a provider or any cost.
 * It asks the first three open gaps (one per step) and extracts a field, step or requirement only when the user's message
 * contains the bank text verbatim.
 * Its To-Be is the repository's one-step rental benchmark remapped onto the workspace ids: a plumbing check, never a quality score. */
function scriptedStage(fixture: Fixture, getState: () => WorkspaceState): typeof runStage {
  const metrics = (stage: "interview_turn" | "extraction_turn" | "to_be") => ({ stage, provider: "stub" as const, model: "scripted", inputTokens: 1,
    outputTokens: 1, latencyMs: 1, attempts: 1, validationErrors: [] });
  return (async (stage: string, raw: unknown) => {
    if (stage === "to_be") {
      const input = raw as ReturnType<typeof parseToBeInput>;
      const { rentalDraft } = await import("../fixtures/ai/to-be/rental-benchmark");
      const tb = rentalDraft.steps[0]!, step = input.discovery.asIsSteps[0]!, req = input.discovery.requirements[0]!;
      const design = { ...rentalDraft, steps: [{ ...tb, asIsStepIds: [step.id], requirementIds: [req.id],
        acceptanceTests: tb.acceptanceTests.map(t => ({ ...t, requirementIds: [req.id] })) }],
      coverage: [{ requirementId: req.id, disposition: "IMPLEMENTED", stepIds: [tb.id], decisionId: null, rationale: "Scripted coverage." }],
      conflictDecisions: [], openQuestions: [] };
      return { payload: { design }, metrics: metrics("to_be") };
    }
    const input = raw as ReturnType<typeof buildInterviewInput>;
    const state = getState();
    const message = input.currentMessage.text;
    const taken = new Set<string>();
    const questions = input.activeGaps.filter(g => !g.stepId || !taken.has(g.stepId) && !!taken.add(g.stepId)).slice(0, 3);
    // A stage of the process is proposed from the first sentence of a fixture step quoted in the user's message.
    const known = (text: string) => input.steps.some(x => x.summary === text);
    const proposedSteps = fixture.steps.filter(x => message.includes(firstSentence(x.description)) && !known(firstSentence(x.description)))
      .map(x => ({ sourceId: input.currentMessage.id, quote: firstSentence(x.description), nameHint: message.includes(x.name) ? x.name : null }));
    const draftFor = (n: number) => input.steps.find(x => x.status === "CURRENT" && x.summary?.startsWith(firstSentence(fixture.steps[n - 1]!.description)));
    const proposedRequirements = fixture.requirements.flatMap(r => {
      const target = draftFor(r.stepN), fresh = proposedSteps.findIndex(x => x.quote === firstSentence(fixture.steps[r.stepN - 1]!.description));
      const stepRef = target?.id ?? (fresh >= 0 ? `new_${fresh}` : null);
      return stepRef && message.includes(r.statement) && !input.requirements.some(x => x.statement === r.statement)
        ? [{ stepRef, kind: r.kind, critical: r.critical, sourceId: input.currentMessage.id, quote: r.statement }] : [];
    });
    if (stage === "interview_turn") return { payload: { schemaVersion: 1, contextRevision: input.contextRevision, reply: "Thank you for that context.",
      questions: questions.map(g => ({ gapKey: g.key, question: `Scripted question about ${g.fieldId}`,
        whyItMatters: "It decides how this step is designed." })), proposedUpdates: [], proposedSteps: [], proposedRequirements: [], observations: [] },
      metrics: metrics("interview_turn") };
    return { payload: { schemaVersion: 1, contextRevision: input.contextRevision, reply: "Thank you for that context.", questions: [],
      proposedUpdates: input.fields.flatMap(f => {
        const answer = f.status === "EMPTY" ? answerFor(fixture, state, f.id) : null;
        return answer && message.includes(answer) ? [{ fieldId: f.id, operation: "PROPOSE_SET" as const,
          previousValue: null, value: answer, sourceId: input.currentMessage.id, quote: answer }] : [];
      }), proposedSteps, proposedRequirements, observations: [] }, metrics: metrics("extraction_turn") };
  }) as unknown as typeof runStage;
}

/** Per-turn fields taken from runStage metrics; identical for the success and the AIStageError path. */
function metricsRecord(m: StageMetrics) {
  const groups = m.attemptIssues ?? (m.validationErrors.length ? [m.validationErrors] : []);
  return { model: m.model, attempts: m.attempts, validationErrors: m.validationErrors.length,
    issues: groups.flatMap((group, i) => group.map(issue => ({ attempt: i + 1, ...issue }))),
    stopReasons: m.stopReasons ?? [], warnings: (m.warnings ?? []).map(({ path, code, detail }) => ({ path, code, ...(detail ? { detail } : {}) })),
    textFallbacks: m.textFallbacks ?? 0,
    inputTokens: m.inputTokens, outputTokens: m.outputTokens, latencyMs: m.latencyMs };
}

// --- one live run -----------------------------------------------------------------------------------------------

async function runOnce(fixture: Fixture, deps: { pool: Pool; provider: string; model: string; maxTurns: number; forceComplete: boolean; fake: boolean; toBe: boolean; toBeOnly: boolean }) {
  const { pool, maxTurns } = deps;
  const auth = createAuthService(pool, { secret: process.env.AUTH_SECRET!, appUrl: process.env.APP_URL! });
  const workspaces = createDiscoveryWorkspaceRepository(pool, auth);
  const owner = await auth.signup({ name: "Eval consultant", email: `eval-${randomUUID()}@test.local`,
    password: "Password123!", orgName: `Eval ${fixture.caseId}` });
  const project = await createProjectRepository(pool, auth).create(owner.token, fixture.project, randomUUID());
  const variant = fixture.project.variantCode;
  const worker = { orgId: owner.user.orgId, projectId: project.id, variantCode: variant, requestedBy: owner.user.id };
  let current = await workspaces.create(owner.token, project.id, variant, { variantName: fixture.project.variantName, targetRelease: (fixture.project.targetRelease as string | undefined) ?? null }, randomUUID());
  let state = current.state;
  const run = async (command: Command) => {
    current = await workspaces.command(owner.token, project.id, variant, state.revision, randomUUID(), command);
    state = current.state;
  };
  // A private runner (not the production singleton) so issue messages are recorded in the eval transcript only.
  const stage = deps.fake ? scriptedStage(fixture, () => state) : createStageRunner(parseEnvironment(), { issueDetail: true, captureRaw: true }) as typeof runStage;

  const transcript: Transcript = { schemaVersion: 1, caseId: fixture.caseId, provider: deps.provider, model: deps.model,
    startedAt: new Date().toISOString(), turns: [],
    readiness: { reached: false, atTurn: null, forcedCompletion: false, directEdits: 0, blockers: [] }, toBe: null, aborted: null };
  if (deps.toBeOnly) {
    // --tobe-only: no interview. The discovery is entered directly from the fixture's expected As-Is, through the same
    // commands a person uses, confirmed, and handed to the real To-Be stage. Measures To-Be quality alone.
    transcript.readiness.forcedCompletion = true;
    try {
      let edits = 0;
      const set = async (fieldId: string, value: string) => { await run(fieldCommand(state, fieldId, value)); edits++; };
      for (const [fieldId, value] of Object.entries(fixture.answerBank.catalog)) {
        if (state.facts.some(f => f.id === fieldId && f.status !== "KNOWN")) await set(fieldId, value);
      }
      const draftOf = new Map<number, string>();
      for (const step of fixture.steps) {
        await run({ type: "START_STEP_DRAFT" });
        const draft = state.stepDrafts.at(-1)!;
        draftOf.set(step.n, draft.id);
        for (const key of STEP_KEYS) await set(`${draft.id}_${key}`, step[key]);
      }
      for (const req of fixture.requirements) {
        await run({ type: "START_REQUIREMENT_DRAFT", asIsStepId: draftOf.get(req.stepN)!, kind: req.kind, critical: req.critical });
        await set(state.requirementDrafts.at(-1)!.statement.id, req.statement);
      }
      transcript.readiness.directEdits = edits;
      transcript.structure = { steps: state.stepDrafts.length, requirements: state.requirementDrafts.length };
      transcript.readiness.blockers = (current.readiness?.blockers ?? []).map(b => b.code);
      if (!current.readiness?.ready) {
        for (const b of current.readiness?.blockers ?? []) console.log(`tobe-only: blocker ${b.code} (${b.detail})`);
        transcript.aborted = "fixture entry left readiness blockers";
      } else {
        await run({ type: "CONFIRM" });
        transcript.toBe = await generateToBe(pool, current.confirmedSnapshotId!, stage);
      }
    } catch (error) { transcript.aborted = `driver error: ${message(error).slice(0, 200)}`; }
    return TranscriptSchema.parse(transcript);
  }
  let outputTokens = 0, failures = 0, directEdits = 0;
  const told = new Set<number>(); // fixture steps already described to the interviewer
  const capExceeded = () => outputTokens > OUTPUT_TOKEN_CAP;
  /** The simulated user accepts every proposal at once. One that no longer fits the answers is rejected, as a person would. */
  const resolvePending = async () => {
    const pending = state.proposals.filter(p => p.status === "PENDING");
    if (pending.length) {
      try { await run({ type: "DECIDE_PROPOSALS", ids: pending.map(p => p.id), decision: "ACCEPT" }); }
      catch (error) { if ((error as { code?: string }).code !== "STALE_PROPOSAL") throw error; }
      for (const proposal of state.proposals.filter(p => p.status === "PENDING")) {
        await run({ type: "DECIDE_PROPOSAL", proposalId: proposal.id, decision: "REJECT" });
      }
    }
    for (const observation of state.observations.filter(o => o.status === "PENDING")) {
      await run({ type: "REVIEW_OBSERVATION", observationId: observation.id, decision: "RESOLVE", rationale: "Simulated user reviewed it." });
    }
  };

  let outgoing: string = fixture.opening;
  let retryMessageId: string | null = null;
  let answeredFields: string[] = [];
  try {
    for (let index = 1; index <= maxTurns; index++) {
      let messageId: string | null = retryMessageId;
      if (!messageId) {
        await run({ type: "SEND_MESSAGE", text: outgoing });
        messageId = state.messages.at(-1)!.id;
      }
      const input = buildInterviewInput(state, messageId!);
      const record: Transcript["turns"][number] = { index, userMessage: state.messages.find(m => m.id === messageId)!.text,
        gapsAvailable: input.activeGaps.length, questions: [], proposals: 0, attempts: 0, validationErrors: 0, issues: [], stopReasons: [], warnings: [], error: null,
        textFallbacks: 0, extraction: null, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
      transcript.turns.push(record);
      // The reply (chat call) and the reading of the same message (extraction call) run together, as in production: the chat
      // call sees the message's raw text, not its extraction. The driver waits for both before the simulated client answers,
      // which keeps a run repeatable (the production worker does not wait; see awaitExtraction in consultant-extraction.ts).
      const proposalsBefore = state.proposals.length, questionsBefore = state.questions.length;
      const extracting = (async () => {
        let last: unknown = null;
        for (let attempt = 1; attempt <= 2; attempt++) { // the queue retries a failed extraction once
          try { return { outcome: await extractMessage(pool, stage, worker, messageId!, randomUUID()), error: null }; }
          catch (error) { last = error; }
        }
        return { outcome: null, error: last };
      })();
      try {
        const generated = await stage("interview_turn", input).catch(async error => { await extracting; throw error; });
        Object.assign(record, metricsRecord(generated.metrics));
        outputTokens += generated.metrics.outputTokens;
        const extraction = await extracting;
        const extractionMetrics = extraction.outcome?.status === "RECORDED" ? extraction.outcome.metrics
          : extraction.error instanceof AIStageError ? extraction.error.metrics : null;
        if (extractionMetrics) {
          outputTokens += extractionMetrics.outputTokens;
          record.extraction = { attempts: extractionMetrics.attempts, validationErrors: extractionMetrics.validationErrors.length,
            textFallbacks: extractionMetrics.textFallbacks ?? 0, warnings: (extractionMetrics.warnings ?? []).map(({ path, code, detail }) => ({ path, code, ...(detail ? { detail } : {}) })),
            inputTokens: extractionMetrics.inputTokens, outputTokens: extractionMetrics.outputTokens, latencyMs: extractionMetrics.latencyMs,
            error: extraction.error ? (extraction.error instanceof AIStageError ? extraction.error.code : "DRIVER_ERROR") : null };
        } else if (extraction.error) record.extraction = { attempts: 0, validationErrors: 0, textFallbacks: 0, warnings: [], inputTokens: 0,
          outputTokens: 0, latencyMs: 0, error: `DRIVER_ERROR:${message(extraction.error).slice(0, 80)}` };
        await transaction(pool, client => persistWorkspaceTurn(client, { ...worker, expectedRevision: state.revision, currentMessageId: messageId!,
          turn: generated.payload, requestKey: randomUUID(), scope: "chat" }));
        state = (await workspaces.get(owner.token, project.id, variant)).state!;
        record.questions = state.questions.slice(questionsBefore).map(q => ({ gapKey: q.gapKey, fieldId: q.fieldId, question: q.question }));
        record.proposals = state.proposals.length - proposalsBefore;
        retryMessageId = null; failures = 0;
      } catch (error) {
        const stageError = error instanceof AIStageError ? error : null;
        // runStage hands the same metrics object to every thrown AIStageError, so failures carry attempts and issues too.
        if (stageError) Object.assign(record, metricsRecord(stageError.metrics));
        outputTokens += record.outputTokens;
        record.error = stageError ? stageError.code : `DRIVER_ERROR:${message(error).slice(0, 80)}`;
        retryMessageId = messageId; // the user's message stands; the interviewer failed to answer it
        if (++failures >= MAX_CONSECUTIVE_FAILURES) { transcript.aborted = `${failures} consecutive failed turns (${record.error})`; break; }
        if (capExceeded()) { transcript.aborted = `output token cap ${OUTPUT_TOKEN_CAP} exceeded`; break; }
        console.log(`turn ${index}: FAILED ${record.error} (attempts ${record.attempts})`);
        continue;
      }

      console.log(`turn ${index}: ${record.questions.length} questions, ${record.proposals} proposals, attempts ${record.attempts}, ${Math.round(record.latencyMs / 1000)}s, steps ${state.stepDrafts.length}, requirements ${state.requirementDrafts.length}`);
      await resolvePending();
      // The user fills a template field directly when the interviewer asked about it but did not capture the answer.
      for (const fieldId of answeredFields) {
        const value = answerFor(fixture, state, fieldId);
        if (value && factStatus(state, fieldId) === "EMPTY") { await run(fieldCommand(state, fieldId, value)); directEdits++; }
      }
      if (current.readiness?.ready) { transcript.readiness = { ...transcript.readiness, reached: true, atTurn: index }; break; }
      if (capExceeded()) { transcript.aborted = `output token cap ${OUTPUT_TOKEN_CAP} exceeded`; break; }

      // Answer everything the interviewer asked in one message; fields without a bank answer get "I don't know".
      let asked: Asked[] = record.questions;
      if (!asked.length) {
        // No question asked: volunteer the next few open details so the conversation keeps moving.
        asked = state.facts.filter(f => f.status === "EMPTY" && answerFor(fixture, state, f.id)).slice(0, 3)
          .map(f => ({ gapKey: `g_${f.id}`, fieldId: f.id, question: "" }));
      }
      const reply = composeReply(fixture, state, asked, told);
      answeredFields = reply.answered; outgoing = reply.text;
      for (const fieldId of reply.unknown) await run(fieldCommand(state, fieldId, null));
    }

    const lastUser = state.messages.findLast(m => m.role === "user");
    transcript.gapsRemaining = lastUser ? buildInterviewInput(state, lastUser.id).activeGaps.length : 0;
    if (!transcript.readiness.reached && !transcript.aborted && deps.forceComplete && deps.toBe) {
      // Turn cap reached: complete the template by direct entry so the To-Be can still be measured (flagged in the score).
      transcript.readiness.forcedCompletion = true;
      directEdits += await forceComplete(fixture, () => state, run, () => current, resolvePending);
    }
    transcript.readiness.directEdits = directEdits;
    transcript.structure = { steps: state.steps.length + state.stepDrafts.length,
      requirements: state.requirements.length + state.requirementDrafts.length };
    transcript.readiness.blockers = (current.readiness?.blockers ?? []).map(b => b.code);

    const canGenerate = deps.toBe && !!current.readiness?.ready && (transcript.readiness.reached || transcript.readiness.forcedCompletion);
    if (deps.toBe && !canGenerate) console.log(`To-Be skipped: not ready (${transcript.readiness.blockers.join(", ") || "no blockers read"})`);
    if (canGenerate && !capExceeded()) {
      await run({ type: "CONFIRM" });
      transcript.toBe = await generateToBe(pool, current.confirmedSnapshotId!, stage);
      outputTokens += transcript.toBe.outputTokens;
    }
  } catch (error) {
    transcript.aborted = `driver error: ${message(error).slice(0, 200)}`;
  }
  return TranscriptSchema.parse(transcript);
}

/** Forced completion: clear every readiness blocker the fixture can answer by direct entry (catalog fields, every blank step
 * field, requirement statements), review what is left pending, and repeat until nothing changes. Prints each blocker it could
 * not clear. Returns the number of direct edits made. */
async function forceComplete(fixture: Fixture, getState: () => WorkspaceState, run: (c: Command) => Promise<void>,
  getCurrent: () => { readiness: { ready: boolean; blockers: { code: string; detail: string }[] } | null }, resolvePending: () => Promise<void>) {
  let edits = 0;
  for (let round = 1; round <= 3; round++) {
    await resolvePending();
    const { commands, unresolved } = planForcedCompletion(fixture, getState());
    for (const command of commands) { await run(command); edits++; }
    await resolvePending();
    const readiness = getCurrent().readiness;
    if (readiness?.ready) return edits;
    if (!commands.length) {
      for (const blocker of readiness?.blockers ?? []) console.log(`forced completion could not clear: ${blocker.code} (${blocker.detail})`);
      for (const item of unresolved) console.log(`forced completion: ${item}`);
      return edits;
    }
  }
  for (const blocker of getCurrent().readiness?.blockers ?? []) console.log(`forced completion could not clear: ${blocker.code} (${blocker.detail})`);
  return edits;
}

/** Mirrors the consultant-jobs worker: confirmed snapshot -> parseToBeInput -> runStage("to_be") -> validateToBeOutput. */
async function generateToBe(pool: Pool, snapshotId: string, stage: typeof runStage): Promise<NonNullable<Transcript["toBe"]>> {
  const row = (await pool.query(`SELECT target_product,payload FROM discovery_versions WHERE id=$1`, [snapshotId])).rows[0];
  const input = parseToBeInput({ targetProduct: row.target_product, discovery: row.payload });
  const references = await loadToBeReferences(input);
  console.log(`catalog: ${input.targetProduct} ${input.discovery.targetRelease ?? "UNKNOWN"} -> ${references.length} verified references`);
  console.log(`To-Be input: ${input.discovery.asIsSteps.length} steps, ${input.discovery.requirements.length} requirements, ${input.discovery.companyContext?.length ?? 0} company-context fields`);
  const requirements = input.discovery.requirements.map(r => ({ id: r.id, statement: r.statement, evidence: r.evidence.quote }));
  const base = { attempted: true, requirements };
  const finish = (m: StageMetrics | undefined, rest: { structurallyValid: boolean; errorCode: string | null; design: NonNullable<Transcript["toBe"]>["design"] }) => {
    const run = toBeRun(m);
    console.log(toBeSummary(run, rest.errorCode));
    return { ...base, ...run, ...rest };
  };
  try {
    const generated = await stage("to_be", input);
    const validation = validateToBeOutput(input, (generated.payload as { design?: unknown }).design, references);
    return finish(generated.metrics, { structurallyValid: validation.success, errorCode: validation.success ? null : "VALIDATION_FAILED",
      design: validation.success ? validation.data.design as unknown as NonNullable<Transcript["toBe"]>["design"] : null });
  } catch (error) {
    const failed = error instanceof AIStageError ? error : null;
    return finish(failed?.metrics, { structurallyValid: false, errorCode: failed?.code ?? `DRIVER_ERROR:${message(error).slice(0, 80)}`, design: null });
  }
}

// --- disposable database -----------------------------------------------------------------------------------------

async function withDisposableDatabase<T>(work: (pool: Pool) => Promise<T>): Promise<T> {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Refusing to create a database on a non-local host");
  const database = `sap_eval_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: url.href });
  await admin.connect();
  let created = false, pool: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    url.pathname = `/${database}`;
    // The real migration runner, not hand-written DDL.
    await promisify(execFile)("node", ["--import", "tsx", "scripts/seed.ts", "--migrate-only"],
      { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 60000 });
    pool = new Pool({ connectionString: url.href, max: 4, statement_timeout: 30000 });
    pool.on("error", () => {});
    return await work(pool);
  } finally {
    await pool?.end().catch(() => {});
    try {
      if (created) {
        await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
        const left = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [database]);
        if (left.rowCount) throw new Error(`Disposable database ${database} still exists`);
      }
    } finally { await admin.end(); }
  }
}

// --- entry point --------------------------------------------------------------------------------------------------

function fillEnvDefaults() {
  // Local defaults only for variables the caller has not set; never overrides a real key.
  for (const [key, value] of Object.entries(parseEnv(readFileSync(".env.example", "utf8")))) process.env[key] ??= value;
}
function report(transcript: unknown, fixture: Fixture, label: string) {
  const score = scoreRun(transcript, fixture);
  const summary = summarize(score);
  console.log(`${label}\n${summary}`);
  return { score, summary };
}

async function main() {
  const fixture = loadFixture(flag("case") ?? DEFAULT_CASE);
  ScoringCaseSchema.parse(fixture);
  const replay = flag("replay");
  if (replay) {
    const saved = JSON.parse(readFileSync(replay, "utf8")) as { transcript?: unknown };
    const { score } = report(saved.transcript ?? saved, fixture, `Replay ${replay}`);
    console.log(JSON.stringify(score, null, 2));
    process.exitCode = score.pass ? 0 : 1;
    return;
  }
  if (!has("live")) throw new Error("Use --replay <transcript.json> or --live --provider <anthropic|deepinfra|openrouter> --model <id>");
  const provider = flag("provider"), model = flag("model");
  if (!provider || !(PROVIDERS as readonly string[]).includes(provider) || !model) throw new Error("--live needs --provider <anthropic|deepinfra|openrouter> and --model <id>");
  const runs = Number(flag("runs") ?? 1), maxTurns = Number(flag("max-turns") ?? DEFAULT_MAX_TURNS);
  if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("--runs and --max-turns must be positive integers");
  fillEnvDefaults();
  process.env.AI_PROVIDER = provider; process.env.AI_MODEL = model;
  if (has("fake-model") && provider !== "stub") throw new Error("--fake-model only runs with --provider stub");
  const keyName = { anthropic: "ANTHROPIC_API_KEY", deepinfra: "DEEPINFRA_API_KEY", openrouter: "OPENROUTER_API_KEY", stub: null }[provider as (typeof PROVIDERS)[number]];
  if (keyName && !process.env[keyName]?.trim()) throw new Error(`${keyName} is not set`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("test-results/eval", { recursive: true });
  let allPassed = true;
  await withDisposableDatabase(async pool => {
    for (let run = 1; run <= runs; run++) {
      const transcript = await runOnce(fixture, { pool, provider, model, maxTurns, forceComplete: !has("no-force-complete"), toBe: !has("no-tobe"), toBeOnly: has("tobe-only"), fake: has("fake-model") });
      const { score, summary } = report(transcript, fixture, `Run ${run}/${runs}`);
      const file = `test-results/eval/${stamp}-${provider}-${model.replace(/[^A-Za-z0-9._-]+/g, "_")}${runs > 1 ? `-run${run}` : ""}.json`;
      writeFileSync(file, JSON.stringify({ transcript, score, summary }, null, 2));
      console.log(`Wrote ${file}`);
      allPassed &&= score.pass;
    }
  });
  process.exitCode = allPassed ? 0 : 1;
}

main().catch(error => { console.error(`eval-consultant failed: ${message(error)}`); process.exitCode = 2; });
