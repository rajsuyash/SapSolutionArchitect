import { getRuntime } from "../../../lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getRuntime().health();
  const healthy = Object.values(health).every((status) => status === "ok");
  // M0-AC2 explicitly specifies this body rather than the business API envelope.
  return Response.json(health, {
    status: healthy ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
