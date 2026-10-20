import { createHmac, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

// Next instrumentation and route bundles can load separate copies of this class.
const AUTH_ERROR = Symbol.for("sap-pm.AuthError");
export class AuthError extends Error {
  readonly [AUTH_ERROR] = true;
  constructor(public readonly code: string, public readonly status: number,
    message: string, public readonly field?: string, public readonly retryAfter?: number) {
    super(message);
  }
}
export function isAuthError(value: unknown): value is AuthError {
  return typeof value === "object" && value !== null && AUTH_ERROR in value && value[AUTH_ERROR] === true;
}
export type SessionUser = { id: string; orgId: string; email: string; name: string; orgRole: "ADMIN" | "MEMBER" | "GUEST" };
const emailSchema = z.email().max(254);
const passwordSchema = z.string().min(10).regex(/[A-Za-z]/).regex(/[0-9]/)
  .refine((password) => !bcrypt.truncates(password));
const signupSchema = z.object({ name: z.string().min(1).max(120), email: emailSchema,
  password: passwordSchema, orgName: z.string().min(1).max(160) });
const SESSION_SECONDS = 7 * 24 * 60 * 60; // Absolute seven-day expiry; logout revokes immediately.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DUMMY_HASH = "$2b$12$n8cSIv7p.L0Xf.UoVSpu9OD.ra.Z2tRtoRj8b10Dqwn4Ja/E453hW";
const userColumns = 'u.id,u.org_id AS "orgId",u.email,u.name,u.org_role AS "orgRole"';

export function validateSignup(input: unknown) {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const cleaned: Record<string, unknown> = {};
  for (const key of ["name", "email", "password", "orgName"]) {
    const raw = record[key];
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
      throw new AuthError("MISSING_FIELD", 400, "This field is required", key);
    }
    cleaned[key] = typeof raw === "string" && key !== "password" ? raw.trim() : raw;
  }
  if (typeof cleaned.email === "string") cleaned.email = cleaned.email.toLowerCase();
  const parsed = signupSchema.safeParse(cleaned);
  if (!parsed.success) throw new AuthError("INVALID_FIELD", 400, "Check this field", String(parsed.error.issues[0]?.path[0]));
  return parsed.data;
}

function appOrigin(appUrl: string): URL {
  const url = new URL(appUrl);
  if (url.username || url.password || (url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Authentication requires HTTPS outside local development");
  }
  return url;
}

export function assertSameOrigin(headers: Headers, appUrl: string): void {
  if (headers.get("origin") !== appOrigin(appUrl).origin) throw new AuthError("FORBIDDEN", 403, "Request origin is not allowed");
}

export function sessionCookie(token: string | null, appUrl: string) {
  const secure = appOrigin(appUrl).protocol === "https:";
  if (token !== null && !TOKEN.test(token)) throw new Error("Invalid session token");
  return { name: secure ? "__Host-sap_pm_session" : "sap_pm_session", value: token ?? "",
    options: { httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: token ? SESSION_SECONDS : 0 } };
}

/** Server-internal transaction primitive. Failed rollback destroys the connection. */
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

/** Trusted auth bootstrap only. Never expose this pool or its queries to routes. */
export function createAuthService(pool: Pool, config: { secret: string; appUrl: string }) {
  if (config.secret.length < 32) throw new Error("AUTH_SECRET is too short");
  appOrigin(config.appUrl);
  const digest = (purpose: string, value: string) => createHmac("sha256", config.secret).update(`${purpose}:${value}`).digest("hex");
  const invalidCredentials = () => new AuthError("INVALID_CREDENTIALS", 401, "Email or password is incorrect");

  async function issueSession(client: PoolClient, user: SessionUser) {
    const token = randomBytes(32).toString("base64url");
    // Calendar days can be 23/25 hours across DST. Match the cookie's exact TTL.
    const { rows } = await client.query<{ expires_at: Date }>(`INSERT INTO auth.sessions(token_hash,org_id,user_id,created_at,expires_at)
      VALUES($1,$2,$3,statement_timestamp(),statement_timestamp()+$4*interval '1 second') RETURNING expires_at`,
    [digest("session", token), user.orgId, user.id, SESSION_SECONDS]);
    return { user, token, expiresAt: rows[0]!.expires_at };
  }

  async function signup(input: unknown) {
    const data = validateSignup(input);
    const passwordHash = await bcrypt.hash(data.password, 12);
    try {
      return await transaction(pool, async (client) => {
        const orgId = randomUUID();
        await client.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [orgId, data.orgName]);
        const { rows } = await client.query<SessionUser>(`INSERT INTO users AS u(id,org_id,email,name,password_hash,org_role)
          VALUES($1,$2,$3,$4,$5,'ADMIN') RETURNING ${userColumns}`,
        [randomUUID(), orgId, data.email, data.name, passwordHash]);
        return issueSession(client, rows[0]!);
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505" &&
        "constraint" in error && error.constraint === "users_email_key") {
        throw new AuthError("EMAIL_EXISTS", 409, "Couldn't create account — try signing in");
      }
      throw error;
    }
  }

  async function login(input: unknown) {
    const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    if (!emailSchema.safeParse(email).success || typeof data.password !== "string" || data.password.length > 1024) {
      throw invalidCredentials();
    }
    const password = data.password;
    const key = digest("login-email", email);
    const result = await transaction(pool, async (client) => {
      // Serialize this email across web processes before counting or checking a
      // password. The rolling window includes unknown accounts and normalized case.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`sap-pm-login:${key}`]);
      await client.query("DELETE FROM auth.login_failures WHERE email_hash=$1 AND failed_at <= clock_timestamp()-interval '10 minutes'", [key]);
      const failures = (await client.query<{ count: number; retry: number }>(`SELECT count(*)::int AS count,
        greatest(1,ceil(extract(epoch FROM min(failed_at)+interval '10 minutes'-clock_timestamp())))::int AS retry
        FROM auth.login_failures WHERE email_hash=$1`, [key])).rows[0]!;
      if (failures.count >= 5) return new AuthError("RATE_LIMITED", 429, "Try again later", undefined, failures.retry);
      const found = (await client.query<SessionUser & { password_hash: string }>(
        `SELECT ${userColumns},u.password_hash FROM users u WHERE email=$1`, [email])).rows[0];
      // Unknown accounts perform the same expensive bcrypt operation. Reject
      // overlong input explicitly: bcrypt otherwise accepts truncated passwords.
      const matches = await bcrypt.compare(password, found?.password_hash ?? DUMMY_HASH);
      if (!found || !matches || bcrypt.truncates(password)) {
        await client.query("INSERT INTO auth.login_failures(email_hash) VALUES($1)", [key]);
        return invalidCredentials(); // Return, then commit the failure; do not roll it back.
      }
      await client.query("DELETE FROM auth.login_failures WHERE email_hash=$1", [key]);
      const user: SessionUser = { id: found.id, orgId: found.orgId, email: found.email, name: found.name, orgRole: found.orgRole };
      return issueSession(client, user);
    });
    if (result instanceof AuthError) throw result;
    return result;
  }

  // Lock identity/session during a repository transaction so logout/role edits
  // cannot interleave halfway through an authorized operation.
  async function resolveSession(client: PoolClient, token: string | null): Promise<SessionUser | null> {
    if (!token || !TOKEN.test(token)) return null;
    const { rows } = await client.query<SessionUser>(`SELECT ${userColumns} FROM auth.sessions s
      JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id
      WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() FOR SHARE OF s,u`, [digest("session", token)]);
    return rows[0] ?? null;
  }
  const authenticate = (token: string | null) => transaction(pool, (client) => resolveSession(client, token));
  async function logout(token: string | null): Promise<void> {
    if (token && TOKEN.test(token)) await pool.query("DELETE FROM auth.sessions WHERE token_hash=$1", [digest("session", token)]);
  }
  return { signup, login, authenticate, logout, resolveSession };
}
export type AuthService = ReturnType<typeof createAuthService>;
