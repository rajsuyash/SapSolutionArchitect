import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv, promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthError } from "../src/lib/auth";
import { handleAuth, type HttpRuntime } from "../src/lib/auth-http";
import { fixtureId } from "../scripts/seed";
import { validateProject } from "../src/lib/tenant";

const projectDetails = { name: "Order transformation", clientName: "Acme", problemStatement: "Our order processing relies on manual spreadsheets and delays deliveries to customers.", targetProduct: "S4HANA_CLOUD_PUBLIC" };
describe("project validation", () => {
  it("normalizes inputs and strips caller-controlled identity and status", () => {
    expect(validateProject({ ...projectDetails, orgId: randomUUID(), createdBy: randomUUID(), setupStatus: "ACTIVE", isDemo: true,
      modules: ["sd", " MM ", "SD"], orgUnits: [{ type: "PLANT", code: " p1 ", name: " Factory " }] }))
      .toEqual({ ...projectDetails, startingLandscape: "MIXED", modules: ["MM", "SD"], orgUnits: [{ type: "PLANT", code: "P1", name: "Factory" }] });
  });
  it.each([{ name: " " }, { clientName: "x".repeat(161) }, { problemStatement: "x".repeat(49) },
    { problemStatement: "x".repeat(20001) }, { targetProduct: "invalid" }, { startingLandscape: "invalid" },
    { modules: ["<script>"] }, { orgUnits: [{ type: "INVALID", code: "1", name: "Unit" }] },
    { orgUnits: [{ type: "PLANT", code: "a", name: "One" }, { type: "PLANT", code: "A", name: "Two" }] },
  ])("rejects invalid project fields: %j", (invalid) => { expect(() => validateProject({ ...projectDetails, ...invalid })).toThrow(); });
});

const origin = "https://sap-http.test";
function mockRuntime() {
  return { config: { APP_URL: origin }, auth: { signup: vi.fn(), login: vi.fn(), logout: vi.fn(),
    authenticate: vi.fn(), resolveSession: vi.fn() }, projects: { list: vi.fn(), get: vi.fn(), create: vi.fn() },
    jobs: { latest: vi.fn(), enqueue: vi.fn(), get: vi.fn(), retry: vi.fn(), initialize: vi.fn(), execute: vi.fn(), recover: vi.fn() } } satisfies HttpRuntime;
}
function post(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/auth/signup`, { method: "POST", body,
    headers: { origin, "content-type": "application/json", ...headers },
    ...((body instanceof ReadableStream) ? { duplex: "half" } : {}) });
}

describe("auth HTTP boundary", () => {
  it.each([
    ["{broken", {}, 400, "INVALID_JSON"], ["[]", {}, 400, "INVALID_JSON"],
    ["null", {}, 400, "INVALID_JSON"], ["{}", { "content-type": "text/plain" }, 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["{}", { "content-encoding": "gzip" }, 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["x".repeat(9000), {}, 413, "PAYLOAD_TOO_LARGE"],
  ])("rejects malformed input before reaching auth", async (body, headers, status, code) => {
    const runtime = mockRuntime();
    const response = await handleAuth(post(body, headers as Record<string, string>), "signup", () => runtime);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, error: { code, requestId: expect.any(String) } });
    expect(runtime.auth.signup).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("bounds chunked bodies even without Content-Length and cancels the stream", async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; } });
    const runtime = mockRuntime();
    const response = await handleAuth(post(body), "signup", () => runtime);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(runtime.auth.signup).not.toHaveBeenCalled();
  });

  it("times out a stalled body without leaving a pending read", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    try {
      const pending = handleAuth(post(body), "signup", mockRuntime);
      await vi.advanceTimersByTimeAsync(5001);
      expect((await pending).status).toBe(408);
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("rejects writes from missing or untrusted origins before reading credentials", async () => {
    const runtime = mockRuntime();
    for (const supplied of ["", "https://evil.test"]) {
      expect((await handleAuth(post("{}", { origin: supplied }), "login", () => runtime)).status).toBe(403);
    }
    expect(runtime.auth.login).not.toHaveBeenCalled();
  });

  it("hides unexpected errors and logs only the generated request ID", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = mockRuntime();
    runtime.auth.login.mockRejectedValue(new Error("private-db-password-and-email"));
    try {
      const response = await handleAuth(post("{}", { "x-request-id": "untrusted-value" }), "login", () => runtime);
      const body = await response.json();
      expect(response.status).toBe(500);
      expect(body).toMatchObject({ success: false, error: { code: "INTERNAL_ERROR" } });
      expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
      expect(JSON.stringify(body)).not.toMatch(/private-db|untrusted/);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-db|untrusted/);
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it("recognizes auth errors from a separately loaded runtime module", async () => {
    vi.resetModules();
    try {
      const { AuthError: RuntimeAuthError } = await import("../src/lib/auth");
      const error = new RuntimeAuthError("INVALID_FIELD", 400, "Check this field", "email");
      expect(error).not.toBeInstanceOf(AuthError);
      const runtime = mockRuntime();
      runtime.auth.signup.mockRejectedValue(error);
      const response = await handleAuth(post("{}"), "signup", () => runtime);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ success: false,
        error: { code: "INVALID_FIELD", message: "Check this field", field: "email" } });
    } finally { vi.resetModules(); }
  });

  it("includes Retry-After for rate limits and never returns an authentication cookie on failure", async () => {
    const runtime = mockRuntime();
    runtime.auth.login.mockRejectedValue(new AuthError("RATE_LIMITED", 429, "Try again later", undefined, 42));
    const response = await handleAuth(post("{}"), "login", () => runtime);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

// Exercise built Next routes and real PostgreSQL together, isolated from the dev
// server/database. Fake external-provider keys are never used for outbound calls.
describe.skipIf(process.env.RUN_BUILD_TESTS !== "1" || process.env.RUN_DB_TESTS !== "1")("auth over production HTTP", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const database = `sap_http_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  url.pathname = `/${database}`;
  const db = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  let child: ChildProcess | undefined;
  let base = "";
  let created = false;
  let connected = false;
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(8000) });
  const send = (action: string, input: unknown, cookie?: string) => request(`/api/auth/${action}`, {
    method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(input),
  });
  const cookieFrom = (response: Response) => {
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    return cookie!.split(";")[0]!;
  };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    await promisify(execFile)("pnpm", ["db:seed"], {
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000,
    });
    await db.connect(); connected = true;
    const listener = createServer();
    listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("No test port available");
    const port = address.port;
    await new Promise<void>((accept, reject) => listener.close((error) => error ? reject(error) : accept()));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      env: { PATH: process.env.PATH, ...local, NODE_ENV: "production", DATABASE_URL: url.href, APP_URL: origin,
        AUTH_SECRET: "synthetic-http-test-secret-32-characters-long", AI_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "synthetic-unused", EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "synthetic-unused",
        S3_ENDPOINT: "https://storage-http.test" }, stdio: "ignore",
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Auth HTTP test server exited during startup");
      try { if ((await request("/login")).status === 200) return; } catch { /* Wait for listener readiness. */ }
      await delay(50);
    }
    throw new Error("Auth HTTP test server readiness timed out");
  }, 45000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit"); child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 7000);
      try { await exit; } finally { clearTimeout(timer); }
    }
    if (connected) await db.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); }
    finally { await admin.end(); }
  }, 15000);

  it("creates a real account/session, returns safe JSON and permits authenticated project reads", async () => {
    const email = `http-${randomUUID()}@test.local`;
    const response = await send("signup", { name: "Asha", email, password: "Password123!", orgName: "HTTP test" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const cookie = cookieFrom(response);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, data: { user: { email, orgRole: "ADMIN" } } });
    expect(JSON.stringify(body)).not.toMatch(/password|token|expiresAt|\$2[aby]\$/);
    const session = await request("/api/auth/session", { headers: { cookie } });
    expect(session.status).toBe(200);
    expect((await session.json()).data.user).toEqual(body.data.user);
    expect((await (await request("/api/projects", { headers: { cookie } })).json()).data.projects).toEqual([]);
    expect((await db.query("SELECT org_role FROM users WHERE email=$1", [email])).rows[0].org_role).toBe("ADMIN");
    const duplicate = await send("signup", { name: "Other", email: email.toUpperCase(), password: "Password123!", orgName: "Duplicate" });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe("EMAIL_EXISTS");
    expect((await db.query("SELECT id FROM organizations WHERE name='Duplicate'")).rowCount).toBe(0);
    const logout = await send("logout", {}, cookie);
    expect(logout.status).toBe(200);
    expect(cookieFrom(logout)).toBe("__Host-sap_pm_session=");
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await request("/api/auth/session", { headers: { cookie } })).status).toBe(401);
    expect((await request("/api/projects", { headers: { cookie } })).status).toBe(401);
    expect((await send("logout", {}, cookie)).status).toBe(200);
  });

  it("logs in FIX-1, rejects cross-tenant IDs, and does not trust caller-supplied organization", async () => {
    const login = await send("login", { email: " LEAD@TEST.LOCAL ", password: "LocalSeed123!", orgId: fixtureId("other") });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login);
    const list = await request(`/api/projects?orgId=${fixtureId("other")}`, { headers: { cookie } });
    expect((await list.json()).data.projects).toEqual([expect.objectContaining({ name: "Acme O2C Transformation" })]);
    const allowed = await request(`/api/projects/${fixtureId("acme-project")}`, { headers: { cookie } });
    expect(allowed.status).toBe(200);
    const denied = await request(`/api/projects/${fixtureId("other-project")}`, { headers: { cookie } });
    expect(denied.status).toBe(404);
    expect((await denied.json()).error.code).toBe("PROJECT_NOT_FOUND");
    await send("logout", {}, cookie);
  });

  it("returns validation/origin/method errors in the API envelope without creating accounts", async () => {
    const before = (await db.query("SELECT count(*) FROM users")).rows[0].count;
    const invalid = await send("signup", { name: "Asha" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ success: false, error: { code: "MISSING_FIELD", field: "email" } });
    const csrf = await request("/api/auth/login", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(csrf.status).toBe(403);
    const method = await request("/api/auth/logout");
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
    expect((await method.json()).error.code).toBe("METHOD_NOT_ALLOWED");
    expect((await request("/api/auth/not-a-route")).status).toBe(404);
    expect((await request("/api/projects")).status).toBe(401);
    expect((await db.query("SELECT count(*) FROM users")).rows[0].count).toBe(before);
  });

  it("returns generic credentials failures then 429 with Retry-After on the sixth attempt", async () => {
    for (let i = 0; i < 6; i++) {
      const response = await send("login", { email: "owner@test.local", password: "incorrect" });
      expect(response.status).toBe(i === 5 ? 429 : 401);
      const body = await response.json();
      expect(body.error.code).toBe(i === 5 ? "RATE_LIMITED" : "INVALID_CREDENTIALS");
      expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
      expect(response.headers.get("set-cookie")).toBeNull();
      if (i === 5) expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });

  const createProject = (cookie: string, input: unknown = projectDetails, key: string = randomUUID(), headers: Record<string, string> = {}) =>
    request("/api/projects", { method: "POST", headers: { origin, cookie, "content-type": "application/json", "idempotency-key": key, ...headers }, body: JSON.stringify(input) });
  const newActor = async () => {
    const response = await send("signup", { name: "Project creator", email: `create-${randomUUID()}@test.local`, password: "Password123!", orgName: "Creation test" });
    expect(response.status).toBe(201);
    return { cookie: cookieFrom(response), user: (await response.json()).data.user as { id: string; orgId: string } };
  };
  const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM projects) projects,
    (SELECT count(*) FROM project_memberships) memberships,(SELECT count(*) FROM org_units) units,
    (SELECT count(*) FROM project_creation_requests) requests`)).rows[0];

  it("atomically creates an actor-owned draft and replays concurrent identical requests", async () => {
    const { cookie, user } = await newActor();
    const key = randomUUID();
    const input = { ...projectDetails, modules: ["sd", "MM", "SD"], orgUnits: [{ type: "PLANT", code: " p1 ", name: "Factory" }],
      orgId: fixtureId("other"), createdBy: fixtureId("owner"), setupStatus: "ACTIVE", isDemo: true };
    const responses = await Promise.all([key, key.toUpperCase(), key].map((key) => createProject(cookie, input, key)));
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const id = bodies[0].data.project.id;
    expect(bodies.every((body) => body.data.project.id === id)).toBe(true);
    expect((await db.query("SELECT org_id,created_by,setup_status,is_demo,starting_landscape,modules FROM projects WHERE id=$1", [id])).rows)
      .toEqual([{ org_id: user.orgId, created_by: user.id, setup_status: "DRAFT", is_demo: false, starting_landscape: "MIXED", modules: ["MM", "SD"] }]);
    expect((await db.query("SELECT user_id,project_role FROM project_memberships WHERE project_id=$1", [id])).rows).toEqual([{ user_id: user.id, project_role: "LEAD" }]);
    expect((await db.query("SELECT code,name FROM org_units WHERE project_id=$1", [id])).rows).toEqual([{ code: "P1", name: "Factory" }]);
    expect((await db.query("SELECT id FROM projects WHERE org_id=$1", [user.orgId])).rowCount).toBe(1);
    expect((await db.query("SELECT * FROM project_creation_requests WHERE org_id=$1", [user.orgId])).rowCount).toBe(1);
    const saved = await request(`/api/projects/${id}`, { headers: { cookie } });
    expect((await saved.json()).data.project).toMatchObject({ ...projectDetails, id, modules: ["MM", "SD"], orgUnits: [{ type: "PLANT", code: "P1", name: "Factory" }] });
    const before = await counts();
    const conflict = await createProject(cookie, { ...input, name: "Changed" }, key);
    expect(conflict.status).toBe(409); expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await counts()).toEqual(before);
    const other = await newActor();
    const separate = await createProject(other.cookie, input, key);
    expect(separate.status).toBe(201); expect((await separate.json()).data.project.id).not.toBe(id);
    expect((await request(`/api/projects/${id}`, { headers: { cookie: other.cookie } })).status).toBe(404);
  });

  it("rejects unauthorized, guest, forged-origin and invalid writes without partial rows", async () => {
    const { cookie, user } = await newActor();
    const before = await counts();
    expect((await createProject("", {})).status).toBe(401);
    expect((await createProject(cookie, projectDetails, randomUUID(), { origin: "https://evil.test" })).status).toBe(403);
    expect((await createProject(cookie, projectDetails, "invalid")).status).toBe(400);
    const short = await createProject(cookie, { ...projectDetails, problemStatement: "Too short" });
    expect(short.status).toBe(400); expect((await short.json()).error).toMatchObject({ code: "FIELD_TOO_SHORT", field: "problemStatement" });
    expect((await createProject(cookie, { ...projectDetails, problemStatement: "x".repeat(270000) })).status).toBe(413);
    await db.query("UPDATE users SET org_role='GUEST' WHERE id=$1", [user.id]);
    expect((await createProject(cookie)).status).toBe(403);
    expect(await counts()).toEqual(before);
  });

  it("accepts maximum-length Unicode problems and member creation", async () => {
    const { cookie, user } = await newActor();
    await db.query("UPDATE users SET org_role='MEMBER' WHERE id=$1", [user.id]);
    const problemStatement = "界".repeat(20000);
    const response = await createProject(cookie, { ...projectDetails, problemStatement });
    expect(response.status).toBe(201);
    const id = (await response.json()).data.project.id;
    expect((await db.query("SELECT problem_statement FROM projects WHERE id=$1", [id])).rows[0].problem_statement).toBe(problemStatement);
  });

  it("rolls back every row after an insert failure and permits retry with the same key", async () => {
    const { cookie } = await newActor();
    const key = randomUUID();
    const input = { ...projectDetails, orgUnits: [{ type: "PLANT", code: "FAIL", name: "Fault injection" }] };
    await db.query(`CREATE FUNCTION test_fail_unit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
      CREATE TRIGGER test_fail_unit BEFORE INSERT ON org_units FOR EACH ROW EXECUTE FUNCTION test_fail_unit()`);
    const before = await counts();
    try {
      expect((await createProject(cookie, input, key)).status).toBe(500);
      expect(await counts()).toEqual(before);
    } finally { await db.query("DROP TRIGGER test_fail_unit ON org_units; DROP FUNCTION test_fail_unit()"); }
    expect((await createProject(cookie, input, key)).status).toBe(201);
  });

  it("enforces actor and role restrictions in PostgreSQL itself", async () => {
    const { user } = await newActor();
    for (const [role, creator, org] of [["GUEST", user.id, user.orgId], ["ADMIN", fixtureId("lead"), user.orgId], ["ADMIN", user.id, fixtureId("other")]]) {
      await db.query("BEGIN");
      try {
        await db.query("SET LOCAL ROLE sap_pm_tenant");
        await db.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true),set_config('app.org_role',$3,true)", [user.orgId, user.id, role]);
        await expect(db.query(`INSERT INTO projects(id,org_id,name,client_name,problem_statement,target_product,starting_landscape,setup_status,created_by)
          VALUES($1,$2,'Intrusion','Client',$3,'S4HANA_CLOUD_PUBLIC','MIXED','DRAFT',$4)`, [randomUUID(), org, projectDetails.problemStatement, creator])).rejects.toMatchObject({ code: "42501" });
      } finally { await db.query("ROLLBACK"); }
    }
  });

  it("runs an analysis through production HTTP and the separate worker, then retries a persisted failure", async () => {
    const { cookie, user } = await newActor();
    const projectResponse = await createProject(cookie);
    const id = (await projectResponse.json()).data.project.id;
    const analyze = (headers: Record<string, string> = {}) => request(`/api/projects/${id}/analysis`, { method: "POST", headers: { cookie, origin, ...headers } });
    expect((await analyze({ cookie: "" })).status).toBe(401);
    expect((await analyze({ origin: "https://evil.test" })).status).toBe(403);
    const empty = await request(`/api/projects/${id}/analysis`, { headers: { cookie } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ success: true, data: { job: null, analysis: null, canAnalyze: true } });
    expect((await request(`/api/projects/${id}/analysis`)).status).toBe(401);
    expect((await request(`/api/projects/${id}/analysis`, { method: "DELETE", headers: { cookie } })).status).toBe(405);
    const submitted = await analyze();
    expect(submitted.status).toBe(202);
    const { jobId } = (await submitted.json()).data;
    expect((await db.query("SELECT request_id,requested_by FROM jobs WHERE id=$1", [jobId])).rows[0])
      .toEqual({ request_id: submitted.headers.get("x-request-id"), requested_by: user.id });
    const conflict = await analyze();
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toMatchObject({ code: "JOB_ALREADY_RUNNING", jobId });
    const job = (id: string, actorCookie = cookie) => request(`/api/jobs/${id}`, { headers: { cookie: actorCookie } });
    expect((await (await job(jobId)).json()).data).toMatchObject({ id: jobId, status: "QUEUED", result: null, error: null });
    expect((await job(jobId, "")).status).toBe(401);
    const foreign = await newActor();
    expect((await job(jobId, foreign.cookie)).status).toBe(404);
    expect((await request(`/api/jobs/${jobId}/retry`, { method: "POST", headers: { cookie: foreign.cookie, origin } })).status).toBe(404);
    expect((await request(`/api/projects/${id}/analysis`, { method: "POST", headers: { cookie: foreign.cookie, origin } })).status).toBe(404);
    expect((await job("not-a-uuid")).status).toBe(404);
    expect((await request(`/api/jobs/${jobId}/retry`, { method: "POST", headers: { cookie, origin } })).status).toBe(409);
    expect((await request(`/api/jobs/${jobId}/retry`, { headers: { cookie } })).status).toBe(405);
    const worker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
      env: { PATH: process.env.PATH, ...local, NODE_ENV: "test", DATABASE_URL: url.href, APP_URL: origin,
        AI_PROVIDER: "stub", AI_FAULT_INJECTION: "problem_analysis:timeout:once" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    worker.stdout?.on("data", (chunk) => { logs += chunk.toString(); });
    worker.stderr?.on("data", (chunk) => { logs += chunk.toString(); });
    const terminal = async (id: string) => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (worker.exitCode !== null) throw new Error("Analysis worker exited before completion");
        const response = await job(id);
        expect(response.status).toBe(200);
        const result = (await response.json()).data;
        if (["FAILED", "SUCCEEDED"].includes(result.status)) return result;
        await delay(50);
      }
      throw new Error("Analysis completion timed out");
    };
    try {
      expect(await terminal(jobId)).toMatchObject({ status: "FAILED", error: { code: "AI_TIMEOUT" }, result: null });
      expect((await db.query("SELECT setup_status FROM projects WHERE id=$1", [id])).rows[0].setup_status).toBe("DRAFT");
      expect((await request(`/api/jobs/${jobId}/retry`, { method: "POST", headers: { cookie } })).status).toBe(403);
      const retried = await request(`/api/jobs/${jobId}/retry`, { method: "POST", headers: { cookie, origin } });
      expect(retried.status).toBe(202);
      const nextId = (await retried.json()).data.jobId;
      expect(nextId).not.toBe(jobId);
      const result = await terminal(nextId);
      expect(result).toMatchObject({ status: "SUCCEEDED", error: null, result: { analysisId: expect.any(String) } });
      const analysis = (await db.query("SELECT payload FROM problem_analyses WHERE id=$1 AND job_id=$2", [result.result.analysisId, nextId])).rows[0];
      expect(analysis.payload.objectives.length).toBeGreaterThan(0);
      const review = await request(`/api/projects/${id}/analysis`, { headers: { cookie } });
      expect(await review.json()).toMatchObject({ success: true, data: { job: { id: nextId, status: "SUCCEEDED" }, analysis: analysis.payload } });
      expect((await request(`/api/projects/${id}/analysis`, { headers: { cookie: foreign.cookie } })).status).toBe(404);
      expect(analysis.payload.proposedProcesses.some((node: { level: number }) => node.level === 1)).toBe(true);
      expect((await db.query("SELECT setup_status FROM projects WHERE id=$1", [id])).rows[0].setup_status).toBe("SCOPE_PROPOSED");
      const head = await request(`/api/jobs/${nextId}`, { method: "HEAD", headers: { cookie } });
      expect(head.status).toBe(200); expect(await head.text()).toBe("");
      expect(head.headers.get("cache-control")).toContain("no-store");
      expect(logs).not.toContain(projectDetails.problemStatement);
      expect(logs).not.toContain("Worker failed");
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const exit = once(worker, "exit"); worker.kill("SIGTERM");
        const timer = setTimeout(() => worker.kill("SIGKILL"), 7000);
        try { await exit; } finally { clearTimeout(timer); }
      }
    }
  }, 35000);
});
