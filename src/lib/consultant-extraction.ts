import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { AuthError, transaction } from "./auth";
import { loadWorkspaceForWorker, persistWorkspaceTurn, type WorkspaceWorkerArgs } from "./discovery-workspace";
import { buildInterviewInput } from "./discovery-workspace-model";
import type { createStageRunner, StageMetrics } from "./ai/runStage";

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
export type ExtractionOutcome = { status: "RECORDED"; metrics: StageMetrics } | { status: "ALREADY_EXTRACTED" };

/** Extract one user message against the latest workspace and record the proposals. Safe to repeat: a message that is
 * already extracted is skipped, and a replay of the same request key returns the stored result. The model call is made
 * outside any transaction. Used by the queue worker, and called directly (and awaited) by the evaluation runner. */
export async function extractMessage(pool: Pool, runStage: Runner, worker: WorkspaceWorkerArgs, messageId: string,
  requestKey: string, signal?: AbortSignal): Promise<ExtractionOutcome> {
  const input = await transaction(pool, async client => {
    const workspace = await loadWorkspaceForWorker(client, worker, true);
    if (!workspace.canEdit) throw new AuthError("FORBIDDEN", 403, "You cannot edit discovery inputs");
    return workspace.state.extractedMessageIds?.includes(messageId) ? null : buildInterviewInput(workspace.state, messageId);
  });
  if (!input) return { status: "ALREADY_EXTRACTED" };
  const generated = await runStage("extraction_turn", input, signal);
  await transaction(pool, async client => {
    await persistWorkspaceTurn(client, { ...worker, expectedRevision: input.contextRevision,
      currentMessageId: messageId, turn: generated.payload, requestKey, scope: "extraction" });
    // Usage ledger: a terminal consultant_jobs row, so the daily job limit and the admin cost views (which read this table)
    // count the call. Keyed by the request key, so a replay or retry of the same job records it once.
    // Failed attempts record nothing (no metrics survive a thrown error): their tokens are not in the cost views.
    await client.query(`INSERT INTO consultant_jobs (id,org_id,project_id,variant_code,kind,input_revision,message_id,requested_by,
      request_key,request_hash,status,result,metrics,finished_at)
      VALUES ($1,$2,$3,$4,'EXTRACTION',$5,$6,$7,$8,$9,'SUCCEEDED',$10,$11,clock_timestamp())
      ON CONFLICT (org_id,project_id,variant_code,requested_by,request_key) DO NOTHING`,
    [randomUUID(), worker.orgId, worker.projectId, worker.variantCode, input.contextRevision, messageId, worker.requestedBy, requestKey,
      createHash("sha256").update(`extraction:${messageId}`).digest("hex"), { messageId }, generated.metrics]);
  });
  return { status: "RECORDED", metrics: generated.metrics };
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

/** The queue handler: validate the payload, wait for earlier messages of the same workspace, extract. */
export async function executeExtraction(pool: Pool, runStage: Runner, job: { id: string; data: unknown }, signal: AbortSignal,
  maxWaitSeconds: number): Promise<ExtractionOutcome | undefined> {
  const data = ExtractJobSchema.safeParse(job.data);
  if (!data.success || !uuid.safeParse(job.id).success) return undefined;
  await waitForEarlierExtractions(pool, job.id, data.data, signal, maxWaitSeconds * 1000);
  return extractMessage(pool, runStage, { orgId: data.data.orgId, projectId: data.data.projectId, variantCode: data.data.variantCode,
    requestedBy: data.data.requestedBy }, data.data.messageId, job.id, signal);
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
