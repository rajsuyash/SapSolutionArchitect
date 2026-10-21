// Browser-side client for the consultant endpoints. Type-only imports: a runtime import of
// the workspace domain modules would pull their Node dependencies into the bundle.
import type { WorkspaceCommand, WorkspaceState } from "../lib/discovery-workspace-model";

export type WorkspaceView = Omit<WorkspaceState, "sources">;
export type Blocker = { code: string; fieldId?: string; detail: string };
export type Workspace = { state: WorkspaceView | null; canEdit: boolean; canConfirm: boolean;
  confirmedSnapshotId: string | null; readiness: { ready: boolean; blockers: Blocker[] } | null };
export type VariantSummary = { variantCode: string; variantName: string; revision: number; confirmedSnapshotId: string | null };
export type JobView = { id: string; kind: "INTERVIEW" | "TO_BE"; status: string; inputRevision: number;
  error: { code: string; message: string } | null;
  result: { status?: "BLOCKED" | "HUMAN_REVIEW_REQUIRED" | null; sourceRevision?: number | null; blockerCount?: number | null } | null };
export type Fact = WorkspaceView["facts"][number];
export type Command = WorkspaceCommand;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
export const isActive = (job: JobView | undefined) => job?.status === "QUEUED" || job?.status === "RUNNING";
/** Network failures, timeouts and 5xx leave the outcome unknown: the same intent must reuse its key. */
export const isUncertain = (error: unknown) => error instanceof ApiError ? error.status === 0 || error.status >= 500 : true;

export async function api<T>(path: string, init: { body?: unknown; key?: string } = {}): Promise<T> {
  const post = init.body !== undefined;
  let response: Response;
  try {
    response = await fetch(path, { method: post ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(20000),
      headers: post ? { "content-type": "application/json", "idempotency-key": init.key ?? crypto.randomUUID() } : undefined,
      body: post ? JSON.stringify(init.body) : undefined });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.", 0, "NETWORK");
  }
  if (response.status === 401) {
    window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    throw new ApiError("Sign in to continue", 401, "UNAUTHENTICATED");
  }
  let body: { success?: boolean; data?: T; error?: { code?: string; message?: string } } | null = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !body || body.success !== true) {
    throw new ApiError(typeof body?.error?.message === "string" ? body.error.message : "Something went wrong. Try again.",
      response.status, typeof body?.error?.code === "string" ? body.error.code : "UNKNOWN");
  }
  return body.data as T;
}

/** A process variant code is the URL-safe form of its display name. */
export function variantCodeFor(name: string, taken: string[]): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const base = cleaned ? (/^[A-Z]/.test(cleaned) ? cleaned : `V_${cleaned}`).slice(0, 36) : "MAIN";
  let code = base; let n = 2;
  while (taken.includes(code)) code = `${base}_${n++}`;
  return code;
}
