import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AuthError } from "../src/lib/auth";
import { handleGoogle, type GoogleRuntime } from "../src/lib/google-http";
import { beginGoogleAuth, exchangeCode, GoogleAuthError, googleEnabled, parseIdToken, serializeTransaction,
  transactionCookie, verifyTransaction } from "../src/lib/google-oauth";
import { parseEnvironment } from "../src/lib/env";

const origin = "https://sap-google.test";
const config = { APP_URL: origin, GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "client-secret" };
const NOW = 1_800_000_000;
const expected = { clientId: config.GOOGLE_CLIENT_ID, nonce: "n".repeat(43) };
const claims = (patch: Record<string, unknown> = {}) => ({ iss: "https://accounts.google.com", aud: config.GOOGLE_CLIENT_ID,
  exp: NOW + 3600, nonce: expected.nonce, email_verified: true, sub: "1234567890", email: "gita@example.com", name: "Gita Rao", ...patch });
const idToken = (payload: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const failure = (code: string) => expect.objectContaining({ code });

describe("Google id_token validation", () => {
  it("accepts a valid token and returns only the profile", () => {
    expect(parseIdToken(idToken(claims()), expected, NOW)).toEqual({ sub: "1234567890", email: "gita@example.com", name: "Gita Rao" });
    expect(parseIdToken(idToken(claims({ iss: "accounts.google.com", name: undefined })), expected, NOW))
      .toEqual({ sub: "1234567890", email: "gita@example.com" });
    expect(parseIdToken(idToken(claims({ exp: NOW - 30 })), expected, NOW).sub).toBe("1234567890"); // inside the skew allowance
  });
  it.each([
    ["wrong audience", { aud: "someone-else" }, "GOOGLE_ID_TOKEN_AUDIENCE"],
    ["wrong issuer", { iss: "https://evil.example.com" }, "GOOGLE_ID_TOKEN_INVALID"],
    ["expired", { exp: NOW - 3600 }, "GOOGLE_ID_TOKEN_EXPIRED"],
    ["nonce mismatch", { nonce: "x".repeat(43) }, "GOOGLE_ID_TOKEN_NONCE"],
    ["unverified email", { email_verified: false }, "GOOGLE_ID_TOKEN_INVALID"],
    ["string email_verified", { email_verified: "true" }, "GOOGLE_ID_TOKEN_INVALID"],
    ["missing sub", { sub: undefined }, "GOOGLE_ID_TOKEN_INVALID"],
    ["empty sub", { sub: "" }, "GOOGLE_ID_TOKEN_INVALID"],
    ["invalid email", { email: "not-an-email" }, "GOOGLE_ID_TOKEN_INVALID"],
    ["missing nonce", { nonce: undefined }, "GOOGLE_ID_TOKEN_INVALID"],
  ])("rejects %s", (_name, patch, code) => {
    expect(() => parseIdToken(idToken(claims(patch)), expected, NOW)).toThrow(failure(code));
  });
  it.each(["", "a.b", "a.%%%.c", "a.bm90LWpzb24.c"])("rejects malformed token %j", (token) => {
    expect(() => parseIdToken(token, expected, NOW)).toThrow(GoogleAuthError);
  });
});

describe("Google transaction state", () => {
  const { url, transaction } = beginGoogleAuth(config);
  it("builds an authorization-code URL with PKCE S256, state, nonce and account chooser", () => {
    const params = new URL(url).searchParams;
    expect(new URL(url).origin + new URL(url).pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(params)).toEqual({ client_id: config.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/api/auth/google/callback`,
      response_type: "code", scope: "openid email profile", state: transaction.state, nonce: transaction.nonce,
      code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url"), code_challenge_method: "S256", prompt: "select_account" });
    expect(url).not.toContain(transaction.verifier);
    expect(new Set([transaction.state, transaction.nonce, transaction.verifier]).size).toBe(3);
  });
  it("accepts only the matching state and rejects missing, mismatched or malformed cookies", () => {
    const cookie = serializeTransaction(transaction);
    expect(verifyTransaction(cookie, transaction.state)).toEqual(transaction);
    expect(() => verifyTransaction(cookie, "a".repeat(43))).toThrow(failure("GOOGLE_STATE_MISMATCH"));
    expect(() => verifyTransaction(cookie, null)).toThrow(failure("GOOGLE_STATE_MISMATCH"));
    expect(() => verifyTransaction(cookie, transaction.state.slice(1))).toThrow(failure("GOOGLE_STATE_MISMATCH"));
    expect(() => verifyTransaction(null, transaction.state)).toThrow(failure("GOOGLE_STATE_MISSING"));
    expect(() => verifyTransaction("garbage", transaction.state)).toThrow(failure("GOOGLE_STATE_MISSING"));
  });
  it("scopes the cookie to the callback path, HttpOnly, Lax, ten minutes, Secure on https", () => {
    expect(transactionCookie("v", origin)).toMatchObject({ name: "__Secure-sap_pm_google", value: "v",
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/api/auth/google", maxAge: 600 } });
    expect(transactionCookie(null, "http://127.0.0.1:3017")).toMatchObject({ name: "sap_pm_google", value: "",
      options: { secure: false, maxAge: 0, path: "/api/auth/google" } });
  });
});

describe("Google configuration", () => {
  const base = { DATABASE_URL: "postgresql://u@127.0.0.1:5432/d", APP_URL: "http://127.0.0.1:3017", AUTH_SECRET: "local-dev-only-replace-before-deployment-32",
    AI_PROVIDER: "stub", EMAIL_PROVIDER: "stub", EMAIL_FROM: "a@example.test", S3_ENDPOINT: "http://127.0.0.1:19017", S3_REGION: "r",
    S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };
  it("requires both credentials or neither", () => {
    expect(googleEnabled(parseEnvironment(base))).toBe(false);
    expect(googleEnabled(parseEnvironment({ ...base, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }))).toBe(false);
    expect(googleEnabled(parseEnvironment({ ...base, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }))).toBe(true);
    expect(() => parseEnvironment({ ...base, GOOGLE_CLIENT_ID: "id" })).toThrow(/GOOGLE_CLIENT_SECRET/);
    expect(() => parseEnvironment({ ...base, GOOGLE_CLIENT_SECRET: "secret" })).toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe("token exchange", () => {
  it("posts the code, client secret, redirect URI and PKCE verifier to Google's token endpoint", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id_token: "t" }));
    expect(await exchangeCode(config, "auth-code", "v".repeat(43), fetchMock as unknown as typeof fetch)).toBe("t");
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://oauth2.googleapis.com/token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ code: "auth-code", client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET, redirect_uri: `${origin}/api/auth/google/callback`, grant_type: "authorization_code", code_verifier: "v".repeat(43) });
  });
  it.each([[Response.json({}, { status: 400 }), "GOOGLE_TOKEN_REJECTED"], [Response.json({ nope: 1 }), "GOOGLE_TOKEN_MALFORMED"],
    [new Response("not json"), "GOOGLE_TOKEN_MALFORMED"]])("fails closed on a bad token response", async (response, code) => {
    await expect(exchangeCode(config, "c", "v", (async () => response) as typeof fetch)).rejects.toThrow(failure(code));
  });
  it("maps network failure to a typed error", async () => {
    await expect(exchangeCode(config, "c", "v", (async () => { throw new Error("boom"); }) as typeof fetch))
      .rejects.toThrow(failure("GOOGLE_TOKEN_UNREACHABLE"));
  });
});

describe("Google routes", () => {
  const session = { user: { id: "u", orgId: "o", email: "gita@example.com", name: "Gita Rao", orgRole: "ADMIN" as const },
    token: "t".repeat(43), expiresAt: new Date(Date.now() + 604800000) };
  const runtime = (overrides: Partial<GoogleRuntime["config"]> = {}, googleSignIn = vi.fn(async () => session)) =>
    ({ config: { ...config, ...overrides }, auth: { googleSignIn } }) as unknown as GoogleRuntime & { auth: { googleSignIn: typeof googleSignIn } };
  const setCookies = (response: Response) => response.headers.getSetCookie();
  const txnName = "__Secure-sap_pm_google";
  const callbackRequest = (transaction: ReturnType<typeof beginGoogleAuth>["transaction"], query: string, cookie = serializeTransaction(transaction)) =>
    new Request(`${origin}/api/auth/google/callback?${query}`, { headers: { cookie: `${txnName}=${cookie}` } });

  it("start redirects to Google and sets the transaction cookie; 404 when not configured", async () => {
    const response = await handleGoogle(new Request(`${origin}/api/auth/google/start`), "start", () => runtime());
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    const cookie = setCookies(response).find((value) => value.startsWith(`${txnName}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/google/);
    expect(cookie).toContain(`${location.searchParams.get("state")}.${location.searchParams.get("nonce")}.`);
    const disabled = await handleGoogle(new Request(`${origin}/api/auth/google/start`), "start", () => runtime({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }));
    expect(disabled.status).toBe(404);
    expect(disabled.headers.get("location")).toBeNull();
  });

  it("callback signs in, sets the session cookie, clears the transaction cookie and redirects home", async () => {
    const { transaction } = beginGoogleAuth(config);
    const fetchMock = vi.fn(async () => Response.json({ id_token: idToken(claims({ nonce: transaction.nonce, exp: Math.floor(Date.now() / 1000) + 600 })) }));
    const rt = runtime();
    const response = await handleGoogle(callbackRequest(transaction, `state=${transaction.state}&code=abc`), "callback", () => rt, fetchMock as unknown as typeof fetch);
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
    expect(rt.auth.googleSignIn).toHaveBeenCalledWith({ sub: "1234567890", email: "gita@example.com", name: "Gita Rao" });
    const cookies = setCookies(response);
    expect(cookies.find((value) => value.startsWith(`__Host-sap_pm_session=${session.token}`))).toMatch(/HttpOnly/i);
    expect(cookies.find((value) => value.startsWith(`${txnName}=;`))).toMatch(/Max-Age=0/i);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    ["state mismatch", () => `state=${"z".repeat(43)}&code=abc`, "ok"],
    ["consent denied", (t: { state: string }) => `state=${t.state}&error=access_denied`, "ok"],
    ["missing code", (t: { state: string }) => `state=${t.state}`, "ok"],
    ["token endpoint rejects", (t: { state: string }) => `state=${t.state}&code=abc`, "reject"],
    ["nonce mismatch", (t: { state: string }) => `state=${t.state}&code=abc`, "nonce"],
    ["sign-in throws", (t: { state: string }) => `state=${t.state}&code=abc`, "signin"],
  ])("callback failure (%s) redirects to /login?error=google with no session and a cleared cookie", async (_name, query, mode) => {
    const { transaction } = beginGoogleAuth(config);
    const fetchMock = vi.fn(async () => mode === "reject" ? Response.json({}, { status: 400 })
      : Response.json({ id_token: idToken(claims({ nonce: mode === "nonce" ? "x".repeat(43) : transaction.nonce, exp: Math.floor(Date.now() / 1000) + 600 })) }));
    const rt = runtime({}, vi.fn(async () => { throw new AuthError("INTERNAL", 500, "db down"); }));
    if (mode !== "signin") rt.auth.googleSignIn.mockImplementation(async () => session);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleGoogle(callbackRequest(transaction, query(transaction)), "callback", () => rt, fetchMock as unknown as typeof fetch);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${origin}/login?error=google`);
      const cookies = setCookies(response);
      expect(cookies.some((value) => value.startsWith("__Host-sap_pm_session=") && !value.startsWith("__Host-sap_pm_session=;"))).toBe(false);
      expect(cookies.find((value) => value.startsWith(`${txnName}=;`))).toMatch(/Max-Age=0/i);
      if (mode !== "signin") expect(rt.auth.googleSignIn).not.toHaveBeenCalled();
      const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toMatch(/google_auth_error/);
      expect(logged).not.toMatch(/gita@example|abc|id_token|client-secret/);
    } finally { log.mockRestore(); }
  });

  it("callback without a transaction cookie fails without calling Google", async () => {
    const fetchMock = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleGoogle(new Request(`${origin}/api/auth/google/callback?state=a&code=b`), "callback", () => runtime(), fetchMock as unknown as typeof fetch);
      expect(response.headers.get("location")).toBe(`${origin}/login?error=google`);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("rejects unknown steps and non-GET methods", async () => {
    expect((await handleGoogle(new Request(`${origin}/api/auth/google/other`), "other", () => runtime())).status).toBe(404);
    const post = await handleGoogle(new Request(`${origin}/api/auth/google/start`, { method: "POST" }), "start", () => runtime());
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });
});
