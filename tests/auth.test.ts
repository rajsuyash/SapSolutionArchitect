import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthService, assertSameOrigin, sessionCookie, validateSignup } from "../src/lib/auth";
import { createProjectRepository, withTenantSession } from "../src/lib/tenant";
import { fixtureId } from "../scripts/seed";

const run = promisify(execFile);
const options = { secret: "test-auth-secret-not-used-outside-tests-123", appUrl: "http://127.0.0.1:3017" };
const signup = (email = `fresh-${randomUUID()}@test.local`) => ({ name: "Asha Rao", email,
  password: "StrongPassword123!", orgName: "Example SI" });

describe("auth input and transport helpers", () => {
  it("normalizes identity fields without trimming passwords", () => {
    expect(validateSignup({ ...signup(" ASHA@EXAMPLE.COM "), password: " password123 ", name: " Asha " }))
      .toMatchObject({ name: "Asha", email: "asha@example.com", password: " password123 " });
  });
  it.each([
    [{ name: "" }, "MISSING_FIELD", "name"], [{ email: "bad" }, "INVALID_FIELD", "email"],
    [{ password: "short1" }, "INVALID_FIELD", "password"],
    [{ password: "withoutdigits" }, "INVALID_FIELD", "password"],
    [{ password: "12345678901" }, "INVALID_FIELD", "password"],
    [{ password: "é".repeat(40) + "1A" }, "INVALID_FIELD", "password"],
    [{ orgName: " " }, "MISSING_FIELD", "orgName"],
  ])("rejects invalid fields with the expected error", (patch, code, field) => {
    expect(() => validateSignup({ ...signup(), ...patch })).toThrow(expect.objectContaining({ code, field, status: 400 }));
  });
  it("rejects cross-origin and missing-origin writes", () => {
    expect(() => assertSameOrigin(new Headers({ origin: options.appUrl }), options.appUrl)).not.toThrow();
    for (const origin of [null, "null", "https://evil.test", "http://127.0.0.1:3017.evil.test"]) {
      expect(() => assertSameOrigin(new Headers(origin ? { origin } : {}), options.appUrl))
        .toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    }
  });
  it("uses secure host-only HTTP-only cookies and clears them with identical scope", () => {
    const token = "a".repeat(43);
    const cookie = sessionCookie(token, "https://sap.example.com");
    expect(cookie).toMatchObject({ name: "__Host-sap_pm_session", value: token,
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 604800 } });
    expect(sessionCookie(null, "https://sap.example.com")).toMatchObject({ name: cookie.name, value: "",
      options: { ...cookie.options, maxAge: 0 } });
    expect(sessionCookie(token, options.appUrl).options.secure).toBe(false);
    expect(() => sessionCookie(token, "http://public.example.com")).toThrow();
  });
});

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("auth services on isolated PostgreSQL", () => {
  const database = `sap_auth_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8")).DATABASE_URL!);
  const admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 8, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
  const tenantPool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 3000 });
  const connectionEnds: Promise<void>[] = [];
  const poolErrors: string[] = [];
  for (const service of [pool, tenantPool]) {
    service.on("connect", (client) => connectionEnds.push(new Promise<void>((accept) => client.once("end", accept))));
    service.on("error", () => poolErrors.push("Unexpected idle connection error"));
  }
  const auth = createAuthService(pool, options);
  const projects = createProjectRepository(tenantPool, auth);
  let created = false;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    await run("pnpm", ["db:seed"], { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
  }, 40000);
  afterAll(async () => {
    await Promise.all([pool.end(), tenantPool.end()]);
    // pg-pool end resolves when clients are removed; wait for socket termination
    // before dropping the DB or DROP FORCE can interrupt their graceful close.
    await Promise.all(connectionEnds);
    try {
      if (created) await admin.query(`DROP DATABASE ${database}`);
      expect(poolErrors).toEqual([]);
    }
    finally { await admin.end(); }
  });

  it("atomically creates the org, ADMIN and opaque session without exposing password hashes", async () => {
    const input = signup();
    const result = await auth.signup({ ...input, orgId: fixtureId("other"), orgRole: "GUEST" });
    expect(result.user).toMatchObject({ name: input.name, email: input.email, orgRole: "ADMIN" });
    expect(result.user.orgId).not.toBe(fixtureId("other"));
    expect(result.user).not.toHaveProperty("password_hash");
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await auth.authenticate(result.token)).toEqual(result.user);
    expect(await projects.list(result.token)).toEqual([]);
    const stored = (await pool.query("SELECT token_hash,expires_at,created_at FROM auth.sessions WHERE user_id=$1", [result.user.id])).rows[0];
    expect(stored.token_hash).not.toBe(result.token);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBe(604800000);
  });

  it("rolls back duplicate and invalid signup without orphan organizations", async () => {
    const before = (await pool.query("SELECT count(*) FROM organizations")).rows[0].count;
    await expect(auth.signup(signup(" LEAD@TEST.LOCAL "))).rejects.toMatchObject({ code: "EMAIL_EXISTS", status: 409 });
    await expect(auth.signup({ ...signup(), password: "bad" })).rejects.toMatchObject({ code: "INVALID_FIELD", status: 400 });
    expect((await pool.query("SELECT count(*) FROM organizations")).rows[0].count).toBe(before);
    const input = signup();
    const results = await Promise.allSettled([auth.signup(input), auth.signup(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await pool.query("SELECT count(*) FROM organizations")).rows[0].count).toBe(String(Number(before) + 1));
  });

  it("authenticates seeded bcrypt users, issues fresh tokens, expires and revokes sessions", async () => {
    const first = await auth.login({ email: " LEAD@TEST.LOCAL ", password: "LocalSeed123!" });
    const second = await auth.login({ email: "lead@test.local", password: "LocalSeed123!" });
    expect(first.token).not.toBe(second.token);
    expect(first.user.id).toBe(fixtureId("lead"));
    expect(await auth.authenticate(first.token + "x")).toBeNull();
    expect(await auth.authenticate("a".repeat(43))).toBeNull();
    await auth.logout(first.token);
    await auth.logout(first.token);
    expect(await auth.authenticate(first.token)).toBeNull();
    expect(await auth.authenticate(second.token)).toEqual(second.user);
    await pool.query("UPDATE auth.sessions SET expires_at=created_at WHERE user_id=$1", [first.user.id]);
    expect(await auth.authenticate(second.token)).toBeNull();
    const differentSecret = createAuthService(pool, { ...options, secret: "different-secret-long-enough-for-tests" });
    const current = await auth.login({ email: "lead@test.local", password: "LocalSeed123!" });
    expect(await differentSecret.authenticate(current.token)).toBeNull();
  });

  describe("Google sign-in", () => {
    const profile = (overrides: Record<string, string> = {}) => ({ sub: `sub-${randomUUID()}`, email: `g-${randomUUID()}@test.local`, name: "Gita Rao", ...overrides });
    const row = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0];

    it("creates a workspace, ADMIN user, 14-day trial and quota 10, then reuses the identity", async () => {
      const input = profile();
      const first = await auth.googleSignIn(input);
      expect(first.user).toMatchObject({ email: input.email, name: "Gita Rao", orgRole: "ADMIN" });
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await auth.authenticate(first.token)).toEqual(first.user);
      const org = await row(`SELECT name,daily_ai_job_quota AS quota,suspended_at,
        extract(epoch FROM trial_ends_at-clock_timestamp()) AS trial FROM organizations WHERE id=$1`, [first.user.orgId]);
      expect(org).toMatchObject({ name: "Gita Rao's workspace", quota: 10, suspended_at: null });
      expect(Math.abs(Number(org.trial) - 14 * 86400)).toBeLessThan(2 * 3600); // calendar days: DST may shift an hour
      const stored = await row("SELECT password_hash,last_login_at FROM users WHERE id=$1", [first.user.id]);
      expect(stored.password_hash).toBeNull();
      expect(stored.last_login_at).toBeInstanceOf(Date);
      const orgs = (await pool.query("SELECT count(*) FROM organizations")).rows[0].count;
      const again = await auth.googleSignIn({ ...input, email: `changed-${randomUUID()}@test.local` });
      expect(again.user.id).toBe(first.user.id);
      expect(again.token).not.toBe(first.token);
      expect((await pool.query("SELECT count(*) FROM organizations")).rows[0].count).toBe(orgs);
    });

    it("serializes concurrent first sign-ins for one subject into a single account", async () => {
      const input = profile();
      const results = await Promise.all([auth.googleSignIn(input), auth.googleSignIn(input), auth.googleSignIn(input)]);
      expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
      expect((await pool.query("SELECT count(*) FROM auth.oauth_identities WHERE subject=$1", [input.sub])).rows[0].count).toBe("1");
    });

    it("links to an existing password account by verified email without creating an organization", async () => {
      const orgs = (await pool.query("SELECT count(*) FROM organizations")).rows[0].count;
      const result = await auth.googleSignIn(profile({ sub: "sub-seeded-lead", email: "LEAD@test.local" }));
      expect(result.user.id).toBe(fixtureId("lead"));
      expect((await pool.query("SELECT count(*) FROM organizations")).rows[0].count).toBe(orgs);
      expect((await pool.query("SELECT user_id FROM auth.oauth_identities WHERE subject='sub-seeded-lead'")).rows)
        .toEqual([{ user_id: fixtureId("lead") }]);
      // The password still works and the account is not downgraded.
      await expect(auth.login({ email: "lead@test.local", password: "LocalSeed123!" })).resolves.toMatchObject({ user: { id: fixtureId("lead") } });
    });

    it("rejects every password for a passwordless account with the generic error", async () => {
      const input = profile();
      await auth.googleSignIn(input);
      for (const password of ["", "LocalSeed123!", "StrongPassword123!", "null", "undefined"]) {
        await expect(auth.login({ email: input.email, password })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401, message: "Email or password is incorrect" });
      }
    }, 15000);

    it("sets last_login_at on password login", async () => {
      await pool.query("UPDATE users SET last_login_at=NULL WHERE id=$1", [fixtureId("lead")]);
      await auth.login({ email: "lead@test.local", password: "LocalSeed123!" });
      expect((await row("SELECT last_login_at FROM users WHERE id=$1", [fixtureId("lead")])).last_login_at).toBeInstanceOf(Date);
    });

    it("keeps oauth identities and trial/quota columns away from the tenant role", async () => {
      const client = await pool.connect();
      try {
        for (const sql of ["SELECT * FROM auth.oauth_identities", "SELECT trial_ends_at FROM organizations",
          "SELECT daily_ai_job_quota FROM organizations", "SELECT suspended_at FROM organizations", "SELECT last_login_at FROM users"]) {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE sap_pm_tenant");
          await expect(client.query(sql), sql).rejects.toMatchObject({ code: "42501" });
          await client.query("ROLLBACK");
        }
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE sap_pm_tenant");
        await expect(client.query("SELECT id,name,created_at FROM organizations")).resolves.toBeDefined();
      } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
    });
  });

  it.each([false, true])("limits concurrent failures (existing account: %s) across instances and resets after ten minutes", async (existing) => {
    const email = existing ? "other@test.local" : `missing-${randomUUID()}@test.local`;
    const otherInstance = createAuthService(pool, options);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      (i % 2 ? auth : otherInstance).login({ email: i % 2 ? email.toUpperCase() : email, password: "incorrect" })));
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    expect(errors.filter((error) => error.code === "INVALID_CREDENTIALS")).toHaveLength(5);
    expect(errors.filter((error) => error.code === "RATE_LIMITED")).toHaveLength(1);
    expect(errors.find((error) => error.code === "RATE_LIMITED").retryAfter).toBeGreaterThan(0);
    await pool.query("UPDATE auth.login_failures SET failed_at=clock_timestamp()-interval '11 minutes'");
    await expect(auth.login({ email, password: "incorrect" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  }, 15000);

  it("clears prior failures on successful login and reads current roles on each request", async () => {
    const initial = Number((await pool.query("SELECT count(*) FROM auth.login_failures")).rows[0].count);
    for (let i = 0; i < 2; i++) await expect(auth.login({ email: "owner@test.local", password: "wrong" }))
      .rejects.toMatchObject({ status: 401, code: "INVALID_CREDENTIALS" });
    expect(Number((await pool.query("SELECT count(*) FROM auth.login_failures")).rows[0].count)).toBe(initial + 2);
    const result = await auth.login({ email: "owner@test.local", password: "LocalSeed123!" });
    const before = (await pool.query("SELECT count(*) FROM auth.login_failures")).rows[0].count;
    expect(Number(before)).toBe(initial);
    await auth.login({ email: "owner@test.local", password: "LocalSeed123!" });
    expect((await pool.query("SELECT count(*) FROM auth.login_failures")).rows[0].count).toBe(before);
    await pool.query("UPDATE users SET org_role='MEMBER' WHERE id=$1", [result.user.id]);
    expect(await auth.authenticate(result.token)).toMatchObject({ orgRole: "MEMBER" });
    await pool.query("UPDATE users SET org_role='GUEST' WHERE id=$1", [result.user.id]);
  });

  it("scopes repository reads by session, rejects foreign projects and hides non-member projects from guests", async () => {
    const lead = await auth.login({ email: "lead@test.local", password: "LocalSeed123!" });
    const owner = await auth.login({ email: "owner@test.local", password: "LocalSeed123!" });
    const hidden = randomUUID();
    await pool.query(`INSERT INTO projects SELECT $1,org_id,'Hidden from guest',client_name,problem_statement,
      target_product,starting_landscape,modules,setup_status,is_demo,created_by,created_at FROM projects WHERE id=$2`,
    [hidden, fixtureId("acme-project")]);
    expect(await projects.list(lead.token)).toHaveLength(2);
    expect(await projects.list(owner.token)).toHaveLength(1);
    for (const id of [hidden, fixtureId("other-project"), "not-an-id"]) {
      await expect(projects.get(owner.token, id)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
    }
    await expect(projects.list(null)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(await projects.get(lead.token, fixtureId("acme-project"))).toMatchObject({ name: "Acme O2C Transformation" });
  });

  it("uses a restricted role with RLS and restores connection state after success and rollback", async () => {
    const lead = await auth.login({ email: "lead@test.local", password: "LocalSeed123!" });
    await withTenantSession(tenantPool, auth, lead.token, async ({ client, user }) => {
      const role = (await client.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
      expect(role).toEqual({ current_user: "sap_pm_tenant", rolsuper: false, rolbypassrls: false });
      const rows = (await client.query("SELECT org_id FROM projects")).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.org_id === user.orgId)).toBe(true);
    });
    await expect(withTenantSession(tenantPool, auth, lead.token, async ({ client }) => {
      await client.query("SELECT * FROM auth.sessions");
    })).rejects.toMatchObject({ code: "42501" });
    await expect(withTenantSession(tenantPool, auth, lead.token, async ({ client }) => {
      await client.query("SELECT password_hash FROM users");
    })).rejects.toMatchObject({ code: "42501" });
    const reset = (await tenantPool.query("SELECT current_user=session_user AS reset, nullif(current_setting('app.org_id',true),'') AS org")).rows[0];
    expect(reset).toEqual({ reset: true, org: null });
    const other = await auth.login({ email: "other@test.local", password: "LocalSeed123!" });
    expect(await projects.list(other.token)).toHaveLength(1);
    expect((await projects.list(other.token))[0]?.id).toBe(fixtureId("other-project"));
  });
});
