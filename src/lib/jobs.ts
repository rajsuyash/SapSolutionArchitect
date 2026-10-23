import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { AuthError, transaction, type AuthService, type SessionUser } from "./auth";
import { withTenantSession } from "./tenant";
import { assertOrgCanRunAi } from "./org-limits";
import { validateProblemAnalysis, type ProblemAnalysis } from "./ai/problem-analysis";
import type { createStageRunner } from "./ai/runStage";
import { PROVIDER_CREDIT_MESSAGE } from "./ai/provider";
import { DEFAULT_STAGE_BUDGET_SECONDS, jobTiming } from "./ai/timeouts";

export const ANALYSIS_QUEUE = "analysis.problem";
const uuid = z.uuid();
const notFound = (entity: "JOB" | "PROJECT") => new AuthError(`${entity}_NOT_FOUND`, 404, `${entity === "JOB" ? "Job" : "Project"} not found`);
const invalidState = () => new AuthError("INVALID_STATE", 409, "This operation is not available in the current state");
const metricSchema = z.object({ stage: z.literal("problem_analysis"), provider: z.enum(["stub", "anthropic", "deepinfra", "openrouter"]),
  model: z.string().max(160), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative(), attempts: z.number().int().nonnegative(),
  validationErrors: z.array(z.object({ path: z.string().max(200), code: z.string().max(80), detail: z.string().max(200).optional() })).max(1000) });
const errorCodes = z.enum(["AI_INPUT_INVALID", "AI_INPUT_TOO_LARGE", "AI_INVALID_OUTPUT", "AI_PROVIDER_ERROR", "AI_PROVIDER_CREDIT", "AI_TIMEOUT", "AI_CANCELLED"]);
type Job = { id: string; kind: string; status: string; progressLabel: string;
  error: { code: string; message: string } | null; result: { analysisId: string } | null };
type StoredJob = { id: string; org_id: string; project_id: string; requested_by: string; request_id: string; status: string };

/** HTTP methods use authenticated RLS transactions. Worker methods are trusted,
 * have no route, and derive org/project only from a persisted queue-bound job.
 * Provider code is imported by the worker only, not by the Next runtime.
 */
export function createJobService(pool: Pool, auth: AuthService, queue: PgBoss, startQueue: () => Promise<void>,
  { stageBudgetSeconds = DEFAULT_STAGE_BUDGET_SECONDS }: { stageBudgetSeconds?: number } = {}) {
  const { deadlineSeconds, queueExpireSeconds } = jobTiming(stageBudgetSeconds);
  async function authorize(client: PoolClient, user: SessionUser, projectId: string) {
    if (!uuid.safeParse(projectId).success) throw notFound("PROJECT");
    const project = (await client.query<{ is_demo: boolean; setup_status: string; project_role: string | null }>(
      `SELECT p.is_demo,p.setup_status,m.project_role FROM projects p LEFT JOIN project_memberships m
       ON m.org_id=p.org_id AND m.project_id=p.id AND m.user_id=$3 WHERE p.org_id=$1 AND p.id=$2`,
      [user.orgId, projectId, user.id])).rows[0];
    if (!project || (user.orgRole === "GUEST" && !project.project_role)) throw notFound("PROJECT");
    if (project.is_demo) throw new AuthError("DEMO_READ_ONLY", 403, "Demo projects are read-only");
    if (user.orgRole === "GUEST" || !["LEAD", "CONSULTANT"].includes(project.project_role ?? "")) {
      throw new AuthError("FORBIDDEN", 403, "Only project leads and consultants can run analysis");
    }
    if (project.setup_status === "ACTIVE") throw invalidState();
  }

  async function enqueue(client: PoolClient, user: SessionUser, projectId: string, requestId: string, retryOf?: string) {
    await authorize(client, user, projectId);
    await startQueue();
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`analysis:${user.orgId}:${projectId}`]);
    const existing = (await client.query<{ id: string }>(
      "SELECT id FROM jobs WHERE org_id=$1 AND project_id=$2 AND status IN ('QUEUED','RUNNING')", [user.orgId, projectId])).rows[0];
    if (existing) throw Object.assign(new AuthError("JOB_ALREADY_RUNNING", 409, "An analysis is already queued or running"), { jobId: existing.id });
    await assertOrgCanRunAi(client, user.orgId);
    const id = randomUUID();
    await client.query(`INSERT INTO jobs(id,org_id,project_id,kind,requested_by,request_id,retry_of)
      VALUES($1,$2,$3,'PROBLEM_ANALYSIS',$4,$5,$6)`, [id, user.orgId, projectId, user.id, requestId, retryOf ?? null]);
    // The sole privilege restoration is for trusted pg-boss SQL. Both inserts use
    // this checked-out transaction; no caller SQL or subsequent tenant reads run here.
    await client.query("SET LOCAL ROLE NONE");
    const queued = await queue.send(ANALYSIS_QUEUE, { jobId: id }, { id, retryLimit: 0, expireInSeconds: queueExpireSeconds,
      retentionSeconds: 3600, deleteAfterSeconds: 604800, db: { executeSql: (text, values) => client.query(text, values) } });
    if (!queued) throw new Error("Analysis enqueue failed");
    return { jobId: id };
  }

  const service = {
    latest: (token: string | null, projectId: string) => withTenantSession(pool, auth, token, async ({ client, user }) => {
      if (!uuid.safeParse(projectId).success) throw notFound("PROJECT");
      const project = (await client.query<{ is_demo: boolean; setup_status: string; project_role: string | null }>(
        `SELECT p.is_demo,p.setup_status,m.project_role FROM projects p LEFT JOIN project_memberships m
         ON m.org_id=p.org_id AND m.project_id=p.id AND m.user_id=$3 WHERE p.org_id=$1 AND p.id=$2`,
        [user.orgId, projectId, user.id])).rows[0];
      if (!project || (user.orgRole === "GUEST" && !project.project_role)) throw notFound("PROJECT");
      const job = (await client.query<Job>(`SELECT id,kind,status,progress_label AS "progressLabel",error,result
        FROM jobs WHERE org_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [user.orgId, projectId])).rows.at(0) ?? null;
      const analysis = (await client.query<{ payload: ProblemAnalysis }>(`SELECT payload FROM problem_analyses
        WHERE org_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [user.orgId, projectId])).rows.at(0)?.payload ?? null;
      return { job, analysis, canAnalyze: !project.is_demo && project.setup_status !== "ACTIVE" && user.orgRole !== "GUEST"
        && ["LEAD", "CONSULTANT"].includes(project.project_role ?? "") };
    }),
    enqueue: (token: string | null, projectId: string, requestId: string) => withTenantSession(pool, auth, token,
      ({ client, user }) => enqueue(client, user, projectId, requestId)),
    get: (token: string | null, id: string) => withTenantSession(pool, auth, token, async ({ client, user }) => {
      if (!uuid.safeParse(id).success) throw notFound("JOB");
      const job = (await client.query<Job>(`SELECT id,kind,status,progress_label AS "progressLabel",error,result
        FROM jobs WHERE org_id=$1 AND id=$2`, [user.orgId, id])).rows[0];
      if (!job) throw notFound("JOB");
      return job;
    }),
    retry: (token: string | null, id: string, requestId: string) => withTenantSession(pool, auth, token, async ({ client, user }) => {
      if (!uuid.safeParse(id).success) throw notFound("JOB");
      const job = (await client.query<StoredJob>("SELECT id,project_id,status FROM jobs WHERE org_id=$1 AND id=$2", [user.orgId, id])).rows[0];
      if (!job) throw notFound("JOB");
      if (job.status !== "FAILED") throw invalidState();
      return enqueue(client, user, job.project_id, requestId, job.id);
    }),
    async initialize() {
      await queue.createQueue(ANALYSIS_QUEUE, { retryLimit: 0, expireInSeconds: queueExpireSeconds, retentionSeconds: 3600, deleteAfterSeconds: 604800 });
    },
    async recover() {
      // A dead process cannot execute catch/finally. Reconcile durable queue failures
      // and application deadlines, also after restart. The status update fences late writes.
      await pool.query(`UPDATE jobs j SET status='FAILED',progress_label='Analysis failed',
        error=jsonb_build_object('code',CASE WHEN j.status='RUNNING' THEN 'AI_TIMEOUT' ELSE 'JOB_INTERRUPTED' END,
          'message','Analysis was interrupted. You can retry.'),run_token=NULL,deadline_at=NULL,finished_at=now()
        WHERE j.status IN ('QUEUED','RUNNING') AND ((j.status='RUNNING' AND j.deadline_at<=clock_timestamp()) OR NOT EXISTS (
          SELECT 1 FROM pgboss.job q WHERE q.name=$1 AND q.id=j.id AND q.state IN ('created','retry','active')))`, [ANALYSIS_QUEUE]);
    },
    async execute(id: string, signal: AbortSignal, runStage: ReturnType<typeof createStageRunner>) {
      if (!uuid.safeParse(id).success) return;
      const runToken = randomUUID();
      const claimed = await transaction(pool, async (client) => {
        const job = (await client.query<StoredJob>(`UPDATE jobs SET status='RUNNING',run_token=$2,
          deadline_at=now()+make_interval(secs=>$3),progress_label='Analyzing the business problem'
          WHERE id=$1 AND status='QUEUED' RETURNING *`, [id, runToken, deadlineSeconds])).rows[0];
        if (!job) return null;
        const project = (await client.query(`SELECT p.name,p.client_name AS "clientName",p.problem_statement AS "problemStatement",
          p.target_product AS "targetProduct",p.starting_landscape AS "startingLandscape",p.modules
          FROM projects p JOIN users u ON u.org_id=p.org_id AND u.id=$3
          JOIN project_memberships m ON m.org_id=p.org_id AND m.project_id=p.id AND m.user_id=u.id
          WHERE p.org_id=$1 AND p.id=$2 AND NOT p.is_demo AND p.setup_status<>'ACTIVE'
          AND u.org_role IN ('ADMIN','MEMBER') AND m.project_role IN ('LEAD','CONSULTANT')`,
          [job.org_id, job.project_id, job.requested_by])).rows[0];
        if (!project) return { job, input: null };
        const units = await client.query("SELECT type,code,name FROM org_units WHERE org_id=$1 AND project_id=$2 ORDER BY type,code", [job.org_id, job.project_id]);
        const candidates = await client.query(`SELECT kind,code,title,summary FROM (
          SELECT DISTINCT ON (kind,code) kind,code,title,summary FROM sap_references
          WHERE (org_id IS NULL OR org_id=$1) AND $2=ANY(target_products)
            AND (cardinality($3::text[])=0 OR module=ANY($3::text[]))
          ORDER BY kind,code,org_id NULLS LAST) r ORDER BY kind,code LIMIT 50`, [job.org_id, project.targetProduct, project.modules]);
        return { job, input: { ...project, orgUnits: units.rows, candidates: candidates.rows } };
      });
      if (!claimed) return;
      const { job, input } = claimed;
      let metrics: z.infer<typeof metricSchema> | undefined;
      try {
        if (!input) throw new Error("Authorization changed");
        signal.throwIfAborted();
        const result = await runStage("problem_analysis", input, signal);
        metrics = metricSchema.parse(result.metrics);
        const validated = validateProblemAnalysis(result.payload, input.problemStatement);
        if (!validated.success) throw new Error("Invalid analysis result");
        signal.throwIfAborted();
        await transaction(pool, async (client) => {
          // The winning attempt alone can persist output and advance setup state.
          const locked = await client.query(`SELECT id FROM jobs WHERE id=$1 AND org_id=$2 AND status='RUNNING'
            AND run_token=$3 AND deadline_at>clock_timestamp() FOR UPDATE`, [id, job.org_id, runToken]);
          if (!locked.rowCount || signal.aborted) return;
          const analysisId = randomUUID();
          const updated = await client.query("UPDATE projects SET setup_status='SCOPE_PROPOSED' WHERE org_id=$1 AND id=$2 AND setup_status<>'ACTIVE' AND NOT is_demo", [job.org_id, job.project_id]);
          if (!updated.rowCount) throw new Error("Project state changed");
          await client.query("INSERT INTO problem_analyses(id,org_id,project_id,job_id,payload) VALUES($1,$2,$3,$4,$5)", [analysisId, job.org_id, job.project_id, id, validated.data]);
          signal.throwIfAborted();
          const completed = await client.query(`UPDATE jobs SET status='SUCCEEDED',progress_label='Analysis ready',result=$2,metrics=$3,
            run_token=NULL,deadline_at=NULL,finished_at=clock_timestamp()
            WHERE id=$1 AND status='RUNNING' AND run_token=$4 AND deadline_at>clock_timestamp()`, [id, { analysisId }, metrics, runToken]);
          if (!completed.rowCount) throw Object.assign(new Error("AI_TIMEOUT"), { code: "AI_TIMEOUT", metrics });
          signal.throwIfAborted();
        });
      } catch (error) {
        const detail = z.object({ code: errorCodes, metrics: metricSchema }).safeParse(error);
        const code = signal.aborted ? "AI_CANCELLED" : detail.success ? detail.data.code : "ANALYSIS_FAILED";
        metrics ??= detail.success ? detail.data.metrics : undefined;
        await pool.query(`UPDATE jobs SET status='FAILED',progress_label='Analysis failed',error=$4,metrics=$5,
          run_token=NULL,deadline_at=NULL,finished_at=now() WHERE id=$1 AND org_id=$2 AND status='RUNNING' AND run_token=$3`,
          [id, job.org_id, runToken, { code, message: code === "AI_PROVIDER_CREDIT" ? PROVIDER_CREDIT_MESSAGE : "Analysis could not be completed. You can retry." }, metrics ?? null]);
      }
      console.info(JSON.stringify({ event: "analysis_attempt_finished", orgId: job.org_id, jobId: id, requestId: job.request_id }));
    },
  };
  return service;
}
