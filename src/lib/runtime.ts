import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnvironment } from "./env";
import { createInfrastructure } from "./infrastructure";
import { createAuthService } from "./auth";
import { createProjectRepository } from "./tenant";
import { createJobService } from "./jobs";
import { createDiscoveryRepository } from "./discovery";
import { createDiscoveryWorkspaceRepository } from "./discovery-workspace";
import { createConsultantJobs } from "./consultant-jobs";
import { createPlatformAdmin } from "./platform-admin";

export const HEALTH_QUEUE = "health.noop";
type Status = "ok" | "error";
type Health = { db: Status; queue: Status; storage: Status };

async function measure(probe: (signal: AbortSignal) => Promise<unknown>): Promise<Status> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Health probe timed out"));
        }, 4500);
      }),
    ]);
    return "ok";
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function createRuntime() {
  // No sockets open until a service is used. Invalid config fails during server registration.
  const config = parseEnvironment();
  const services = createInfrastructure(config);
  const auth = createAuthService(services.pool, { secret: config.AUTH_SECRET, appUrl: config.APP_URL });
  const projects = createProjectRepository(services.pool, auth);
  const discovery = createDiscoveryRepository(services.pool, auth);
  const workspaces = createDiscoveryWorkspaceRepository(services.pool, auth);
  const jobs = createJobService(services.pool, auth, services.queue, startQueue);
  const consultantJobs = createConsultantJobs(services.pool, auth, services.queue, startQueue,
    { dailyJobLimit: config.CONSULTANT_DAILY_JOB_LIMIT });
  const platformAdmin = createPlatformAdmin(services.pool, auth, config);
  let queueStart: Promise<void> | undefined;
  let pendingHealth: Promise<Health> | undefined;
  let pendingQueueProbe: Promise<void> | undefined;

  function startQueue(): Promise<void> {
    queueStart ??= (async () => {
      await services.queue.start();
      await services.queue.createQueue(HEALTH_QUEUE, {
        retryLimit: 0, expireInSeconds: 5, retentionSeconds: 60, deleteAfterSeconds: 60,
      });
      await jobs.initialize();
      await consultantJobs.initialize();
    })().catch((error: unknown) => {
      queueStart = undefined; // A transient DB failure must not poison later checks.
      throw error;
    });
    return queueStart;
  }

  async function runQueueProbe(signal: AbortSignal): Promise<void> {
    await startQueue();
    signal.throwIfAborted();
    const id = await services.queue.send(HEALTH_QUEUE, {});
    if (!id) throw new Error("Health job was not enqueued");
    while (!signal.aborted) {
      const job = await services.queue.getJobById(HEALTH_QUEUE, id);
      signal.throwIfAborted();
      if (job?.state === "completed") return;
      if (!job || job.state === "failed" || job.state === "cancelled") throw new Error("Health job failed");
      await delay(50, undefined, { signal });
    }
    signal.throwIfAborted();
  }

  function probeQueue(signal: AbortSignal): Promise<void> {
    // pg-boss does not accept AbortSignal for SQL calls. Keep this guard until the
    // underlying operation settles, even after the HTTP deadline has expired.
    pendingQueueProbe ??= runQueueProbe(signal).finally(() => { pendingQueueProbe = undefined; });
    return pendingQueueProbe;
  }

  async function probeHealth(): Promise<Health> {
    // pg supports per-query query_timeout; its QueryConfig type currently omits it.
    const healthQuery = { text: "select 1", query_timeout: 3000 };
    const [db, queue, storage] = await Promise.all([
      measure(() => services.pool.query(healthQuery)),
      measure(probeQueue),
      measure((signal) => services.storage.send(
        new HeadBucketCommand({ Bucket: config.S3_BUCKET }), { abortSignal: signal },
      )),
    ]);
    return { db, queue, storage };
  }

  function health(): Promise<Health> {
    // Share in-flight checks to bound queue/pool pressure; never cache a completed result.
    pendingHealth ??= probeHealth().finally(() => { pendingHealth = undefined; });
    return pendingHealth;
  }

  return { config, services, auth, projects, discovery, workspaces, jobs, consultantJobs, platformAdmin, startQueue, health };
}

const processState = globalThis as typeof globalThis & { sapPmRuntime?: ReturnType<typeof createRuntime> };

/** Reuse connections across Next development reloads and route module instances. */
export function getRuntime() {
  processState.sapPmRuntime ??= createRuntime();
  return processState.sapPmRuntime;
}
