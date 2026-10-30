import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError, applySessionCookie, assertSameOrigin, isAuthError, sessionCookie, type AuthService } from "./auth";
import type { createProjectRepository } from "./tenant";
import type { createJobService } from "./jobs";
import type { createDiscoveryRepository } from "./discovery";
import { handleConsultant, type ConsultantRuntime } from "./consultant-http";
import { handlePlatformAdmin, type PlatformAdminRuntime } from "./platform-admin-http";

export type HttpRuntime = { config: { APP_URL: string }; auth: AuthService;
  projects: ReturnType<typeof createProjectRepository>; jobs: ReturnType<typeof createJobService>;
  discovery?: ReturnType<typeof createDiscoveryRepository> } & Pick<ConsultantRuntime, "workspaces" | "consultantJobs"> & Pick<PlatformAdminRuntime, "platformAdmin">;
type LoadRuntime = () => HttpRuntime;
const MAX_BODY_BYTES = 8192;
const success = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });

const FIXED_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** What an unexpected error may say about itself in logs: its fixed code (e.g. INVALID_INTERVIEW_INPUT) or else its class name, never free text or a stack. */
const errorCode = (error: unknown) => error instanceof Error ? (FIXED_ERROR_CODE.test(error.message) ? error.message : error.name) : "UnknownThrown";

const MAX_LOGGED_ISSUES = 5;
/** Where a Zod failure happened (path and issue code of the first few issues), never the received value or the message, which can quote data. */
export const zodIssues = (error: unknown) => error instanceof ZodError
  ? { issues: error.issues.slice(0, MAX_LOGGED_ISSUES).map(issue => ({ path: issue.path.map(String).join("."), code: issue.code })) } : {};

async function boundary(work: (requestId: string) => Promise<NextResponse>): Promise<NextResponse> {
  const requestId = randomUUID();
  let response: NextResponse;
  try { response = await work(requestId); }
  catch (error) {
    const known = isAuthError(error);
    if (!known) console.error(JSON.stringify({ event: "api_error", requestId, code: errorCode(error), ...zodIssues(error) }));
    response = NextResponse.json({ success: false, error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "Something went wrong. Try again.",
      ...(known && error.field ? { field: error.field } : {}), requestId,
      ...(known && error.code === "JOB_ALREADY_RUNNING" && "jobId" in error ? { jobId: error.jobId } : {}),
    } }, { status: known ? error.status : 500 });
    if (known && error.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    if (error instanceof MethodError) response.headers.set("Allow", error.allow);
  }
  if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store"); // downloads set "private, no-store"
  response.headers.set("X-Request-Id", requestId);
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

/** A token is accepted only from the configured host-only cookie, never headers,
 * request bodies or query parameters. Ambiguous duplicate cookies fail closed. */
function requestToken(request: Request, appUrl: string): string | null {
  const name = sessionCookie(null, appUrl).name;
  const matches = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
}

async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const encoding = request.headers.get("content-encoding");
  if (contentType !== "application/json" || (encoding && encoding !== "identity")) {
    throw new AuthError("UNSUPPORTED_MEDIA_TYPE", 415, "Send an uncompressed JSON object");
  }
  const tooLarge = () => new AuthError("PAYLOAD_TOO_LARGE", 413, "Request body is too large");
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("INVALID_JSON", 400, "Send a JSON object");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthError("REQUEST_TIMEOUT", 408, "Request body timed out")), 5000);
    cancel = () => reject(new AuthError("INVALID_REQUEST", 400, "Request was interrupted"));
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
  });
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Not an object");
      return parsed as Record<string, unknown>;
    } catch { throw new AuthError("INVALID_JSON", 400, "Send a valid JSON object"); }
  };
  try { return await Promise.race([read(), interrupted]); }
  finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    // Cancellation must not delay an error response if the sender has stalled.
    void reader.cancel().catch(() => {});
  }
}

export function handleAuth(request: Request, action: string, load: LoadRuntime): Promise<NextResponse> {
  return boundary(async () => {
    if (!["signup", "login", "logout", "session"].includes(action)) throw new AuthError("NOT_FOUND", 404, "Route not found");
    const read = action === "session";
    if (read ? !["GET", "HEAD"].includes(request.method) : request.method !== "POST") {
      throw new MethodError(read ? "GET, HEAD" : "POST");
    }
    const { auth, config } = load();
    if (read) {
      const user = await auth.authenticate(requestToken(request, config.APP_URL));
      if (!user) throw new AuthError("UNAUTHENTICATED", 401, "Sign in to continue");
      return success({ user });
    }
    assertSameOrigin(request.headers, config.APP_URL);
    if (action === "logout") {
      await auth.logout(requestToken(request, config.APP_URL));
      const response = success({});
      const cookie = sessionCookie(null, config.APP_URL);
      response.cookies.set(cookie.name, cookie.value, cookie.options);
      return response;
    }
    const input = await readJson(request);
    const result = action === "signup" ? await auth.signup(input) : await auth.login(input);
    const response = success({ user: result.user }, action === "signup" ? 201 : 200);
    applySessionCookie(response, result, config.APP_URL);
    return response;
  });
}

class MethodError extends AuthError {
  constructor(public readonly allow: string) { super("METHOD_NOT_ALLOWED", 405, "Method not allowed"); }
}

export function handleProjects(request: Request, path: string[] | undefined, load: LoadRuntime): Promise<NextResponse> {
  return boundary(async (requestId) => {
    if (path?.[1] === "discovery" && (path.length === 2 || path.length === 3)) {
      const allowed = path.length === 3 ? "GET, HEAD, POST" : "GET, HEAD";
      if (!allowed.split(", ").includes(request.method)) throw new MethodError(allowed);
      const { discovery, auth, config } = load();
      if (!discovery) throw new Error("Discovery repository unavailable");
      const token = requestToken(request, config.APP_URL);
      const url = new URL(request.url);
      if (request.method === "POST") {
        if (!await auth.authenticate(token)) throw new AuthError("UNAUTHENTICATED", 401, "Sign in to continue");
        assertSameOrigin(request.headers, config.APP_URL);
        const input = await readJson(request, 256 * 1024);
        return success({ snapshot: await discovery.save(token, path[0]!, path[2]!, input, request.headers.get("idempotency-key")) }, 201);
      }
      if (path.length === 2) return success({ variants: await discovery.list(token, path[0]!) });
      const versions = url.searchParams.getAll("version");
      if (versions.length > 1 || (versions.length && !/^[1-9]\d{0,9}$/.test(versions[0]!))) {
        throw new AuthError("INVALID_DISCOVERY", 400, "Send a positive revision number", "version");
      }
      return success(await discovery.get(token, path[0]!, path[2]!, versions.length ? Number(versions[0]) : undefined));
    }
    if (path?.[1] === "consultant") {
      const runtime = load();
      return handleConsultant(request, path, runtime, { token: requestToken(request, runtime.config.APP_URL), readJson, success,
        methodNotAllowed: (allow) => new MethodError(allow) });
    }
    if (path?.length === 2 && path[1] === "analysis") {
      if (!["GET", "HEAD", "POST"].includes(request.method)) throw new MethodError("GET, HEAD, POST");
      const { jobs, config } = load();
      if (request.method !== "POST") return success(await jobs.latest(requestToken(request, config.APP_URL), path[0]!));
      assertSameOrigin(request.headers, config.APP_URL);
      return success(await jobs.enqueue(requestToken(request, config.APP_URL), path[0]!, requestId), 202);
    }
    if (path && path.length > 1) throw new AuthError("NOT_FOUND", 404, "Route not found");
    const create = request.method === "POST" && !path?.length;
    if (!create && !["GET", "HEAD"].includes(request.method)) throw new MethodError(path?.length ? "GET, HEAD" : "GET, HEAD, POST");
    const { projects, auth, config } = load();
    const token = requestToken(request, config.APP_URL);
    if (create) {
      const user = await auth.authenticate(token);
      if (!user) throw new AuthError("UNAUTHENTICATED", 401, "Sign in to continue");
      if (user.orgRole === "GUEST") throw new AuthError("FORBIDDEN", 403, "You cannot create projects");
      assertSameOrigin(request.headers, config.APP_URL);
      const input = await readJson(request, 256 * 1024);
      return success({ project: await projects.create(token, input, request.headers.get("idempotency-key")) }, 201);
    }
    return path?.[0] ? success({ project: await projects.get(token, path[0]) }) : success({ projects: await projects.list(token) });
  });
}

export function handleJobs(request: Request, path: string[] | undefined, load: LoadRuntime): Promise<NextResponse> {
  return boundary(async (requestId) => {
    if (!path?.length || path.length > 2 || (path.length === 2 && path[1] !== "retry")) throw notFound();
    const retry = path.length === 2;
    if (retry ? request.method !== "POST" : !["GET", "HEAD"].includes(request.method)) throw new MethodError(retry ? "POST" : "GET, HEAD");
    const { jobs, config } = load();
    const token = requestToken(request, config.APP_URL);
    if (retry) {
      assertSameOrigin(request.headers, config.APP_URL);
      return success(await jobs.retry(token, path[0]!, requestId), 202);
    }
    return success(await jobs.get(token, path[0]!));
  });
}

export function handleAdmin(request: Request, path: string[] | undefined, load: LoadRuntime): Promise<NextResponse> {
  return boundary(async () => {
    const runtime = load();
    return handlePlatformAdmin(request, path ?? [], runtime, { token: requestToken(request, runtime.config.APP_URL), readJson, success,
      methodNotAllowed: (allow) => new MethodError(allow) });
  });
}

function notFound() { return new AuthError("NOT_FOUND", 404, "Route not found"); }
