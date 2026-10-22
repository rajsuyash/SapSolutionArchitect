import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Typed failure; `code` is the only thing ever logged (no tokens, no emails). */
export class GoogleAuthError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export type GoogleConfig = { APP_URL: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string };
export type GoogleProfile = { sub: string; email: string; name?: string };
export type GoogleTransaction = { state: string; nonce: string; verifier: string };

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TRANSACTION_SECONDS = 10 * 60;
const FETCH_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_SECONDS = 60;
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const random = () => randomBytes(32).toString("base64url");

export function googleCredentials(config: GoogleConfig) {
  const clientId = config.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = config.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: `${new URL(config.APP_URL).origin}/api/auth/google/callback` };
}
export const googleEnabled = (config: GoogleConfig) => googleCredentials(config) !== null;

function requireCredentials(config: GoogleConfig) {
  const credentials = googleCredentials(config);
  if (!credentials) throw new GoogleAuthError("GOOGLE_NOT_CONFIGURED");
  return credentials;
}

/** Fresh state/nonce/PKCE verifier plus the Google authorization URL that carries them. */
export function beginGoogleAuth(config: GoogleConfig): { url: string; transaction: GoogleTransaction } {
  const { clientId, redirectUri } = requireCredentials(config);
  const transaction = { state: random(), nonce: random(), verifier: random() };
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: "openid email profile", state: transaction.state, nonce: transaction.nonce,
    code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url"),
    code_challenge_method: "S256", prompt: "select_account" }).toString();
  return { url: url.href, transaction };
}

/** One host-scoped transaction cookie; `value: null` clears it with identical scope. */
export function transactionCookie(value: string | null, appUrl: string) {
  const secure = new URL(appUrl).protocol === "https:";
  return { name: secure ? "__Secure-sap_pm_google" : "sap_pm_google", value: value ?? "",
    options: { httpOnly: true, secure, sameSite: "lax" as const, path: "/api/auth/google", maxAge: value ? TRANSACTION_SECONDS : 0 } };
}
export const serializeTransaction = (t: GoogleTransaction) => `${t.state}.${t.nonce}.${t.verifier}`;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Returns the stored transaction only when the callback's `state` matches it. */
export function verifyTransaction(cookieValue: string | null, state: string | null): GoogleTransaction {
  const parts = cookieValue?.split(".") ?? [];
  if (parts.length !== 3 || !parts.every((part) => RANDOM.test(part))) throw new GoogleAuthError("GOOGLE_STATE_MISSING");
  const [expected, nonce, verifier] = parts as [string, string, string];
  if (!state || !safeEqual(expected, state)) throw new GoogleAuthError("GOOGLE_STATE_MISMATCH");
  return { state: expected, nonce, verifier };
}

const tokenResponse = z.object({ id_token: z.string().min(1) });
export async function exchangeCode(config: GoogleConfig, code: string, verifier: string,
  fetchImpl: typeof fetch = fetch): Promise<string> {
  const { clientId, clientSecret, redirectUri } = requireCredentials(config);
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, { method: "POST", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
        grant_type: "authorization_code", code_verifier: verifier }) });
  } catch { throw new GoogleAuthError("GOOGLE_TOKEN_UNREACHABLE"); }
  if (!response.ok) throw new GoogleAuthError("GOOGLE_TOKEN_REJECTED");
  const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new GoogleAuthError("GOOGLE_TOKEN_MALFORMED");
  return parsed.data.id_token;
}

const claimsSchema = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]), aud: z.string(), exp: z.number(),
  nonce: z.string(), email_verified: z.literal(true), sub: z.string().min(1).max(255),
  email: z.email().max(254), name: z.string().optional(),
});

/** The id_token arrives straight from Google's token endpoint over TLS, so OIDC Core §3.1.3.7
 * allows trusting it without verifying its signature; claims are still fully validated. */
export function parseIdToken(idToken: string, expected: { clientId: string; nonce: string },
  nowSeconds = Date.now() / 1000): GoogleProfile {
  const segments = idToken.split(".");
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8")); }
  catch { throw new GoogleAuthError("GOOGLE_ID_TOKEN_MALFORMED"); }
  const claims = segments.length === 3 ? claimsSchema.safeParse(payload) : null;
  if (!claims?.success) throw new GoogleAuthError("GOOGLE_ID_TOKEN_INVALID");
  const { aud, exp, nonce, sub, email, name } = claims.data;
  if (!safeEqual(aud, expected.clientId)) throw new GoogleAuthError("GOOGLE_ID_TOKEN_AUDIENCE");
  if (exp + CLOCK_SKEW_SECONDS <= nowSeconds) throw new GoogleAuthError("GOOGLE_ID_TOKEN_EXPIRED");
  if (!safeEqual(nonce, expected.nonce)) throw new GoogleAuthError("GOOGLE_ID_TOKEN_NONCE");
  return { sub, email, ...(name ? { name } : {}) };
}
