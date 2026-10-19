import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { proxy } from "../src/proxy";
import { parseEnvironment } from "../src/lib/env";

afterEach(() => vi.unstubAllEnvs());
const password = "synthetic-demo-password-12345";
const request = (path: string, credential?: string) => new NextRequest(`https://example.test${path}`, {
  headers: credential ? { authorization: `Basic ${Buffer.from(credential).toString("base64")}` } : {},
});

it("gates pages, signup and paid analysis independently of application sessions", () => {
  vi.stubEnv("DEMO_ACCESS_PASSWORD", password);
  for (const path of ["/login", "/api/auth/signup", "/api/projects/123/analysis", "/_next/static/test.js"]) {
    expect(proxy(request(path)).status).toBe(401);
    expect(proxy(request(path, "demo:wrong")).status).toBe(401);
    expect(proxy(request(path, `demo:${password}`)).status).toBe(200);
  }
  expect(proxy(request("/api/health")).status).toBe(200);
  expect(proxy(request("/api/health/extra")).status).toBe(401);
});

it("does not enable the optional gate on ordinary installations", () => {
  vi.stubEnv("DEMO_ACCESS_PASSWORD", "");
  expect(proxy(request("/login")).status).toBe(200);
});

it("supports explicitly disabled email in production without fake credentials", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const input = { ...local, NODE_ENV: "production", AUTH_SECRET: "a".repeat(48), APP_URL: "https://example.test",
    S3_ENDPOINT: "https://storage.example.test", AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic",
    EMAIL_PROVIDER: "disabled", DEMO_ACCESS_PASSWORD: password };
  expect(parseEnvironment(input).EMAIL_PROVIDER).toBe("disabled");
  expect(() => parseEnvironment({ ...input, DEMO_ACCESS_PASSWORD: "short" })).toThrow("DEMO_ACCESS_PASSWORD");
  expect(() => parseEnvironment({ ...input, EMAIL_PROVIDER: "resend" })).toThrow("EMAIL_API_KEY");
});
