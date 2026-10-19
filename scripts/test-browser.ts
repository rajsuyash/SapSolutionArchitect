import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer as httpServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);
const local = parseEnv(await readFile(new URL("../.env.example", import.meta.url), "utf8"));
const database = `sap_browser_${randomUUID().replaceAll("-", "")}`;
if (!local.DATABASE_URL) throw new Error("Missing local test database URL");
const url = new URL(local.DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Browser harness requires local PostgreSQL");
const admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
url.pathname = `/${database}`;
let child: ChildProcess | undefined;
let proxy: ReturnType<typeof httpsServer> | undefined;
let temporary: string | undefined;
let created = false;
let connected = false;

async function stop(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, "exit"); process.kill("SIGTERM");
  const timer = setTimeout(() => process.kill("SIGKILL"), 7000);
  try { await exited; } finally { clearTimeout(timer); }
}

// The Playwright runner and its per-test workers share a dedicated process group.
// Clean that group even if the runner died before its test finally blocks ran.
async function stopTestGroup(pid: number | undefined) {
  if (!pid) return;
  const signal = (value: NodeJS.Signals | 0) => {
    try { process.kill(-pid, value); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  if (!signal("SIGTERM")) return;
  const until = Date.now() + 7000;
  while (Date.now() < until) { if (!signal(0)) return; await delay(50); }
  signal("SIGKILL");
}

try {
  console.log("Building current source before the isolated browser run...");
  await run("pnpm", ["build"], { cwd, timeout: 120000 });
  await admin.connect(); connected = true;
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  await run("pnpm", ["db:seed"], { cwd, timeout: 30000,
    env: { PATH: process.env.PATH, ...local, NODE_ENV: "test", DATABASE_URL: url.href } });
  temporary = await mkdtemp("/private/tmp/sap-browser-tls-");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", `${temporary}/key.pem`, "-out", `${temporary}/cert.pem`], { timeout: 10000 });
  const probe = httpServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No local test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  proxy = httpsServer({ key: await readFile(`${temporary}/key.pem`), cert: await readFile(`${temporary}/cert.pem`) }, (incoming, outgoing) => {
    const upstream = request({ hostname: "127.0.0.1", port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, "x-forwarded-proto": "https" } }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on("aborted", () => upstream.destroy()); incoming.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("No local HTTPS port");
  const origin = `https://127.0.0.1:${proxyAddress.port}`;
  child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd, stdio: "ignore", env: { PATH: process.env.PATH, ...local, NODE_ENV: "production", DATABASE_URL: url.href,
      APP_URL: origin, AUTH_SECRET: "synthetic-browser-production-secret-32-characters", AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "unused-synthetic", EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "unused-synthetic", S3_ENDPOINT: "https://unused.test" },
  });
  const until = Date.now() + 15000;
  while (true) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > until) throw new Error("Production server did not become ready");
    try { if ((await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(1000) })).status === 200) break; } catch { /* Startup only. */ }
    await delay(100);
  }
  const tests = spawn("pnpm", ["test:browser"], { cwd, detached: true, stdio: "inherit", env: { ...process.env,
    PLAYWRIGHT_BASE_URL: origin, BROWSER_TEST_DATABASE_URL: url.href, RUN_SYNTHETIC_E2E: "1" } });
  const timeout = setTimeout(() => tests.kill("SIGTERM"), 240000);
  try {
    const [code] = await once(tests, "exit");
    if (code !== 0) throw new Error(`Browser suite exited ${code}`);
  } finally { clearTimeout(timeout); await stopTestGroup(tests.pid); await stop(tests); }
  console.log("Production HTTPS browser suite and synthetic API/worker checks passed. AI quality was not evaluated.");
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy!.close(() => resolve())); }
  await stop(child);
  try {
    if (created) {
      await admin.query(`DROP DATABASE "${database}"`);
      const remaining = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [database]);
      if (remaining.rowCount) throw new Error("Temporary browser database was not removed");
      console.log("Temporary browser database removed; existing project data preserved.");
    }
  } finally {
    if (connected) await admin.end();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
