import type { PgBoss } from "pg-boss";
import { CONSULTANT_EXTRACT_QUEUE, executeExtraction } from "./consultant-extraction";
import type { Pool } from "pg";
import { CONSULTANT_BATCH_QUEUE, CONSULTANT_CHAT_QUEUE, LEGACY_CONSULTANT_QUEUE, type createConsultantJobs } from "./consultant-jobs";
import type { createStageRunner } from "./ai/runStage";
import type { SapReferenceOptions } from "./ai/sap-references";

type Options = { chatConcurrency: number; batchConcurrency: number; shutdown: AbortSignal; catalog?: SapReferenceOptions;
  pollingIntervalSeconds?: number;
  /** The background extraction consumer. Every interview turn also queues one extraction job, so a worker that omits this
   * leaves those jobs waiting and no proposals appear. `maxWaitSeconds` bounds the wait for earlier messages' jobs. */
  extract?: { pool: Pool; concurrency: number; maxWaitSeconds?: number } };

/** Register the consultant queue consumers. Each queue has its own pg-boss worker pool, so a To-Be run holding every
 * batch slot never blocks an interview turn. (Model-call slots are separate too: see the chat lane in runStage.)
 * The legacy single queue is drained by one worker so jobs queued before the split are not stranded. */
export async function workConsultantQueues(queue: PgBoss, consultantJobs: ReturnType<typeof createConsultantJobs>,
  runStage: ReturnType<typeof createStageRunner>, options: Options) {
  const polling = options.pollingIntervalSeconds ?? 0.5;
  const handler = async ([job]: { id: string; data: { jobId: string }; signal: AbortSignal }[] = []) => {
    if (!job || job.data.jobId !== job.id) return;
    await consultantJobs.execute(job.id, AbortSignal.any([job.signal, options.shutdown]), runStage, options.catalog);
  };
  const registrations = [[CONSULTANT_CHAT_QUEUE, options.chatConcurrency],
    [CONSULTANT_BATCH_QUEUE, options.batchConcurrency], [LEGACY_CONSULTANT_QUEUE, 1]] as const;
  for (const [name, localConcurrency] of registrations) {
    await queue.work<{ jobId: string }>(name, { batchSize: 1, localConcurrency, pollingIntervalSeconds: polling }, handler);
  }
  const extract = options.extract;
  if (extract) {
    await queue.work<unknown>(CONSULTANT_EXTRACT_QUEUE, { batchSize: 1, localConcurrency: extract.concurrency, pollingIntervalSeconds: polling },
      async ([job]) => {
        if (!job) return;
        // The handler's return value is kept by pg-boss as the job's output (tokens, latency, repairs) for later inspection.
        return executeExtraction(extract.pool, runStage, { id: job.id, data: job.data }, AbortSignal.any([job.signal, options.shutdown]),
          extract.maxWaitSeconds ?? 300);
      });
  }
  const names = [...registrations.map(([name]) => name), ...(extract ? [CONSULTANT_EXTRACT_QUEUE] : [])];
  return { stop: () => Promise.all(names.map(name => queue.offWork(name))).then(() => {}) };
}
