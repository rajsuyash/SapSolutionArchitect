import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { AuthError, transaction, type AuthService } from "./auth";
import { withTenantSession } from "./tenant";
import { assertOrgCanRunAi } from "./org-limits";
import { PROVIDER_CREDIT_MESSAGE } from "./ai/provider";
import { validateDiscovery } from "./discovery";
import { loadWorkspaceForWorker, persistWorkspaceTurn } from "./discovery-workspace";
import { CONSULTANT_EXTRACT_QUEUE, extractionScope, failureCode, missedExtractions } from "./consultant-extraction";
import { buildInterviewInput } from "./discovery-workspace-model";
import { loadToBeReferences, parseToBeInput, validateToBeOutput } from "./ai/to-be";
import { loadSapReferences, type SapReferenceOptions } from "./ai/sap-references";
import { DEFAULT_STAGE_BUDGET_SECONDS, jobTiming } from "./ai/timeouts";
import { parseStoredToBe, type ReportData } from "./consultant-report";
import type { createStageRunner } from "./ai/runStage";
import { reviewBlockers, type ReviewOutcome } from "./ai/to-be-review";

/** Interview turns (about 40 s) and To-Be runs (up to 20 min) use separate queues, so a long run never waits behind or
 * in front of a chat turn. Problem analysis has its own queue (see jobs.ts) and counts as batch work. */
export const CONSULTANT_CHAT_QUEUE = "consultant-chat";
export const CONSULTANT_BATCH_QUEUE = "consultant-batch";
/** The single queue used before the split. New jobs never go there; the worker drains it so jobs queued at deploy time
 * still run, and recovery still recognises them. Remove once no pgboss.job row with this name is created/active. */
export const LEGACY_CONSULTANT_QUEUE = "consultant.discovery";
export const CONSULTANT_QUEUES = [CONSULTANT_CHAT_QUEUE, CONSULTANT_BATCH_QUEUE, LEGACY_CONSULTANT_QUEUE] as const;
export const consultantQueueFor = (kind: "INTERVIEW" | "TO_BE") => kind === "INTERVIEW" ? CONSULTANT_CHAT_QUEUE : CONSULTANT_BATCH_QUEUE;
const timeoutError = () => Object.assign(new Error("AI_TIMEOUT"), { code: "AI_TIMEOUT" as const });
const scope = z.strictObject({ projectId: z.uuid(), variantCode: z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/) });
const request = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("INTERVIEW"), expectedRevision: z.number().int().positive(), messageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
  z.strictObject({ kind: z.literal("TO_BE"), expectedRevision: z.number().int().positive() }),
]);
// Not strict: StageMetrics also carries eval-only detail (attemptIssues, stopReasons, warnings) that must not fail a job; unknown keys are dropped, not stored.
const substageMetrics = z.strictObject({ calls: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() });
const metricsSchema = z.object({ stage: z.enum(["interview_turn", "extraction_turn", "to_be"]), provider: z.enum(["stub", "anthropic", "deepinfra", "openrouter"]),
  model: z.string().max(160), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative(), attempts: z.number().int().nonnegative(), providerRetries: z.number().int().nonnegative().optional(), thinkingDisabled: z.boolean().optional(),
  substages: z.strictObject({ to_be_outline: substageMetrics.optional(), to_be_step: substageMetrics.optional(), to_be_registers: substageMetrics.optional(), to_be_review: substageMetrics.optional(), to_be_fix: substageMetrics.optional() }).optional(),
  validationErrors: z.array(z.strictObject({ path: z.string().max(200), code: z.string().max(80), detail: z.string().max(200).optional() })).max(1000) });
type StoredJob = { id: string; org_id: string; project_id: string; variant_code: string; kind: "INTERVIEW" | "TO_BE";
  input_revision: number; message_id: string | null; snapshot_id: string | null; requested_by: string;
  status: string; request_hash: string; error: { code: string; message: string } | null; result: unknown; metrics: unknown;
  finished_at: Date | null };
const expose = (job: StoredJob) => ({ id: job.id, kind: job.kind, status: job.status, inputRevision: job.input_revision,
  error: job.error, result: job.result, metrics: job.metrics });
const stale = () => new AuthError("STALE_INPUT", 409, "Discovery changed. Review the latest answers before continuing.");
const missing = () => new AuthError("WORKSPACE_NOT_FOUND", 404, "Discovery conversation not found");
const forbidden = () => new AuthError("FORBIDDEN", 403, "You cannot run the consultant for this project.");
const workerScope = (job: StoredJob) => ({ orgId: job.org_id, projectId: job.project_id, variantCode: job.variant_code, requestedBy: job.requested_by });

async function designInput(client: PoolClient, job: StoredJob) {
  const row = (await client.query(`SELECT target_product,payload,source_digests FROM discovery_versions
    WHERE id=$1 AND org_id=$2 AND project_id=$3 AND variant_code=$4`,
  [job.snapshot_id, job.org_id, job.project_id, job.variant_code])).rows[0];
  if (!row) throw stale();
  const input = parseToBeInput({ targetProduct: row.target_product, discovery: row.payload });
  for (const source of input.discovery.sources) {
    if (row.source_digests[source.id] !== createHash("sha256").update(source.text, "utf8").digest("hex")) throw stale();
  }
  return input;
}

/** Every job pins a workspace revision. Model calls occur outside transactions;
 * successful completion rechecks authorization, revision, deadline and run token. */
export const DEFAULT_DAILY_JOB_LIMIT = 200;
export function createConsultantJobs(pool: Pool, auth: AuthService, queue: PgBoss, startQueue: () => Promise<void>,
  { dailyJobLimit = DEFAULT_DAILY_JOB_LIMIT, stageBudgetSeconds = DEFAULT_STAGE_BUDGET_SECONDS }:
    { dailyJobLimit?: number; stageBudgetSeconds?: number } = {}) {
  // The stage runner owns the budget; the row deadline and queue expiry add headroom (see jobTiming).
  const { deadlineSeconds, queueExpireSeconds } = jobTiming(stageBudgetSeconds);
  return {
    async initialize() {
      for (const name of [...CONSULTANT_QUEUES, CONSULTANT_EXTRACT_QUEUE]) {
        await queue.createQueue(name, { retryLimit: 0, expireInSeconds: queueExpireSeconds, retentionSeconds: 3600, deleteAfterSeconds: 604800 });
      }
    },
    enqueue: (token: string | null, projectId: string, variantCode: string, raw: unknown, key: string | null) =>
      withTenantSession(pool, auth, token, async ({ client, user }) => {
        if (!scope.safeParse({ projectId, variantCode }).success) throw missing();
        const parsed = request.safeParse(raw);
        if (!parsed.success) throw new AuthError("INVALID_REQUEST", 400, "Check the conversation revision and request.");
        if (!z.uuid().safeParse(key).success) throw new AuthError("INVALID_IDEMPOTENCY_KEY", 400, "Send a UUID Idempotency-Key header");
        const input = parsed.data;
        // The helper holds the same workspace advisory transaction lock as all
        // edits: concurrent enqueue/replay checks below are serialized too.
        const workspace = await loadWorkspaceForWorker(client, { orgId: user.orgId, projectId, variantCode, requestedBy: user.id });
        if (!workspace.canEdit) throw forbidden();
        const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const prior = (await client.query<StoredJob>(`SELECT * FROM consultant_jobs WHERE org_id=$1 AND project_id=$2
          AND variant_code=$3 AND requested_by=$4 AND request_key=$5`, [user.orgId, projectId, variantCode, user.id, key])).rows[0];
        if (prior) {
          if (prior.request_hash !== hash) throw new AuthError("IDEMPOTENCY_CONFLICT", 409, "This request key was already used for different inputs.");
          return expose(prior);
        }
        // A chat turn answers the latest user message and may be sent while an earlier message is still being extracted in the
        // background, which advances the revision: it is current when its message is still the last one. A To-Be run pins a revision.
        const lastUserMessage = workspace.state.messages.findLast(message => message.role === "user")?.id;
        if (input.kind === "INTERVIEW" ? input.expectedRevision > workspace.state.revision || input.messageId !== lastUserMessage
          : workspace.state.revision !== input.expectedRevision) throw stale();
        if (input.kind === "TO_BE" && (!workspace.canConfirm || !workspace.confirmedSnapshotId)) {
          throw new AuthError("DISCOVERY_NOT_CONFIRMED", 409, "A project lead or consultant must confirm the completed As-Is discovery first.");
        }
        if (input.kind === "INTERVIEW") buildInterviewInput(workspace.state, input.messageId);
        const pending = (await client.query(`SELECT id FROM consultant_jobs WHERE org_id=$1 AND project_id=$2
          AND variant_code=$3 AND status IN ('QUEUED','RUNNING')`, [user.orgId, projectId, variantCode])).rows[0];
        if (pending) throw new AuthError("JOB_ALREADY_RUNNING", 409, "The consultant is already responding. Please wait for that response.");
        await assertOrgCanRunAi(client, user.orgId);
        await startQueue();
        const id = randomUUID();
        const job =(await client.query<StoredJob>(`INSERT INTO consultant_jobs
          (id,org_id,project_id,variant_code,kind,input_revision,message_id,snapshot_id,requested_by,request_key,request_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [id, user.orgId, projectId, variantCode, input.kind, input.expectedRevision,
          input.kind === "INTERVIEW" ? input.messageId : null, input.kind === "TO_BE" ? workspace.confirmedSnapshotId : null,
          user.id, key, hash])).rows[0]!;
        // Restore the trusted connection role solely for pg-boss insertion in this transaction.
        await client.query("SET LOCAL ROLE NONE");
        // Spend guard (OWASP LLM10): per-organization rolling 24h cap, counted org-wide (tenant RLS would only show
        // the caller's projects) and serialized per org so concurrent enqueues cannot all slip under the limit.
        // Background EXTRACTION rows are not counted: they belong to the turn that queued them.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`consultant-quota:${user.orgId}`]);
        const used = (await client.query<{ n: number; retry: number | null }>(`SELECT count(*)::int AS n,
          ceil(extract(epoch FROM min(created_at)+interval '24 hours'-clock_timestamp()))::int AS retry FROM consultant_jobs
          WHERE org_id=$1 AND kind<>'EXTRACTION' AND created_at>clock_timestamp()-interval '24 hours'`, [user.orgId])).rows[0]!;
        if (used.n > dailyJobLimit) throw new AuthError("RATE_LIMITED", 429,
          "Your organization has reached its daily consultant limit. Try again later.", undefined, Math.max(60, used.retry ?? 3600));
        const queued = await queue.send(consultantQueueFor(input.kind), { jobId: id }, { id, retryLimit: 0, expireInSeconds: queueExpireSeconds,
          retentionSeconds: 3600, deleteAfterSeconds: 604800, db: { executeSql: (sql, values) => client.query(sql, values) } });
        if (!queued) throw new Error("Consultant enqueue failed");
        if (input.kind === "INTERVIEW") {
          // The same transaction also queues reading this message for facts and structure; the reply never waits for it.
          // It also re-queues earlier messages whose extraction never recorded (a failed job is not retried by anything else, and
          // only the last few unextracted messages reach the interviewer, so older answers would be lost for good).
          // Safe out of order: an extraction reads the latest state, skips a message already recorded, and later jobs wait for lower seq.
          const extractionScopeKey = extractionScope({ orgId: user.orgId, projectId, variantCode });
          const live = new Set((await client.query<{ message_id: string }>(`SELECT data->>'messageId' AS message_id FROM pgboss.job
            WHERE name=$1 AND data->>'scope'=$2 AND state IN ('created','retry','active')`, [CONSULTANT_EXTRACT_QUEUE, extractionScopeKey])).rows.map(row => row.message_id));
          const seq = workspace.state.messages.filter(message => message.role === "user").findIndex(message => message.id === input.messageId) + 1;
          const wanted = [...missedExtractions(workspace.state.messages, workspace.state.extractedMessageIds, live, input.messageId),
            { messageId: input.messageId, seq }];
          for (const { messageId, seq: position } of wanted) {
            const extraction = await queue.send(CONSULTANT_EXTRACT_QUEUE, { scope: extractionScopeKey,
              orgId: user.orgId, projectId, variantCode, requestedBy: user.id, messageId, seq: position },
            { id: randomUUID(), retryLimit: 1, retryDelay: 2, expireInSeconds: queueExpireSeconds, retentionSeconds: 3600, deleteAfterSeconds: 604800,
              db: { executeSql: (sql, values) => client.query(sql, values) } });
            if (!extraction) throw new Error("Consultant extraction enqueue failed");
          }
        }
        return expose(job);
      }),
    latest: (token: string | null, projectId: string, variantCode: string) =>
      withTenantSession(pool, auth, token, async ({ client, user }) => {
        if (!scope.safeParse({ projectId, variantCode }).success) throw missing();
        // Reading is available to project viewers too. Do not use the worker write-authorizer here.
        const member = await client.query(`SELECT 1 FROM project_memberships WHERE org_id=$1 AND project_id=$2 AND user_id=$3`,
          [user.orgId, projectId, user.id]);
        if (!member.rowCount) throw missing();
        const jobs = (await client.query<StoredJob>(`SELECT * FROM consultant_jobs WHERE org_id=$1 AND project_id=$2 AND variant_code=$3
          AND kind<>'EXTRACTION' ORDER BY created_at DESC,id DESC LIMIT 20`, [user.orgId, projectId, variantCode])).rows;
        return { jobs: jobs.map(expose) };
      }),
    /** Full validated To-Be result for one finished job. Visible to any project member; tenant isolation,
     * job/workspace binding and SUCCEEDED-only are all enforced by the query. Metrics are never selected into the view. */
    async report(token: string | null, projectId: string, variantCode: string, jobId: string, options: SapReferenceOptions = {}): Promise<ReportData> {
      const rows = await withTenantSession(pool, auth, token, async ({ client, user }) => {
        if (!scope.safeParse({ projectId, variantCode }).success || !z.uuid().safeParse(jobId).success) throw missing();
        const member = await client.query(`SELECT 1 FROM project_memberships WHERE org_id=$1 AND project_id=$2 AND user_id=$3`,
          [user.orgId, projectId, user.id]);
        if (!member.rowCount) throw missing();
        const job = (await client.query<StoredJob>(`SELECT * FROM consultant_jobs WHERE id=$1 AND org_id=$2 AND project_id=$3
          AND variant_code=$4 AND kind='TO_BE' AND status='SUCCEEDED'`, [jobId, user.orgId, projectId, variantCode])).rows[0];
        if (!job) throw new AuthError("REPORT_NOT_FOUND", 404, "Report not found");
        const snapshot = (await client.query(`SELECT target_product,payload FROM discovery_versions
          WHERE id=$1 AND org_id=$2 AND project_id=$3 AND variant_code=$4`, [job.snapshot_id, user.orgId, projectId, variantCode])).rows[0];
        const project = (await client.query(`SELECT name,client_name FROM projects WHERE org_id=$1 AND id=$2`, [user.orgId, projectId])).rows[0];
        if (!snapshot || !project) throw new AuthError("REPORT_NOT_FOUND", 404, "Report not found");
        return { job, snapshot, project };
      });
      const stored = parseStoredToBe(rows.job.result);
      const discovery = validateDiscovery(rows.snapshot.payload);
      const catalog = await loadSapReferences(rows.snapshot.target_product, discovery.targetRelease, options);
      const cited = new Set(stored.design.steps.flatMap(step => step.implementation.referenceIds));
      return { jobId: rows.job.id, project: { name: rows.project.name, clientName: rows.project.client_name },
        variant: { code: variantCode, name: discovery.variantName }, targetProduct: rows.snapshot.target_product,
        targetRelease: discovery.targetRelease, sourceRevision: stored.sourceRevision,
        generatedAt: rows.job.finished_at ? rows.job.finished_at.toISOString() : null,
        discovery: { asIsSteps: discovery.asIsSteps, requirements: discovery.requirements, conflicts: discovery.conflicts,
          openQuestions: discovery.openQuestions, sources: discovery.sources.map(({ id, title, locator, revision, text }) =>
          ({ id, title, locator, revision, digest: createHash("sha256").update(text, "utf8").digest("hex") })) },
        snapshotId: stored.snapshotId,
        design: stored.design, blockers: stored.evaluation.blockers, unresolvedInputQuestions: stored.unresolvedInputQuestions,
        references: catalog.filter(reference => cited.has(reference.id)), catalogReferenceCount: catalog.length };
    },
    async recover() {
      await pool.query(`UPDATE consultant_jobs j SET status='FAILED',run_token=NULL,deadline_at=NULL,finished_at=clock_timestamp(),
        error=jsonb_build_object('code',CASE WHEN j.status='RUNNING' THEN 'AI_TIMEOUT' ELSE 'JOB_INTERRUPTED' END,
          'message','The response was interrupted. Your saved answers are safe; you can retry.')
        WHERE status IN ('QUEUED','RUNNING') AND ((status='RUNNING' AND deadline_at<=clock_timestamp()) OR NOT EXISTS (
          SELECT 1 FROM pgboss.job q WHERE q.name=ANY($1) AND q.id=j.id AND q.state IN ('created','retry','active')))`, [[...CONSULTANT_QUEUES]]);
    },
    async execute(id: string, signal: AbortSignal, runStage: ReturnType<typeof createStageRunner>,
      catalog: SapReferenceOptions = {}) {
      if (!z.uuid().safeParse(id).success) return;
      const runToken = randomUUID();
      const job = (await pool.query<StoredJob>(`UPDATE consultant_jobs SET status='RUNNING',run_token=$2,
        deadline_at=clock_timestamp()+make_interval(secs=>$3) WHERE id=$1 AND status='QUEUED' RETURNING *`, [id, runToken, deadlineSeconds])).rows[0];
      if (!job) return;
      try {
        signal.throwIfAborted();
        const input = await transaction(pool, async client => {
          const workspace = await loadWorkspaceForWorker(client, workerScope(job), true);
          if (!workspace.canEdit) throw forbidden();
          if (job.kind === "INTERVIEW") {
            if (workspace.state.messages.findLast(message => message.role === "user")?.id !== job.message_id) throw stale();
            return { kind: "INTERVIEW" as const, input: buildInterviewInput(workspace.state, job.message_id!) };
          }
          if (workspace.state.revision !== job.input_revision) throw stale();
          if (!workspace.canConfirm || workspace.confirmedSnapshotId !== job.snapshot_id) throw stale();
          return { kind: "TO_BE" as const, input: await designInput(client, job) };
        });
        const generated = input.kind === "INTERVIEW"
          ? await runStage("interview_turn", input.input, signal)
          : await runStage("to_be", input.input, signal);
        const metrics = metricsSchema.parse(generated.metrics);
        if (metrics.stage !== (job.kind === "INTERVIEW" ? "interview_turn" : "to_be")) throw new Error("Invalid stage metrics");
        signal.throwIfAborted();
        await transaction(pool, async client => {
          const locked = await client.query<{ live: boolean }>(`SELECT deadline_at>clock_timestamp() AS live FROM consultant_jobs
            WHERE id=$1 AND status='RUNNING' AND run_token=$2 FOR UPDATE`, [id, runToken]);
          if (!locked.rowCount) return;
          if (!locked.rows[0]!.live) throw timeoutError();
          const workspace = await loadWorkspaceForWorker(client, workerScope(job), true);
          if (!workspace.canEdit) throw forbidden();
          let result: unknown;
          if (input.kind === "INTERVIEW") {
            // The reply is for the participant's latest message; one sent meanwhile makes it stale. (A revision that moved on
            // because the background extraction recorded an earlier message is fine.)
            if (workspace.state.messages.findLast(message => message.role === "user")?.id !== job.message_id) throw stale();
            // Chat half only, onto the latest revision: extraction may have recorded the previous message meanwhile.
            const saved = await persistWorkspaceTurn(client, { ...workerScope(job), expectedRevision: job.input_revision,
              currentMessageId: job.message_id!, turn: generated.payload, requestKey: id, scope: "chat" });
            result = { workspaceRevision: saved.state.revision };
          } else {
            if (workspace.state.revision !== job.input_revision) throw stale();
            if (!workspace.canConfirm || workspace.confirmedSnapshotId !== job.snapshot_id) throw stale();
            const validation = validateToBeOutput(input.input, (generated.payload as { design?: unknown }).design,
              await loadToBeReferences(input.input, catalog), reviewBlockers((generated.payload as { reviewFindings?: ReviewOutcome[] }).reviewFindings));
            if (!validation.success) throw new Error("Invalid design output");
            result = { ...validation.data, sourceRevision: job.input_revision, snapshotId: job.snapshot_id,
              status: validation.data.evaluation.blockers.length ? "BLOCKED" : "HUMAN_REVIEW_REQUIRED" };
          }
          signal.throwIfAborted();
          const completed = await client.query(`UPDATE consultant_jobs SET status='SUCCEEDED',result=$3,metrics=$4,
            run_token=NULL,deadline_at=NULL,finished_at=clock_timestamp()
            WHERE id=$1 AND status='RUNNING' AND run_token=$2 AND deadline_at>clock_timestamp()`, [id, runToken, result, metrics]);
          if (!completed.rowCount) throw timeoutError();
          signal.throwIfAborted();
        });
      } catch (error) {
        const safe = z.enum(["AI_INPUT_INVALID", "AI_INPUT_TOO_LARGE", "AI_INVALID_OUTPUT", "AI_PROVIDER_ERROR", "AI_PROVIDER_CREDIT", "AI_TIMEOUT", "AI_CANCELLED", "STALE_INPUT"])
          .safeParse((error as { code?: unknown })?.code);
        const code = signal.aborted ? "AI_CANCELLED" : safe.success ? safe.data : "CONSULTANT_FAILED";
        console.error(JSON.stringify({ event: "consultant_job_failed", jobId: id, kind: job.kind, code, cause: failureCode(error) }));
        await pool.query(`UPDATE consultant_jobs SET status='FAILED',error=$3,run_token=NULL,deadline_at=NULL,finished_at=clock_timestamp()
          WHERE id=$1 AND status='RUNNING' AND run_token=$2`, [id, runToken, { code,
          message: code === "STALE_INPUT" ? "The answers changed while the consultant was working. Review the latest conversation and retry."
            : code === "AI_PROVIDER_CREDIT" ? PROVIDER_CREDIT_MESSAGE
            : code === "AI_TIMEOUT" ? "The consultant took too long to respond. Your saved answers are safe; you can retry."
            : "The consultant could not finish this response. Your saved answers are safe; you can retry." }]);
      }
    },
  };
}
