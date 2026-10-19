// Local: pnpm exec tsx --env-file=.env src/worker.ts
// Production: supply environment variables to node --import tsx src/worker.ts.
import { ensureDevelopmentBucket } from "./lib/infrastructure";
import { getRuntime, HEALTH_QUEUE } from "./lib/runtime";
import { ANALYSIS_QUEUE } from "./lib/jobs";
import { createStageRunner } from "./lib/ai/runStage";

async function run() {
  const { config, services, jobs, startQueue } = getRuntime();
  const shutdown = new AbortController();
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let recovery: Promise<void> | undefined;
  try {
    if (config.NODE_ENV !== "production") await ensureDevelopmentBucket(services.storage, config);
    await startQueue();
    await jobs.recover();
    const runStage = createStageRunner(config);
    await services.queue.work<{ jobId: string }>(ANALYSIS_QUEUE, {
      batchSize: 1, localConcurrency: config.AI_MAX_CONCURRENCY, pollingIntervalSeconds: 0.5,
    }, async ([job]) => {
      if (!job || job.data.jobId !== job.id) return;
      await jobs.execute(job.id, AbortSignal.any([job.signal, shutdown.signal]), runStage);
    });
    recoveryTimer = setInterval(() => {
      recovery ??= jobs.recover().catch(() => { console.error("Analysis recovery check failed"); })
        .finally(() => { recovery = undefined; });
    }, 10000);
    await services.queue.work(HEALTH_QUEUE, { pollingIntervalSeconds: 0.5 }, async () => ({ status: "SUCCEEDED" }));
    console.info("Worker ready");
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        shutdown.abort();
        resolve();
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
  } finally {
    clearInterval(recoveryTimer);
    shutdown.abort();
    await recovery;
    await services.close();
  }
}

run().catch((error: unknown) => {
  // Config validation reports names only; provider/driver errors may include credentials.
  const message = error instanceof Error && error.message.startsWith("Invalid environment variables:")
    ? error.message : "Worker failed to start or shut down";
  console.error(message);
  process.exitCode = 1;
});
