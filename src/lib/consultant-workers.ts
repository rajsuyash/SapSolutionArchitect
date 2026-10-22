import type { PgBoss } from "pg-boss";
import { CONSULTANT_BATCH_QUEUE, CONSULTANT_CHAT_QUEUE, LEGACY_CONSULTANT_QUEUE, type createConsultantJobs } from "./consultant-jobs";
import type { createStageRunner } from "./ai/runStage";
import type { SapReferenceOptions } from "./ai/sap-references";

type Options = { chatConcurrency: number; batchConcurrency: number; shutdown: AbortSignal; catalog?: SapReferenceOptions;
  pollingIntervalSeconds?: number };

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
  return { stop: () => Promise.all(registrations.map(([name]) => queue.offWork(name))).then(() => {}) };
}
