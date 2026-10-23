import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { classifyProviderError, creditHint, isTransientProviderError } from "../src/lib/ai/provider";
import { messageEvents, sseResponse } from "./support/sse";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const config = (overrides: Record<string, string> = {}) => parseEnvironment({ ...local, NODE_ENV: "test",
  AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-test-key", AI_MODEL: "synthetic/model", ...overrides });
const input = { name: "Synthetic project", clientName: "Synthetic client",
  problemStatement: "Orders arrive by email and staff re-key them into spreadsheets, causing delays and errors.",
  targetProduct: "S4HANA_CLOUD_PUBLIC", startingLandscape: "NON_SAP", modules: ["SD"], orgUnits: [] };
const payload = () => ({ schemaVersion: 1, objectives: [{ id: "OBJ-1", text: "Reduce order delays" }],
  painPoints: [{ id: "PPS-1", text: "Manual entry", quote: "re-key them into spreadsheets" }], scopeSummary: "Order processing",
  proposedProcesses: [{ ref: "p1", parentRef: null, level: 1, code: "O2C", name: "Order to Cash", module: "SD", rationale: "Orders are the stated problem" },
    { ref: "p2", parentRef: "p1", level: 2, code: "O2C-01", name: "Order entry", module: "SD", rationale: "Manual entry" }],
  clarifyingQuestions: ["What is the current error rate?"], inputTruncated: false });
const ok = () => sseResponse(messageEvents({ content: [{ type: "tool_use", id: "t1", name: "submit_analysis", input: payload() }], stop_reason: "tool_use",
  usage: { input_tokens: 30, output_tokens: 20 } }));
const errorJson = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const anthropicError = (status: number, type = "api_error", headers?: Record<string, string>) => errorJson(status, { type: "error", error: { type, message: "private detail" } }, headers);

function harness(answer: (call: number) => Response | Promise<Response>) {
  const times: number[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { times.push(Date.now()); return answer(times.length); });
  return { fetch, times };
}
const firstCall = (h: { fetch: unknown }) => vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>);

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("transient provider retry", () => {
  it("retries a 503 once, succeeds, counts the retry and logs one content-free retry line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(call => call === 1 ? anthropicError(503) : ok());
    const pending = createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input);
    await firstCall(h); await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(result.metrics).toMatchObject({ providerRetries: 1, attempts: 2 });
    const retry = lines(log).filter(line => line.event === "ai_provider_retry");
    expect(retry).toEqual([{ event: "ai_provider_retry", provider: "openrouter", model: "synthetic/model", stage: "problem_analysis",
      attempt: 1, status: 503, errorType: "api_error", delayMs: 2000 }]);
    expect(JSON.stringify(lines(log))).not.toMatch(/private|or-test-key|re-key/);
  });

  it("backs off 2s, 6s, 18s and gives up after three retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(() => anthropicError(502));
    const pending = createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input).catch((error: unknown) => error);
    await firstCall(h); await vi.advanceTimersByTimeAsync(2000 + 6000 + 18000);
    expect(await pending).toMatchObject({ code: "AI_PROVIDER_ERROR", metrics: { providerRetries: 3, attempts: 4 } });
    expect(h.times.slice(1).map((t, i) => t - h.times[i]!)).toEqual([2000, 6000, 18000]);
  });

  it("honours Retry-After on a 429 (capped)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(call => call === 1 ? anthropicError(429, "rate_limit_error", { "retry-after": "7" }) : call === 2 ? anthropicError(429, "rate_limit_error", { "retry-after": "3600" }) : ok());
    const pending = createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input);
    await firstCall(h); await vi.advanceTimersByTimeAsync(7000 + 30000);
    await pending;
    expect(h.times.slice(1).map((t, i) => t - h.times[i]!)).toEqual([7000, 30000]);
  });

  it.each([400, 401, 404])("does not retry a %s", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(() => anthropicError(status, "invalid_request_error"));
    await expect(createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input))
      .rejects.toMatchObject({ code: "AI_PROVIDER_ERROR", metrics: { providerRetries: 0, attempts: 1 } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 402 and logs the credit category with the status", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(() => errorJson(402, { error: { code: 402, message: "Insufficient credits" } }));
    await expect(createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input)).rejects.toMatchObject({ code: "AI_PROVIDER_CREDIT" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(lines(log)).toEqual([{ event: "ai_provider_error", provider: "openrouter", model: "synthetic/model", stage: "problem_analysis", status: 402, category: "credit" }]);
  });

  it("does not retry a schema failure (the existing single repair is the only second call)", async () => {
    const h = harness(() => sseResponse(messageEvents({ content: [{ type: "tool_use", id: "t1", name: "submit_analysis", input: { bad: true } }], stop_reason: "tool_use" })));
    await expect(createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input))
      .rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { providerRetries: 0, attempts: 2 } });
  });

  it("retries the whole call after an error event in the middle of a stream", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(call => call === 1
      ? sseResponse(messageEvents({ content: [{ type: "text", text: "partial" }] }, { type: "api_error", message: "private detail" })) : ok());
    const pending = createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input);
    await firstCall(h); await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).metrics).toMatchObject({ providerRetries: 1, attempts: 2 });
    expect(lines(log)[0]).toMatchObject({ event: "ai_provider_retry", errorType: "api_error", attempt: 1 });
  });

  it("retries a connection reset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(call => { if (call === 1) throw new TypeError("fetch failed"); return ok(); });
    const pending = createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input);
    await firstCall(h); await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).metrics.providerRetries).toBe(1);
  });

  it("does not start a retry that cannot finish inside the stage budget (AI_TIMEOUT)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The 503 arrives after 40 s of a 60 s budget: 20 s are left, below the 30 s a retry needs.
    const h = harness(() => new Promise<Response>(resolve => setTimeout(() => resolve(anthropicError(503)), 40000)));
    const run = createStageRunner(config({ AI_STAGE_BUDGET_SECONDS: "60", AI_CALL_TIMEOUT_SECONDS: "60", AI_DESIGN_CALL_TIMEOUT_SECONDS: "60" }), { fetch: h.fetch });
    const pending = run("problem_analysis", input).catch((error: unknown) => error);
    await firstCall(h); await vi.advanceTimersByTimeAsync(40000);
    expect(await pending).toMatchObject({ code: "AI_TIMEOUT", metrics: { providerRetries: 0, attempts: 1 } });
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("maps an abort during the backoff to AI_CANCELLED", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(() => anthropicError(503));
    const controller = new AbortController();
    const pending = createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input, controller.signal).catch((error: unknown) => error);
    await firstCall(h); await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    expect(await pending).toMatchObject({ code: "AI_CANCELLED" });
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("classifyProviderError status and OpenRouter codes", () => {
  const generate = (status: number | undefined, body: object) => status === undefined ? new Anthropic.APIError(undefined, body, "m", new Headers())
    : Anthropic.APIError.generate(status, body, "m", new Headers());
  it.each([
    [402, { error: { code: 402, message: "no credits" } }, 402, "credit"],
    [undefined, { error: { code: 429, message: "slow" } }, 429, "rate_limit"],
    [200, { error: { code: 502, message: "upstream" } }, 502, "unknown"],
    [undefined, { error: { code: "503", message: "x" } }, 503, "unknown"],
    [undefined, { type: "error", error: { type: "api_error", message: "x" } }, undefined, "unknown"],
    [undefined, { type: "error", error: { type: "overloaded_error", message: "x" } }, undefined, "overloaded"],
  ])("status %s body %j -> status %s, %s", (status, body, expectedStatus, category) => {
    const result = classifyProviderError(generate(status, body));
    expect(result.status).toBe(expectedStatus); expect(result.category).toBe(category);
  });
});

const REFUSALS = {
  openrouter: [403, { type: "error", error: { type: "permission_error", message: "Workspace monthly budget of $10.00 exceeded. Contact your org admin. $10.27 of $10.00 used; resets 2026-11-01T00:00:00.000Z.", error_type: "permission_denied" } }],
  deepinfra: [402, { type: "error", error: { type: "invalid_request_error", message: "You need positive balance to do inference. Please add balance manually or setup top-up" } }],
  anthropic: [400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }],
} as const;

describe("provider out of credit or budget", () => {
  const apiError = (status: number, body: object) => Anthropic.APIError.generate(status, body, undefined, new Headers());
  it.each(Object.entries(REFUSALS))("classifies the measured %s refusal as credit and never retries it", (_provider, [status, body]) => {
    expect(classifyProviderError(apiError(status, body)).category).toBe("credit");
    expect(isTransientProviderError(apiError(status, body))).toBe(false);
  });
  it.each(Object.entries(REFUSALS))("fails the %s stage once with AI_PROVIDER_CREDIT and a content-free log line", async (provider, [status, body]) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(() => errorJson(status, body));
    const env = { AI_PROVIDER: provider, ANTHROPIC_API_KEY: "a-test-key", DEEPINFRA_API_KEY: "d-test-key" };
    await expect(createStageRunner(config(env), { fetch: h.fetch })("problem_analysis", input))
      .rejects.toMatchObject({ code: "AI_PROVIDER_CREDIT", metrics: { providerRetries: 0 } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(lines(log)).toMatchObject([{ event: "ai_provider_error", provider, category: "credit" }]);
    expect(JSON.stringify(lines(log))).not.toMatch(/budget|balance|\$10|test-key/);
  });
  it("keeps a 429 rate limit retryable and not credit", () => {
    const rateLimited = apiError(429, { type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded: too many requests, limit exceeded for this minute" } });
    expect(classifyProviderError(rateLimited).category).toBe("rate_limit");
    expect(isTransientProviderError(rateLimited)).toBe(true);
  });
  it("keeps a genuine 401 as auth (AI_PROVIDER_ERROR, not credit)", async () => {
    const bad = apiError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    expect(classifyProviderError(bad).category).toBe("auth");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(() => errorJson(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    await expect(createStageRunner(config(), { fetch: h.fetch })("problem_analysis", input)).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
  });
  it("names the provider and the fix in the operator hint, without the provider message", () => {
    expect(creditHint("openrouter")).toMatch(/openrouter.*budget.*top up/i);
    expect(creditHint("deepinfra")).toMatch(/deepinfra/i);
    expect(creditHint("anthropic")).toMatch(/anthropic/i);
  });
});
