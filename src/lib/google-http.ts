import { NextResponse } from "next/server";
import { applySessionCookie, isAuthError, type AuthService } from "./auth";
import { beginGoogleAuth, exchangeCode, GoogleAuthError, googleCredentials, parseIdToken, serializeTransaction,
  transactionCookie, verifyTransaction, type GoogleConfig } from "./google-oauth";

export type GoogleRuntime = { config: GoogleConfig; auth: Pick<AuthService, "googleSignIn"> };
const FAILURE_PATH = "/login?error=google";

function sealed(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
const redirect = (appUrl: string, path: string, status: 302 | 303) => NextResponse.redirect(new URL(path, appUrl), status);

/** Single cookie by exact name; duplicates are ambiguous and fail closed. */
function cookieValue(request: Request, name: string): string | null {
  const matches = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
}

function start(runtime: GoogleRuntime): NextResponse {
  const { config } = runtime;
  if (!googleCredentials(config)) {
    return sealed(NextResponse.json({ success: false, error: { code: "NOT_FOUND", message: "Route not found" } }, { status: 404 }));
  }
  const { url, transaction } = beginGoogleAuth(config);
  const response = redirect(config.APP_URL, url, 302);
  const cookie = transactionCookie(serializeTransaction(transaction), config.APP_URL);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return sealed(response);
}

async function callback(request: Request, runtime: GoogleRuntime, fetchImpl?: typeof fetch): Promise<NextResponse> {
  const { config, auth } = runtime;
  const cookie = transactionCookie(null, config.APP_URL);
  let response: NextResponse;
  try {
    const credentials = googleCredentials(config);
    if (!credentials) throw new GoogleAuthError("GOOGLE_NOT_CONFIGURED");
    const params = new URL(request.url).searchParams;
    // Verify state before looking at anything else Google (or an attacker) sent.
    const transaction = verifyTransaction(cookieValue(request, cookie.name), params.get("state"));
    const code = params.get("code");
    if (params.get("error") || !code) throw new GoogleAuthError("GOOGLE_CONSENT_DENIED");
    const idToken = await exchangeCode(config, code, transaction.verifier, fetchImpl);
    const profile = parseIdToken(idToken, { clientId: credentials.clientId, nonce: transaction.nonce });
    const session = await auth.googleSignIn(profile);
    response = redirect(config.APP_URL, "/", 303);
    applySessionCookie(response, session, config.APP_URL);
  } catch (error) {
    const code = error instanceof GoogleAuthError ? error.code : isAuthError(error) ? error.code : "INTERNAL_ERROR";
    console.error(JSON.stringify({ event: "google_auth_error", code }));
    response = redirect(config.APP_URL, FAILURE_PATH, 303);
  }
  response.cookies.set(cookie.name, cookie.value, cookie.options); // single-use, whatever the outcome
  return sealed(response);
}

export function handleGoogle(request: Request, step: string, load: () => GoogleRuntime, fetchImpl?: typeof fetch): Promise<NextResponse> {
  if ((step !== "start" && step !== "callback") || request.method !== "GET") {
    const known = step === "start" || step === "callback";
    const response = NextResponse.json({ success: false, error: known
      ? { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } : { code: "NOT_FOUND", message: "Route not found" } },
    { status: known ? 405 : 404 });
    if (known) response.headers.set("Allow", "GET");
    return Promise.resolve(sealed(response));
  }
  const runtime = load();
  return step === "start" ? Promise.resolve(start(runtime)) : callback(request, runtime, fetchImpl);
}
