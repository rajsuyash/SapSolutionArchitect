import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

// Optional invitation gate for a private, cost-controlled demo. Application
// sessions and tenant authorization remain enforced independently in every API.
export function proxy(request: NextRequest) {
  const password = process.env.DEMO_ACCESS_PASSWORD;
  if (!password || request.nextUrl.pathname === "/api/health") return NextResponse.next();
  const expected = `Basic ${Buffer.from(`demo:${password}`).toString("base64")}`;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (timingSafeEqual(hash(request.headers.get("authorization") ?? ""), hash(expected))) {
    return NextResponse.next();
  }
  return new NextResponse("Enter the demo access credentials to continue.", { status: 401, headers: {
    "WWW-Authenticate": 'Basic realm="SAP demo", charset="UTF-8"', "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  } });
}

export const config = { matcher: "/:path*" };
