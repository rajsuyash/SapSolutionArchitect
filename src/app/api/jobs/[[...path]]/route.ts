import { handleJobs } from "../../../../lib/auth-http";
import { getRuntime } from "../../../../lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  return handleJobs(request, path, getRuntime);
}

export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
