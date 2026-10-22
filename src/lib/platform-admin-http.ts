import type { NextResponse } from "next/server";
import { AuthError, assertSameOrigin, type AuthService } from "./auth";
import { orgPatchSchema, type PlatformAdmin } from "./platform-admin";

export type PlatformAdminRuntime = { config: { APP_URL: string }; auth: AuthService; platformAdmin?: PlatformAdmin };
/** Helpers owned by the shared HTTP boundary (cookie parsing, bounded JSON, envelope). */
export type PlatformAdminTools = { token: string | null; readJson: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  success: (data: unknown, status?: number) => NextResponse; methodNotAllowed: (allow: string) => Error };

/** Routes below `/api/admin`. The platform-admin check precedes routing, method and body handling,
 * so non-admins see the same 404 for every path and method. */
export async function handlePlatformAdmin(request: Request, path: string[], runtime: PlatformAdminRuntime, tools: PlatformAdminTools) {
  const { platformAdmin, config } = runtime;
  if (!platformAdmin) throw new Error("Platform admin unavailable");
  const admin = await platformAdmin.requireAdmin(tools.token);
  if (path.length === 1 && path[0] === "overview") {
    if (!["GET", "HEAD"].includes(request.method)) throw tools.methodNotAllowed("GET, HEAD");
    return tools.success(await platformAdmin.overview(tools.token));
  }
  if (path.length === 2 && path[0] === "organizations") {
    if (request.method !== "PATCH") throw tools.methodNotAllowed("PATCH");
    assertSameOrigin(request.headers, config.APP_URL);
    const parsed = orgPatchSchema.safeParse(await tools.readJson(request, 2048));
    if (!parsed.success) throw new AuthError("INVALID_REQUEST", 400, "Check the request and try again", String(parsed.error.issues[0]?.path[0] ?? ""));
    return tools.success({ organization: await platformAdmin.updateOrganization(admin, path[1]!, parsed.data) });
  }
  throw new AuthError("NOT_FOUND", 404, "Route not found");
}
