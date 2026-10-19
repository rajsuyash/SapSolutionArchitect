import { handleAuth } from "../../../../lib/auth-http";
import { getRuntime } from "../../../../lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  return handleAuth(request, action, getRuntime);
}

export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
