import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookie, type SessionUser } from "./auth";
import { getRuntime } from "./runtime";

// React cache deduplicates only within a render, never between users or requests.
export const getPageSession = cache(async () => {
  // Read request data before constructing runtime: builds must not open services
  // or validate deployment credentials while prerendering the root layout.
  const requestHeaders = await headers();
  const runtime = getRuntime();
  const name = sessionCookie(null, runtime.config.APP_URL).name;
  // Next cookies() collapses duplicate names. Preserve ambiguity and reject it,
  // matching the API boundary's exact-name, single-cookie rule.
  const matches = (requestHeaders.get("cookie") ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  const token = matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
  const user = token ? await runtime.auth.authenticate(token) : null;
  return { user, token };
});

export function loginDestination(next: unknown, role?: SessionUser["orgRole"]): string {
  const fallback = role === "GUEST" ? "/review" : "/projects";
  // Only product paths are accepted. No external URL, query, encoded separator,
  // dot segment or backslash can reach browser navigation from the next parameter.
  if (typeof next !== "string" || next.length > 512) return fallback;
  if (next === "/review" || (next === "/admin/reference-library" && role !== "GUEST")) return next;
  if (/^\/projects(?:\/[A-Za-z0-9_-]+)*$/.test(next)) return next;
  return fallback;
}

export async function requirePageSession(route: string) {
  const session = await getPageSession();
  if (!session.user) redirect(`/login?${new URLSearchParams({ next: route })}`);
  return { ...session, user: session.user };
}
