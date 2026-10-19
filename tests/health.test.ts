import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { parseEnv } from "node:util";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const workerEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...local, NODE_ENV: "test" };
const workerArgs = ["--import", "tsx", "src/worker.ts"];

it("worker refuses invalid configuration before opening services and hides values", async () => {
  const child = spawn(process.execPath, workerArgs, {
    env: { ...workerEnv, DATABASE_URL: "private-invalid-value" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(output).toContain("DATABASE_URL");
    expect(output).not.toContain("private-invalid-value");
  } finally {
    clearTimeout(timer);
  }
}, 7000);

// Run after pnpm build: RUN_BUILD_TESTS=1 pnpm test tests/health.test.ts
it.skipIf(process.env.RUN_BUILD_TESTS !== "1")("production web refuses invalid configuration at startup", async () => {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3027"], {
    env: { ...workerEnv, NODE_ENV: "production", DATABASE_URL: "private-invalid-value" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(output).toContain("Invalid environment variables: DATABASE_URL");
    expect(output).not.toContain("private-invalid-value");
    // Next can print Ready before registration; process termination is the meaningful gate.
    await expect(fetch("http://127.0.0.1:3027/login", { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
}, 10000);

it.each(["send", "lookup"])("bounds a stalled queue %s and rejects expired results before recovery", async (stalled) => {
  const globalState = globalThis as typeof globalThis & { sapPmRuntime?: unknown };
  const previous = globalState.sapPmRuntime;
  delete globalState.sapPmRuntime;
  let releaseSend!: (id: string | null) => void;
  let releaseLookup!: (job: { state: string }) => void;
  const queue = {
    start: vi.fn().mockResolvedValue(undefined), createQueue: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(() => stalled === "send"
      ? new Promise<string | null>((resolve) => { releaseSend = resolve; }) : Promise.resolve("probe-id")),
    getJobById: vi.fn(() => stalled === "lookup"
      ? new Promise<{ state: string }>((resolve) => { releaseLookup = resolve; })
      : Promise.resolve({ state: "completed" })),
  };
  vi.doMock("../src/lib/infrastructure", () => ({ createInfrastructure: () => ({
    queue, pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
    storage: { send: vi.fn().mockResolvedValue({}) },
  }) }));
  for (const [name, value] of Object.entries(local)) vi.stubEnv(name, value);
  vi.stubEnv("NODE_ENV", "test");
  vi.useFakeTimers();
  vi.resetModules();
  try {
    const { getRuntime } = await import("../src/lib/runtime");
    const app = getRuntime();
    const pending = app.health();
    await vi.advanceTimersByTimeAsync(4501);
    expect(await pending).toEqual({ db: "ok", queue: "error", storage: "ok" });
    const retry = app.health();
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.send).toHaveBeenCalledTimes(1);
    if (stalled === "send") releaseSend(null);
    else releaseLookup({ state: "completed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await retry).toEqual({ db: "ok", queue: "error", storage: "ok" });
    queue.send.mockResolvedValue("recovered-probe");
    queue.getJobById.mockResolvedValue({ state: "completed" });
    expect(await app.health()).toEqual({ db: "ok", queue: "ok", storage: "ok" });
    expect(queue.send).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.doUnmock("../src/lib/infrastructure");
    vi.resetModules();
    if (previous === undefined) delete globalState.sapPmRuntime;
    else globalState.sapPmRuntime = previous;
  }
});

// Start the dev web server on 3017; this suite owns and stops its own worker.
// Run: RUN_HEALTH_TESTS=1 pnpm test tests/health.test.ts
describe.skipIf(process.env.RUN_HEALTH_TESTS !== "1")("M0-AC2 over HTTP", () => {
  const observer = new PgBoss(local.DATABASE_URL!);
  let worker: ChildProcess | undefined;
  const health = () => fetch("http://127.0.0.1:3017/api/health", { signal: AbortSignal.timeout(7000) });

  async function startWorker() {
    const child = spawn(process.execPath, workerArgs, { env: workerEnv, stdio: ["ignore", "pipe", "pipe"] });
    worker = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker readiness timed out")), 15000);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("Worker ready")) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on("data", () => { /* Errors are asserted through readiness/exit, not printed. */ });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Worker exited before readiness")); });
    });
  }

  async function stopWorker() {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const child = worker;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
    try {
      const [code] = await exited;
      expect(code).toBe(0);
    } finally {
      clearTimeout(timer);
      worker = undefined;
    }
  }

  beforeAll(async () => {
    observer.on("error", () => { /* Query failures fail assertions below. */ });
    await observer.start();
    await startWorker();
    // Compile the route before measuring request latency.
    expect((await health()).status).toBe(200);
  }, 25000);

  afterAll(async () => {
    try { await stopWorker(); } finally { await observer.stop(); }
  }, 15000);

  it("returns fresh component status only after a persisted job succeeds within 5s", async () => {
    const previous = new Set((await observer.findJobs("health.noop")).map((job) => job.id));
    const started = performance.now();
    const response = await health();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ db: "ok", queue: "ok", storage: "ok" });
    expect(performance.now() - started).toBeLessThan(5000);
    const created = (await observer.findJobs("health.noop")).filter((job) => !previous.has(job.id));
    expect(created).toHaveLength(1);
    expect(created[0]?.state).toBe("completed");
    expect(created[0]?.output).toEqual({ status: "SUCCEEDED" });
    expect(created[0]!.completedOn!.getTime() - created[0]!.createdOn.getTime()).toBeLessThan(5000);
  });

  it("returns 503 with a stopped worker and recovers after its restart", async () => {
    await stopWorker();
    const started = performance.now();
    const response = await health();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ db: "ok", queue: "error", storage: "ok" });
    expect(performance.now() - started).toBeLessThan(5500);
    await startWorker();
    expect((await health()).status).toBe(200);
  }, 25000);
});
