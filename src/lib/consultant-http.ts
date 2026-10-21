import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, assertSameOrigin, type AuthService } from "./auth";
import type { createDiscoveryWorkspaceRepository } from "./discovery-workspace";
import type { createConsultantJobs } from "./consultant-jobs";
import { buildReport } from "./consultant-report";
import { renderMarkdown, renderTraceabilityCsv, reportFilename } from "./consultant-report-export";

export type ConsultantRuntime = { config: { APP_URL: string }; auth: AuthService;
  workspaces?: ReturnType<typeof createDiscoveryWorkspaceRepository>;
  consultantJobs?: ReturnType<typeof createConsultantJobs> };
/** Helpers owned by the shared HTTP boundary (cookie parsing, bounded JSON, envelope). */
export type ConsultantTools = { token: string | null; readJson: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  success: (data: unknown, status?: number) => NextResponse; methodNotAllowed: (allow: string) => Error };

const MAX_BODY_BYTES = 256 * 1024;
const revision = z.number().int();
const bodies = {
  commands: z.strictObject({ expectedRevision: revision, command: z.unknown() }),
  messages: z.strictObject({ expectedRevision: revision, text: z.string() }),
  interview: z.strictObject({ expectedRevision: revision, messageId: z.string() }),
  "to-be": z.strictObject({ expectedRevision: revision }),
};
const READ_ACTIONS = new Set(["jobs"]);
/** Downloads below `to-be/:jobId/`. The filename is derived from project and revision, never from the request. */
const EXPORTS = { "report.md": { type: "text/markdown", extension: "md" }, "traceability.csv": { type: "text/csv", extension: "csv" } } as const;

function invalid(): never { throw new AuthError("INVALID_REQUEST", 400, "Check the request and try again"); }
function unavailable(): never { throw new Error("Consultant services unavailable"); }

/** One browser intent may need two server writes (message, then job). Derive the
 * second UUID from the first so a retried request replays both rather than duplicating. */
export function deriveKey(key: string | null, purpose: string): string | null {
  if (!z.uuid().safeParse(key).success) return key;
  const hex = createHash("sha256").update(`${key}:${purpose}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Presentable = { state: { sources: unknown } | null } & Record<string, unknown>;
/** Source documents are server evidence: clients edit by value and never need their text back. */
function present<T extends Presentable>(workspace: T) {
  return { ...workspace, state: workspace.state ? { ...workspace.state, sources: undefined } : null };
}

type JobView = { id: string; kind: string; status: string; inputRevision: number; error: unknown; result: unknown; metrics?: unknown };
/** Job lists carry a minimal summary only. The full result is served by the report route, never provider metrics. */
function presentJob(job: JobView) {
  const result = job.result as { status?: unknown; sourceRevision?: unknown; workspaceRevision?: unknown;
    evaluation?: { blockers?: unknown } } | null;
  const summary = !result ? null : job.kind === "TO_BE" ? {
    status: result.status === "BLOCKED" || result.status === "HUMAN_REVIEW_REQUIRED" ? result.status : null,
    sourceRevision: typeof result.sourceRevision === "number" ? result.sourceRevision : null,
    blockerCount: Array.isArray(result.evaluation?.blockers) ? result.evaluation.blockers.length : null,
  } : { workspaceRevision: typeof result.workspaceRevision === "number" ? result.workspaceRevision : null };
  return { id: job.id, kind: job.kind, status: job.status, inputRevision: job.inputRevision, error: job.error, result: summary };
}

/** Routes below `/api/projects/:projectId/consultant`. Authentication, same-origin and
 * body limits precede any service call; roles, tenancy and readiness are enforced by the repositories. */
export async function handleConsultant(request: Request, path: string[], runtime: ConsultantRuntime, tools: ConsultantTools) {
  const [projectId, , variant, action, jobId, file] = path;
  if (path.length > 4 && projectId && variant && jobId) return handleReport(request, { projectId, variant, action, jobId, file, length: path.length }, runtime, tools);
  if (path.length > 4 || !projectId) throw new AuthError("NOT_FOUND", 404, "Route not found");
  const write = action ? !READ_ACTIONS.has(action) : request.method === "POST";
  const allowed = !variant ? "GET, HEAD" : !action ? "GET, HEAD, POST" : write ? "POST" : "GET, HEAD";
  if (action && !(action in bodies) && !READ_ACTIONS.has(action)) throw new AuthError("NOT_FOUND", 404, "Route not found");
  if (!allowed.split(", ").includes(request.method)) throw tools.methodNotAllowed(allowed);
  const { workspaces, consultantJobs, auth, config } = runtime;
  if (!workspaces || !consultantJobs) unavailable();
  const { token } = tools;
  if (!write) {
    if (!variant) return tools.success({ variants: await workspaces.list(token, projectId) });
    if (action === "jobs") return tools.success({ jobs: (await consultantJobs.latest(token, projectId, variant)).jobs.map(presentJob) });
    return tools.success(present(await workspaces.get(token, projectId, variant)));
  }
  if (!await auth.authenticate(token)) throw new AuthError("UNAUTHENTICATED", 401, "Sign in to continue");
  assertSameOrigin(request.headers, config.APP_URL);
  const raw = await tools.readJson(request, MAX_BODY_BYTES);
  const key = request.headers.get("idempotency-key");
  if (!action) return tools.success(present(await workspaces.create(token, projectId, variant!, raw, key)), 201);
  const parsed = bodies[action as keyof typeof bodies].safeParse(raw);
  if (!parsed.success) invalid();
  const body = parsed.data as Record<string, unknown>;
  const expectedRevision = body.expectedRevision as number;
  if (action === "commands") {
    return tools.success(present(await workspaces.command(token, projectId, variant!, expectedRevision, key, body.command)));
  }
  if (action === "messages") {
    const saved = await workspaces.command(token, projectId, variant!, expectedRevision, key, { type: "SEND_MESSAGE", text: body.text });
    const messageId = saved.state.messages.findLast(message => message.role === "user")?.id;
    if (!messageId) throw new Error("Saved message missing");
    const job = await consultantJobs.enqueue(token, projectId, variant!,
      { kind: "INTERVIEW", expectedRevision: saved.state.revision, messageId }, deriveKey(key, "interview"));
    return tools.success({ workspace: present(saved), job: presentJob(job) }, 202);
  }
  const job = await consultantJobs.enqueue(token, projectId, variant!, action === "interview"
    ? { kind: "INTERVIEW", expectedRevision, messageId: body.messageId } : { kind: "TO_BE", expectedRevision }, key);
  return tools.success({ job: presentJob(job) }, 202);
}

type ReportRoute = { projectId: string; variant: string; action: string | undefined; jobId: string; file: string | undefined; length: number };
/** `GET .../:variant/to-be/:jobId` returns the validated result; `/report.md` and `/traceability.csv` download it. */
async function handleReport(request: Request, route: ReportRoute, runtime: ConsultantRuntime, tools: ConsultantTools) {
  const exported = route.file ? EXPORTS[route.file as keyof typeof EXPORTS] : undefined;
  if (route.action !== "to-be" || route.length > 6 || (route.file && !exported)) throw new AuthError("NOT_FOUND", 404, "Route not found");
  if (!["GET", "HEAD"].includes(request.method)) throw tools.methodNotAllowed("GET, HEAD");
  if (!runtime.consultantJobs) unavailable();
  const data = await runtime.consultantJobs.report(tools.token, route.projectId, route.variant, route.jobId);
  if (!exported) return tools.success({ report: data });
  const model = buildReport(data);
  return new NextResponse(exported.extension === "md" ? renderMarkdown(model) : renderTraceabilityCsv(model), { headers: {
    "Content-Type": `${exported.type}; charset=utf-8`,
    "Content-Disposition": `attachment; filename="${reportFilename(model, exported.extension)}"` } });
}
