import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import bcrypt from "bcryptjs";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthService, sessionCookie } from "../src/lib/auth";
import { handleAdmin, type HttpRuntime } from "../src/lib/auth-http";
import { parseEnvironment } from "../src/lib/env";
import { createPlatformAdmin } from "../src/lib/platform-admin";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const envFor = (emails: string | undefined, extra: Record<string, string> = {}) =>
  parseEnvironment({ ...local, NODE_ENV: "test", AI_PROVIDER: "stub", PLATFORM_ADMIN_EMAILS: emails, ...extra });

describe("platform admin configuration", () => {
  it("lowercases and trims the admin list; empty or unset means nobody", () => {
    expect(envFor(" Admin@Test.LOCAL , ,other@x.io ").PLATFORM_ADMIN_EMAILS).toEqual(["admin@test.local", "other@x.io"]);
    expect(envFor("").PLATFORM_ADMIN_EMAILS).toEqual([]);
    expect(envFor(undefined).PLATFORM_ADMIN_EMAILS).toEqual([]);
  });
  it("defaults prices to Claude Sonnet 5.5 and treats blank as default, not zero", () => {
    expect(envFor("")).toMatchObject({ AI_PRICE_INPUT_USD_PER_MTOK: 2, AI_PRICE_OUTPUT_USD_PER_MTOK: 10 });
    expect(envFor("", { AI_PRICE_INPUT_USD_PER_MTOK: "", AI_PRICE_OUTPUT_USD_PER_MTOK: "  " }))
      .toMatchObject({ AI_PRICE_INPUT_USD_PER_MTOK: 2, AI_PRICE_OUTPUT_USD_PER_MTOK: 10 });
    expect(envFor("", { AI_PRICE_INPUT_USD_PER_MTOK: "3.5", AI_PRICE_OUTPUT_USD_PER_MTOK: "15" }))
      .toMatchObject({ AI_PRICE_INPUT_USD_PER_MTOK: 3.5, AI_PRICE_OUTPUT_USD_PER_MTOK: 15 });
    expect(() => envFor("", { AI_PRICE_INPUT_USD_PER_MTOK: "-1" })).toThrow("AI_PRICE_INPUT_USD_PER_MTOK");
  });
});

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("platform admin HTTP boundary", () => {
  const database = `sap_padmin_http_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 6, statement_timeout: 10000 });
  pool.on("error", () => {});
  const origin = "http://127.0.0.1:3017";
  const auth = createAuthService(pool, { secret: "synthetic-platform-admin-secret-for-tests-only", appUrl: origin });
  const cookie = sessionCookie(null, origin).name;
  const runtimeFor = (emails: string): HttpRuntime => ({ config: { APP_URL: origin }, auth,
    platformAdmin: createPlatformAdmin(pool, auth, envFor(emails)) } as unknown as HttpRuntime);
  const runtime = runtimeFor("Admin@Test.Local");
  const password = "Password123!";
  let created = false;
  let adminToken: string, outsiderToken: string, alpha: string, beta: string;

  type Options = { token?: string | null; body?: unknown; origin?: string | null; raw?: string; contentType?: string; runtime?: HttpRuntime };
  async function call(method: string, path: string, options: Options = {}) {
    const headers: Record<string, string> = {};
    if (options.token) headers.cookie = `${cookie}=${options.token}`;
    if (method !== "GET" && options.origin !== null) headers.origin = options.origin ?? origin;
    const hasBody = options.body !== undefined || options.raw !== undefined;
    if (hasBody) headers["content-type"] = options.contentType ?? "application/json";
    const request = new Request(`${origin}/api/admin/${path}`, { method, headers, body: hasBody ? options.raw ?? JSON.stringify(options.body) : undefined });
    const response = await handleAdmin(request, path.split("/"), () => options.runtime ?? runtime);
    const text = await response.text();
    return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  }
  const org = async (id: string) => (await pool.query("SELECT trial_ends_at,daily_ai_job_quota,suspended_at FROM organizations WHERE id=$1", [id])).rows[0];

  async function addUser(orgId: string, email: string, { hash, google }: { hash: boolean; google: boolean }) {
    const id = randomUUID();
    await pool.query("INSERT INTO users(id,org_id,email,name,org_role,password_hash,last_login_at) VALUES($1,$2,$3,'Member','MEMBER',$4,$5)",
      [id, orgId, email, hash ? await bcrypt.hash(password, 4) : null, "2026-10-01T10:00:00Z"]);
    if (google) await pool.query("INSERT INTO auth.oauth_identities(provider,subject,user_id,email) VALUES('google',$1,$2,$3)", [`sub-${id}`, id, email]);
    return id;
  }
  async function addProject(orgId: string, userId: string) {
    const id = randomUUID();
    await pool.query(`INSERT INTO projects(id,org_id,name,client_name,target_product,starting_landscape,setup_status,created_by)
      VALUES($1,$2,'P','C','S4HANA_CLOUD_PRIVATE','MIXED','DRAFT',$3)`, [id, orgId, userId]);
    return id;
  }
  const job = (orgId: string, projectId: string, userId: string, status: "SUCCEEDED" | "FAILED", ago: string, metrics: object | null) =>
    pool.query(`INSERT INTO jobs(id,org_id,project_id,kind,requested_by,request_id,status,metrics,created_at,finished_at)
      VALUES($1,$2,$3,'PROBLEM_ANALYSIS',$4,$5,$6,$7,now()-$8::interval,now())`,
    [randomUUID(), orgId, projectId, userId, randomUUID(), status, metrics, ago]);
  async function consultantJob(orgId: string, projectId: string, userId: string, metrics: object) {
    const hash = "a".repeat(64);
    await pool.query(`INSERT INTO discovery_workspace_revisions(id,org_id,project_id,variant_code,revision,operation,state,request_key,request_hash,created_by)
      VALUES($1,$2,$3,'V1',1,'CREATE','{"confirmation":null}',$4,$5,$6)`, [randomUUID(), orgId, projectId, randomUUID(), hash, userId]);
    await pool.query(`INSERT INTO consultant_jobs(id,org_id,project_id,variant_code,kind,input_revision,message_id,requested_by,request_key,request_hash,
      status,result,metrics,finished_at) VALUES($1,$2,$3,'V1','INTERVIEW',1,'m1',$4,$5,$6,'SUCCEEDED','{"ok":true}',$7,now())`,
    [randomUUID(), orgId, projectId, userId, randomUUID(), hash, metrics]);
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/seed.ts", "--migrate-only"],
      { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
    const a = await auth.signup({ name: "Operator", email: "admin@test.local", password, orgName: "Alpha" });
    const b = await auth.signup({ name: "Outsider", email: "outsider@test.local", password, orgName: "Beta" });
    adminToken = a.token; outsiderToken = b.token; alpha = a.user.orgId; beta = b.user.orgId;
    await addUser(alpha, "g@test.local", { hash: false, google: true });
    await addUser(alpha, "both@test.local", { hash: true, google: true });
    const p1 = await addProject(alpha, a.user.id);
    await addProject(alpha, a.user.id);
    const p3 = await addProject(beta, b.user.id);
    await job(alpha, p1, a.user.id, "SUCCEEDED", "0 seconds", { inputTokens: 1_000_000, outputTokens: 100_000 });
    await job(alpha, p1, a.user.id, "FAILED", "0 seconds", null);
    await job(alpha, p1, a.user.id, "SUCCEEDED", "5 days", { inputTokens: 2_000_000, outputTokens: 0 });
    await job(alpha, p1, a.user.id, "SUCCEEDED", "40 days", { inputTokens: 9_000_000, outputTokens: 9_000_000 });
    await consultantJob(alpha, p1, a.user.id, { inputTokens: 500_000, outputTokens: 50_000 });
    await job(beta, p3, b.user.id, "SUCCEEDED", "1 hour", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  }, 60000);

  afterAll(async () => {
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }, 15000);

  describe("authorization", () => {
    it("answers unauthenticated callers with 401 and signed-in non-admins with 404 for every route and method", async () => {
      expect((await call("GET", "overview")).status).toBe(401);
      expect((await call("PATCH", `organizations/${beta}`, { body: { suspended: true } })).status).toBe(401);
      const probes: [string, string, Options?][] = [["GET", "overview"], ["PATCH", `organizations/${beta}`, { body: { suspended: true } }],
        ["PATCH", `organizations/${beta}`, { body: { suspended: true }, origin: "https://evil.example" }],
        ["POST", "overview", { body: {} }], ["GET", "nothing/here"], ["DELETE", `organizations/${beta}`]];
      for (const [method, path, options] of probes) {
        const result = await call(method, path, { ...options, token: outsiderToken });
        expect([method, path, result.status, result.body.error?.code]).toEqual([method, path, 404, "NOT_FOUND"]);
      }
      expect((await org(beta)).suspended_at).toBeNull();
    });
    it("admits the configured admin, matched case-insensitively, and nobody when the list is empty", async () => {
      expect((await call("GET", "overview", { token: adminToken })).status).toBe(200);
      expect(runtime.platformAdmin!.isAdminEmail("ADMIN@test.LOCAL")).toBe(true);
      expect((await call("GET", "overview", { token: adminToken, runtime: runtimeFor("") })).status).toBe(404);
      expect((await call("GET", "overview", { token: adminToken, runtime: runtimeFor(" , ") })).status).toBe(404);
      expect((await call("GET", "overview", { token: adminToken, runtime: runtimeFor("someone-else@test.local") })).status).toBe(404);
    });
    it("rejects wrong methods and unknown routes for the admin", async () => {
      expect((await call("POST", "overview", { token: adminToken, body: {} })).status).toBe(405);
      expect((await call("GET", `organizations/${beta}`, { token: adminToken })).status).toBe(405);
      expect((await call("GET", "nothing", { token: adminToken })).status).toBe(404);
    });
  });

  describe("overview", () => {
    it("aggregates both job tables, 24h vs 30 days, tokens, cost, users and projects per workspace", async () => {
      const { status, body } = await call("GET", "overview", { token: adminToken });
      expect(status).toBe(200);
      const { totals, organizations, users, pricing } = body.data;
      expect(pricing).toEqual({ inputUsdPerMTok: 2, outputUsdPerMTok: 10 });
      const byName = Object.fromEntries(organizations.map((o: { name: string }) => [o.name, o]));
      expect(byName.Alpha).toMatchObject({ id: alpha, userCount: 3, projectCount: 2, jobsToday: 3, jobs30d: 4,
        inputTokens30d: 3_500_000, outputTokens30d: 150_000, dailyAiJobQuota: 10, suspendedAt: null });
      expect(byName.Alpha.estimatedCostUsd30d).toBeCloseTo(8.5, 6); // 3.5 * $2 + 0.15 * $10
      expect(byName.Beta).toMatchObject({ id: beta, userCount: 1, projectCount: 1, jobsToday: 1, jobs30d: 1,
        inputTokens30d: 1_000_000, outputTokens30d: 1_000_000 });
      expect(byName.Beta.estimatedCostUsd30d).toBeCloseTo(12, 6);
      expect(totals.workspaces).toBe(2);
      expect(totals.users).toBe(4);
      expect(totals.jobsToday).toBe(4);
      expect(totals.estimatedCostUsd30d).toBeCloseTo(20.5, 6);
      expect(new Date(byName.Alpha.lastLoginAt).toISOString()).toBe("2026-10-01T10:00:00.000Z"); // max over the org's users
      const signIn = Object.fromEntries(users.map((u: { email: string; signIn: string }) => [u.email, u.signIn]));
      expect(signIn).toEqual({ "admin@test.local": "password", "outsider@test.local": "password", "g@test.local": "google", "both@test.local": "both" });
      expect(users.find((u: { email: string }) => u.email === "g@test.local")).toMatchObject({ orgName: "Alpha", orgRole: "MEMBER", name: "Member" });
    });
    it("uses the configured prices", async () => {
      const priced = { ...runtime, platformAdmin: createPlatformAdmin(pool, auth, envFor("admin@test.local", {
        AI_PRICE_INPUT_USD_PER_MTOK: "1", AI_PRICE_OUTPUT_USD_PER_MTOK: "0" })) } as HttpRuntime;
      const { body } = await call("GET", "overview", { token: adminToken, runtime: priced });
      expect(body.data.totals.estimatedCostUsd30d).toBeCloseTo(4.5, 6); // Alpha 3.5M in + Beta 1M in, outputs free
    });
  });

  describe("PATCH /organizations/:id", () => {
    const patch = (id: string, body: unknown, options: Options = {}) => call("PATCH", `organizations/${id}`, { token: adminToken, body, ...options });

    it("persists each allowed field, any subset, and echoes the stored values", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        expect((await org(beta)).trial_ends_at).not.toBeNull(); // signup default: 14-day trial
        const first = await patch(beta, { trialEndsAt: null });
        expect(first.status).toBe(200);
        expect(first.body.data.organization).toEqual({ id: beta, trialEndsAt: null, dailyAiJobQuota: 10, suspendedAt: null });
        expect(await org(beta)).toMatchObject({ trial_ends_at: null, daily_ai_job_quota: 10, suspended_at: null });
        const second = await patch(beta, { trialEndsAt: "2030-03-04", dailyAiJobQuota: 250, suspended: true });
        expect(second.body.data.organization).toMatchObject({ trialEndsAt: "2030-03-04T23:59:59.999Z", dailyAiJobQuota: 250 });
        const stored = await org(beta);
        expect(stored.trial_ends_at.toISOString()).toBe("2030-03-04T23:59:59.999Z");
        expect(stored).toMatchObject({ daily_ai_job_quota: 250 });
        expect(stored.suspended_at).toBeInstanceOf(Date);
        await patch(beta, { trialEndsAt: "2031-01-01T00:00:00Z" });
        expect((await org(beta)).trial_ends_at.toISOString()).toBe("2031-01-01T00:00:00.000Z");
        expect((await patch(beta, { suspended: false })).status).toBe(200);
        expect(await org(beta)).toMatchObject({ daily_ai_job_quota: 250, suspended_at: null });
        // Audit: one structured line per change, with org id and values, without email or token.
        const lines = info.mock.calls.map(([line]) => JSON.parse(String(line))).filter((line) => line.event === "platform_admin_change");
        expect(lines).toHaveLength(4);
        expect(lines[1]).toMatchObject({ orgId: beta, changes: { trialEndsAt: "2030-03-04T23:59:59.999Z", dailyAiJobQuota: 250, suspended: true } });
        expect(lines[1].admin).toMatch(/^[0-9a-f]{16}$/);
        expect(JSON.stringify(lines)).not.toContain("admin@test.local");
        expect(JSON.stringify(lines)).not.toContain(adminToken);
      } finally { info.mockRestore(); }
    });
    it("rejects unknown fields, bad bounds, wrong types, bad dates and empty bodies without writing", async () => {
      const before = await org(alpha);
      const bad: unknown[] = [{ name: "Renamed" }, { suspended: true, id: alpha }, { dailyAiJobQuota: 0 }, { dailyAiJobQuota: 10001 },
        { dailyAiJobQuota: 1.5 }, { dailyAiJobQuota: "5" }, { dailyAiJobQuota: null }, { suspended: "yes" }, { suspended: null },
        { trialEndsAt: "tomorrow" }, { trialEndsAt: 5 }, { trialEndsAt: "2030-02-31" }, {}];
      for (const body of bad) {
        const result = await patch(alpha, body);
        expect([JSON.stringify(body), result.status, result.body.error?.code]).toEqual([JSON.stringify(body), 400, "INVALID_REQUEST"]);
      }
      expect(await org(alpha)).toEqual(before);
      for (const quota of [1, 10000]) expect((await patch(alpha, { dailyAiJobQuota: quota })).status).toBe(200);
    });
    it("rejects bad content types and unknown organizations", async () => {
      expect((await patch(alpha, undefined, { raw: "suspended=true", contentType: "text/plain" })).status).toBe(415);
      expect((await patch(randomUUID(), { suspended: true })).status).toBe(404);
      expect((await patch("not-a-uuid", { suspended: true })).status).toBe(404);
    });
    it("requires the same origin and changes nothing otherwise", async () => {
      const before = await org(alpha);
      for (const bad of ["https://evil.example", "http://127.0.0.1:9999", null]) {
        const result = await patch(alpha, { suspended: true, dailyAiJobQuota: 77 }, { origin: bad });
        expect([bad, result.status, result.body.error?.code]).toEqual([bad, 403, "FORBIDDEN"]);
      }
      expect(await org(alpha)).toEqual(before);
    });
  });
});
