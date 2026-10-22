import { handleGoogle } from "../../../../../lib/google-http";
import { getRuntime } from "../../../../../lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ step: string }> }) {
  const { step } = await context.params;
  return handleGoogle(request, step, getRuntime);
}

export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
