import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { AuthError, transaction } from "./auth";
import { loadWorkspaceForWorker, persistWorkspaceTurn, type WorkspaceWorkerArgs } from "./discovery-workspace";
import { buildInterviewInput } from "./discovery-workspace-model";
import type { createStageRunner, StageMetrics } from "./ai/runStage";
import type { ValidationIssue } from "./ai/problem-analysis";

/** Extraction (reading facts, steps and requirements out of one user message) runs on its own queue, in the background,
 * so a chat turn never waits for it. One job per user message; jobs of one workspace run strictly in message order. */
export const CONSULTANT_EXTRACT_QUEUE = "consultant-extract";
const uuid = z.uuid();
export const ExtractJobSchema = z.strictObject({
  /** `<org>:<project>:<variant>`: the unit of ordering. */
  scope: z.string().max(200), orgId: uuid, projectId: uuid, variantCode: z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/), requestedBy: uuid,
  messageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** 1-based position of the message among the workspace's user messages. */
  seq: z.number().int().positive(),
});
export type ExtractJob = z.infer<typeof ExtractJobSchema>;
export const extractionScope = (w: Pick<WorkspaceWorkerArgs, "orgId" | "projectId" | "variantCode">) => `${w.orgId}:${w.projectId.toLowerCase()}:${w.variantCode}`;

type Runner = ReturnType<typeof createStageRunner>;
export type ExtractionOutcome = { status: "RECORDED"; metrics: StageMetrics; summary: ExtractionSummary; proposalsAdded: number; observationsAdded: number }
  | { status: "ALREADY_EXTRACTED" };

export type ExtractionCounts = { updates: number; steps: number; requirements: number; observations: number };
export type ExtractionSummary = { returned: ExtractionCounts; kept: ExtractionCounts; dropped: ExtractionCounts;
  /** Drops by fixed reason code (e.g. `update_dropped:echoed_value`), with counts. Never text from the message. */
  dropReasons: Record<string, number>; answerFallbacks: number };
const GROUPS = { proposedUpdates: "updates", proposedSteps: "steps", proposedRequirements: "requirements", observations: "observations" } as const;
const DROP_CODES = new Set(["update_dropped", "step_dropped", "requirement_dropped", "observation_dropped", "evidence_span_too_long"]);

/** What one extraction call returned, kept and dropped, from the validated payload plus its warnings. Counts and codes only: a
 * warning's path may name a field, and its detail is used only when it is a fixed lower-case code. */
export function summarizeExtraction(payload: { [K in keyof typeof GROUPS]: readonly unknown[] }, warnings: readonly ValidationIssue[] | undefined): ExtractionSummary {
  const kept = { updates: payload.proposedUpdates.length, steps: payload.proposedSteps.length,
    requirements: payload.proposedRequirements.length, observations: payload.observations.length };
  const dropped: ExtractionCounts = { updates: 0, steps: 0, requirements: 0, observations: 0 };
  const dropReasons: Record<string, number> = {};
  let answerFallbacks = 0;
  for (const warning of warnings ?? []) {
    if (warning.code === "answer_fallback") { answerFallbacks++; continue; }
    const group = GROUPS[warning.path.split(".")[0] as keyof typeof GROUPS];
    if (!group) continue;
    const truncated = warning.code === "proposals_truncated" ? /^dropped (\d{1,4})$/.exec(warning.detail ?? "") : null;
    if (!truncated && !(DROP_CODES.has(warning.code) && !warning.path.endsWith(".nameHint"))) continue;
    const count = truncated ? Number(truncated[1]) : 1;
    const detail = warning.code !== "evidence_span_too_long" && !truncated && /^[a-z_]{1,40}$/.test(warning.detail ?? "") ? `:${warning.detail}` : "";
    const reason = `${warning.code}${detail}`;
    dropped[group] += count;
    dropReasons[reason] = (dropReasons[reason] ?? 0) + count;
  }
  const returned = { updates: kept.updates + dropped.updates, steps: kept.steps + dropped.steps,
    requirements: kept.requirements + dropped.requirements, observations: kept.observations + dropped.observations };
  return { returned, kept, dropped, dropReasons, answerFallbacks };
}

/** Extract one user message against the latest workspace and record the proposals. Safe to repeat: a message that is
 * already extracted is skipped, and a replay of the same request key returns the stored result. The model call is made
 * outside any transaction. Used by the queue worker, and called directly (and awaited) by the evaluation runner. */
export async function extractMessage(pool: Pool, runStage: Runner, worker: WorkspaceWorkerArgs, messageId: string,
  requestKey: string, signal?: AbortSignal): Promise<ExtractionOutcome> {
  const loaded = await transaction(pool, async client => {
    const workspace = await loadWorkspaceForWorker(client, worker, true);
    if (!workspace.canEdit) throw new AuthError("FORBIDDEN", 403, "You cannot edit discovery inputs");
    return workspace.state.extractedMessageIds?.includes(messageId) ? null
      : { input: buildInterviewInput(workspace.state, messageId), proposals: workspace.state.proposals.length, observations: workspace.state.observations.length };
  });
  if (!loaded) return { status: "ALREADY_EXTRACTED" };
  const { input } = loaded;
  const generated = await runStage("extraction_turn", input, signal);
  const saved = await transaction(pool, async client => {
    const result = await persistWorkspaceTurn(client, { ...worker, expectedRevision: input.contextRevision,
      currentMessageId: messageId, turn: generated.payload, requestKey, scope: "extraction" });
    // Usage ledger: a terminal consultant_jobs row, so the admin cost views (which read this table) count the call.
    // The daily job quotas exclude kind='EXTRACTION': the call belongs to the chat turn that queued it. Keyed by the request key, so a replay or retry of the same job records it once.
    // Failed attempts record nothing (no metrics survive a thrown error): their tokens are not in the cost views.
    await client.query(`INSERT INTO consultant_jobs (id,org_id,project_id,variant_code,kind,input_revision,message_id,requested_by,
      request_key,request_hash,status,result,metrics,finished_at)
      VALUES ($1,$2,$3,$4,'EXTRACTION',$5,$6,$7,$8,$9,'SUCCEEDED',$10,$11,clock_timestamp())
      ON CONFLICT (org_id,project_id,variant_code,requested_by,request_key) DO NOTHING`,
    [randomUUID(), worker.orgId, worker.projectId, worker.variantCode, input.contextRevision, messageId, worker.requestedBy, requestKey,
      createHash("sha256").update(`extraction:${messageId}`).digest("hex"), { messageId }, generated.metrics]);
    return result;
  });
  // Proposals are never removed from a workspace, so the growth is what this call added (0: nothing was proposed, or it was already recorded).
  return { status: "RECORDED", metrics: generated.metrics, summary: summarizeExtraction(generated.payload, generated.metrics.warnings),
    proposalsAdded: saved.state.proposals.length - loaded.proposals, observationsAdded: saved.state.observations.length - loaded.observations };
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
});

/** Strict per-workspace ordering: wait until every earlier message's extraction job has finished (completed, failed or
 * cancelled), so extraction N+1 never reads a state that lacks N's result, and never overwrites it. */
async function waitForEarlierExtractions(pool: Pool, jobId: string, data: ExtractJob, signal: AbortSignal, maxWaitMs: number) {
  const until = Date.now() + maxWaitMs;
  for (;;) {
    const earlier = await pool.query(`SELECT 1 FROM pgboss.job WHERE name=$1 AND id<>$2 AND data->>'scope'=$3
      AND (data->>'seq')::int < $4 AND state IN ('created','retry','active') LIMIT 1`, [CONSULTANT_EXTRACT_QUEUE, jobId, data.scope, data.seq]);
    if (!earlier.rowCount) return;
    if (Date.now() > until) throw new Error("EXTRACTION_ORDER_TIMEOUT");
    await pause(500, signal);
  }
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** A fixed, loggable identifier for a failure: an error code, else a code-shaped message, else the error class. Never free text. */
export function failureCode(error: unknown): string {
  const { code, message, name } = (error ?? {}) as { code?: unknown; message?: unknown; name?: unknown };
  for (const candidate of [code, message]) if (typeof candidate === "string" && SAFE_CODE.test(candidate)) return candidate;
  return typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "UnknownError";
}

/** The queue handler: validate the payload, wait for earlier messages of the same workspace, extract. */
export async function executeExtraction(pool: Pool, runStage: Runner, job: { id: string; data: unknown }, signal: AbortSignal,
  maxWaitSeconds: number): Promise<ExtractionOutcome | undefined> {
  const data = ExtractJobSchema.safeParse(job.data);
  if (!data.success || !uuid.safeParse(job.id).success) return undefined;
  await waitForEarlierExtractions(pool, job.id, data.data, signal, maxWaitSeconds * 1000);
  return extractMessage(pool, runStage, { orgId: data.data.orgId, projectId: data.data.projectId, variantCode: data.data.variantCode,
    requestedBy: data.data.requestedBy }, data.data.messageId, job.id, signal);
}

/** The one log line per finished extraction: ran (counts and drop codes) or skipped (reason code). Never message text or values. */
export function extractionLogEvent(jobId: string, durationMs: number, outcome: ExtractionOutcome | undefined) {
  if (!outcome) return { event: "extraction_skipped", jobId, durationMs, reason: "invalid_job_payload" };
  if (outcome.status === "ALREADY_EXTRACTED") return { event: "extraction_skipped", jobId, durationMs, reason: "already_extracted" };
  const { summary, proposalsAdded, observationsAdded } = outcome;
  return { event: "extraction_succeeded", jobId, durationMs, returned: summary.returned, kept: summary.kept, dropped: summary.dropped,
    dropReasons: summary.dropReasons, answerFallbacks: summary.answerFallbacks, proposalsAdded, observationsAdded,
    workspaceChanged: proposalsAdded + observationsAdded > 0 };
}

/** The queue entry point: runs the job, and on failure logs one line with a fixed code (never user text) before rethrowing, so
 * pg-boss still marks the job failed and retries as configured. Without it a failed extraction left no trace anywhere. */
export async function runExtractionJob(pool: Pool, runStage: Runner, job: { id: string; data: unknown }, signal: AbortSignal,
  maxWaitSeconds: number) {
  const startedAt = Date.now();
  try {
    const outcome = await executeExtraction(pool, runStage, job, signal, maxWaitSeconds);
    console.error(JSON.stringify(extractionLogEvent(job.id, Date.now() - startedAt, outcome)));
    return outcome;
  } catch (error) {
    console.error(JSON.stringify({ event: "extraction_failed", jobId: job.id, durationMs: Date.now() - startedAt, code: failureCode(error) }));
    throw error;
  }
}

/** How many earlier, never-recorded messages one new chat turn re-queues. */
export const MAX_REQUEUED_EXTRACTIONS = 5;
/** Earlier user messages whose extraction must be queued again: before the current message, not recorded in
 * `extractedMessageIds`, and with no live (created/retry/active) job. The most recent `limit`, oldest first, each with its
 * real 1-based position among user messages (the ordering key of the queue). */
export function missedExtractions(messages: readonly { id: string; role: string }[], extractedIds: readonly string[] | undefined,
  liveJobMessageIds: ReadonlySet<string>, currentMessageId: string, limit = MAX_REQUEUED_EXTRACTIONS): { messageId: string; seq: number }[] {
  const extracted = new Set(extractedIds ?? []);
  const users = messages.filter(message => message.role === "user").map((message, index) => ({ messageId: message.id, seq: index + 1 }));
  const current = users.findIndex(user => user.messageId === currentMessageId);
  return users.slice(0, Math.max(current, 0)).filter(user => !extracted.has(user.messageId) && !liveJobMessageIds.has(user.messageId)).slice(-limit);
}

/** Wait until `messageId` has been extracted: the helper a deterministic evaluation (or test) uses before it sends the next
 * simulated client message. `read` returns the current workspace state. Fails closed on timeout. */
export async function awaitExtraction(read: () => Promise<{ extractedMessageIds?: string[] }>, messageId: string,
  { timeoutMs = 120_000, pollMs = 250 }: { timeoutMs?: number; pollMs?: number } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await read()).extractedMessageIds?.includes(messageId)) return;
    if (Date.now() > until) throw new Error("EXTRACTION_AWAIT_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
