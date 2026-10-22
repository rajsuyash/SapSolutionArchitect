import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { classifyProviderError } from "../src/lib/ai/provider";
import { asStream, messageEvents, sseResponse } from "./support/sse";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const env = (overrides: Record<string, string> = {}) => ({ ...local, NODE_ENV: "test", ...overrides });
const input = { name: "Synthetic project", clientName: "Synthetic client",
  problemStatement: "Orders arrive by email and staff re-key them into spreadsheets, causing delays and errors.",
  targetProduct: "S4HANA_CLOUD_PUBLIC", startingLandscape: "NON_SAP", modules: ["SD"], orgUnits: [] };
const payload = () => ({ schemaVersion: 1, objectives: [{ id: "OBJ-1", text: "Reduce order delays" }],
  painPoints: [{ id: "PPS-1", text: "Manual entry", quote: "re-key them into spreadsheets" }], scopeSummary: "Order processing",
  proposedProcesses: [{ ref: "p1", parentRef: null, level: 1, code: "O2C", name: "Order to Cash", module: "SD", rationale: "Orders are the stated problem" },
    { ref: "p2", parentRef: "p1", level: 2, code: "O2C-01", name: "Order entry", module: "SD", rationale: "Manual entry" }],
  clarifyingQuestions: ["What is the current error rate?"], inputTruncated: false });
const tool = (id = "tool_1") => ({ type: "tool_use", id, name: "submit_analysis", input: payload() });
const thinking = { type: "thinking", thinking: "private reasoning, not for users", signature: "sig" };
const text = { type: "text", text: "I will submit the analysis." };
const json = { headers: { "content-type": "application/json" } };
const reply = (content: unknown[], stop = "tool_use") => new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant",
  model: "m", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 20 } }), json);

function harness(generate: (attempt: number) => Response = () => reply([thinking, text, tool()])) {
  const urls: string[] = [], headers: Array<Headers> = [], bodies: Array<Record<string, unknown>> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    urls.push(String(url)); headers.push(new Headers(init?.headers));
    if (String(url).includes("count_tokens")) return new Response(JSON.stringify({ input_tokens: 10 }), json);
    bodies.push(JSON.parse(String(init?.body)));
    return asStream(generate(bodies.length));
  });
  return { fetch, urls, headers, bodies };
}
const deepinfra = () => parseEnvironment(env({ AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "di-test-key", AI_MODEL: "XiaomiMiMo/MiMo-V2.6-Pro" }));
const anthropic = () => parseEnvironment(env({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "an-test-key" }));
const ALLOWED_KEYS = ["max_tokens", "messages", "model", "stream", "system", "tool_choice", "tools"];
const noThinking = (stages: string, provider: "deepinfra" | "anthropic" = "deepinfra") => provider === "deepinfra"
  ? parseEnvironment(env({ AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "di-test-key", AI_NO_THINKING_STAGES: stages }))
  : { ...anthropic(), AI_NO_THINKING_STAGES: stages.split(",") as ["problem_analysis"] };
afterEach(() => vi.restoreAllMocks());

describe("provider request shape", () => {
  it("sends DeepInfra requests to its Anthropic endpoint with its own key and only portable parameters", async () => {
    const h = harness();
    const result = await createStageRunner(deepinfra(), { fetch: h.fetch })("problem_analysis", input);
    expect(result.metrics).toMatchObject({ provider: "deepinfra", model: "XiaomiMiMo/MiMo-V2.6-Pro", attempts: 1, inputTokens: 30, outputTokens: 20 });
    expect(h.urls.every((url) => url.startsWith("https://api.deepinfra.com/anthropic/v1/messages"))).toBe(true);
    expect(h.headers[0]!.get("x-api-key")).toBe("di-test-key");
    expect(h.headers[0]!.has("anthropic-beta")).toBe(false);
    expect(Object.keys(h.bodies[0]!).sort()).toEqual(ALLOWED_KEYS);
    expect(h.bodies[0]!.model).toBe("XiaomiMiMo/MiMo-V2.6-Pro");
    expect(h.bodies[0]!.stream).toBe(true);
  });
  it("keeps the Anthropic path on api.anthropic.com with the same portable parameters", async () => {
    const h = harness();
    await createStageRunner(anthropic(), { fetch: h.fetch })("problem_analysis", input);
    expect(h.urls.every((url) => url.startsWith("https://api.anthropic.com/v1/messages"))).toBe(true);
    expect(h.headers[0]!.get("x-api-key")).toBe("an-test-key");
    expect(Object.keys(h.bodies[0]!).sort()).toEqual(ALLOWED_KEYS);
  });
  it("refuses to start without the selected provider's key", () => {
    expect(() => createStageRunner({ ...deepinfra(), DEEPINFRA_API_KEY: undefined })).toThrow("Missing DEEPINFRA_API_KEY");
    expect(() => createStageRunner({ ...anthropic(), ANTHROPIC_API_KEY: " " })).toThrow("Missing ANTHROPIC_API_KEY");
  });
  it("keeps DeepInfra in production but still replaces stub with anthropic", async () => {
    const prod = { ...deepinfra(), NODE_ENV: "production" as const };
    const h = harness();
    expect((await createStageRunner(prod, { fetch: h.fetch })("problem_analysis", input)).metrics.provider).toBe("deepinfra");
    const stub = { ...anthropic(), NODE_ENV: "production" as const, AI_PROVIDER: "stub" as const };
    expect((await createStageRunner(stub, { fetch: harness().fetch })("problem_analysis", input)).metrics.provider).toBe("anthropic");
  });
});

describe("AI_NO_THINKING_STAGES", () => {
  it("sends thinking disabled, and only that extra key, for a listed stage on DeepInfra, and records it in the metrics", async () => {
    const h = harness();
    const result = await createStageRunner(noThinking("problem_analysis"), { fetch: h.fetch })("problem_analysis", input);
    expect(Object.keys(h.bodies[0]!).sort()).toEqual([...ALLOWED_KEYS, "thinking"].sort());
    expect(h.bodies[0]!.thinking).toEqual({ type: "disabled" });
    expect(result.metrics.thinkingDisabled).toBe(true);
  });
  it("sends no thinking key for a stage that is not listed", async () => {
    const h = harness();
    const result = await createStageRunner(noThinking("interview_turn,to_be"), { fetch: h.fetch })("problem_analysis", input);
    expect(Object.keys(h.bodies[0]!).sort()).toEqual(ALLOWED_KEYS);
    expect(result.metrics.thinkingDisabled).toBe(false);
  });
  it("never sends it to Anthropic, even if a caller bypasses the environment check", async () => {
    const h = harness();
    const result = await createStageRunner(noThinking("problem_analysis", "anthropic"), { fetch: h.fetch })("problem_analysis", input);
    expect(Object.keys(h.bodies[0]!).sort()).toEqual(ALLOWED_KEYS);
    expect(result.metrics.thinkingDisabled).toBe(false);
  });
  it("rejects the setting for provider anthropic, defaults to none, and rejects unknown stage names", () => {
    expect(() => parseEnvironment(env({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", AI_NO_THINKING_STAGES: "interview_turn" }))).toThrow("AI_NO_THINKING_STAGES");
    expect(anthropic().AI_NO_THINKING_STAGES).toEqual([]);
    expect(noThinking(" interview_turn , problem_analysis ,").AI_NO_THINKING_STAGES).toEqual(["interview_turn", "problem_analysis"]);
    expect(noThinking("  ").AI_NO_THINKING_STAGES).toEqual([]);
    expect(() => noThinking("interview_turn,chat")).toThrow("AI_NO_THINKING_STAGES");
  });
});

describe("reasoning-model latency", () => {
  it("allows a DeepInfra call to run past 120s when AI_CALL_TIMEOUT_SECONDS is raised (recommended 300)", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url).includes("count_tokens")
        ? new Response(JSON.stringify({ input_tokens: 10 }), json)
        : new Promise<Response>((resolve) => setTimeout(() => resolve(asStream(reply([thinking, tool()]))), 150000)));
      const slow = parseEnvironment(env({ AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "di-test-key", AI_MODEL: "XiaomiMiMo/MiMo-V2.6-Pro",
        AI_STAGE_BUDGET_SECONDS: "1200", AI_CALL_TIMEOUT_SECONDS: "300", AI_DESIGN_CALL_TIMEOUT_SECONDS: "1000" }));
      const pending = createStageRunner(slow, { fetch })("problem_analysis", input);
      await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => !String(url).includes("count_tokens"))).toBe(true));
      await vi.advanceTimersByTimeAsync(151000);
      expect((await pending).metrics.attempts).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("responses with thinking blocks", () => {
  it("ignores thinking and text blocks around the single tool_use", async () => {
    const h = harness();
    const result = await createStageRunner(deepinfra(), { fetch: h.fetch })("problem_analysis", input);
    expect(result.metrics.attempts).toBe(1);
    expect(JSON.stringify(result.payload)).not.toContain("private reasoning");
  });
  it("repairs once when the model answers [thinking, text] with no tool call, then succeeds", async () => {
    const h = harness((attempt) => attempt === 1 ? reply([thinking, text], "end_turn") : reply([thinking, text, tool()]));
    const result = await createStageRunner(deepinfra(), { fetch: h.fetch })("problem_analysis", input);
    expect(result.metrics.attempts).toBe(2);
    expect(result.metrics.validationErrors.length).toBeGreaterThan(0);
  });
  it("rejects two tool_use blocks on every attempt", async () => {
    const h = harness(() => reply([thinking, tool("t1"), tool("t2")]));
    await expect(createStageRunner(deepinfra(), { fetch: h.fetch })("problem_analysis", input))
      .rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 2 } });
  });
});

describe("provider failure logging", () => {
  const apiError = (status: number, message: string, type?: string) => Anthropic.APIError.generate(status,
    type ? { type: "error", error: { type, message } } : undefined, message, new Headers());
  it.each([
    [400, "Your credit balance is too low to access the Anthropic API", "invalid_request_error", "credit"],
    [401, "invalid x-api-key", "authentication_error", "auth"],
    [429, "slow down", "rate_limit_error", "rate_limit"],
    [529, "Overloaded", "overloaded_error", "overloaded"],
    [400, "messages.0.content: bad", "invalid_request_error", "invalid_request"],
    [418, "teapot", undefined, "unknown"],
  ])("maps %s %s to %s", (status, message, type, category) => {
    expect(classifyProviderError(apiError(status, message, type))).toMatchObject({ status, category, errorType: type });
  });
  it("maps SDK timeouts to timeout", () => {
    expect(classifyProviderError(new Anthropic.APIConnectionTimeoutError())).toEqual({ category: "timeout" });
  });
  it("logs one safe line, keeps the user-facing code generic, and leaks no prompt or key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
      message: "Your credit balance is too low" } }), { status: 400, ...json }));
    await expect(createStageRunner(deepinfra(), { fetch: h.fetch })("problem_analysis", input)).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({ event: "ai_provider_error", provider: "deepinfra", model: "XiaomiMiMo/MiMo-V2.6-Pro",
      stage: "problem_analysis", status: 400, errorType: "invalid_request_error", category: "credit" });
    expect(line).not.toContain("re-key"); expect(line).not.toContain("di-test-key"); expect(line).not.toContain("Synthetic");
  });
});

describe("environment", () => {
  it("requires DEEPINFRA_API_KEY for deepinfra", () => {
    expect(() => parseEnvironment(env({ AI_PROVIDER: "deepinfra" }))).toThrow("DEEPINFRA_API_KEY");
    expect(() => parseEnvironment(env({ AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "  " }))).toThrow("DEEPINFRA_API_KEY");
    expect(deepinfra().AI_PROVIDER).toBe("deepinfra");
  });
  it("still requires ANTHROPIC_API_KEY for anthropic and not for deepinfra", () => {
    expect(() => parseEnvironment(env({ AI_PROVIDER: "anthropic" }))).toThrow("ANTHROPIC_API_KEY");
    expect(deepinfra().ANTHROPIC_API_KEY).toBeFalsy();
  });
  it("allows deepinfra in production and still forces stub to anthropic", () => {
    const prod = { NODE_ENV: "production", APP_URL: "https://x.example", S3_ENDPOINT: "https://s3.example",
      AUTH_SECRET: "x".repeat(40), EMAIL_PROVIDER: "disabled" };
    expect(parseEnvironment(env({ ...prod, AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "k" })).AI_PROVIDER).toBe("deepinfra");
    expect(() => parseEnvironment(env({ ...prod, AI_PROVIDER: "stub" }))).toThrow("ANTHROPIC_API_KEY");
  });
});

/** Headers arrive at once, then the body stalls until the caller's signal aborts it (as a real fetch body would). */
const stalledStream = (init?: RequestInit) => new Response(new ReadableStream({ start(controller) {
  controller.enqueue(new TextEncoder().encode(messageEvents({ content: [] }).split("\n\n")[0] + "\n\n"));
  init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
} }), { headers: { "content-type": "text/event-stream" } });
const stalling = (overrides: Record<string, string>) => {
  let signal: AbortSignal | null | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).includes("count_tokens")) return new Response(JSON.stringify({ input_tokens: 10 }), json);
    signal = init?.signal; return stalledStream(init);
  });
  const config = parseEnvironment(env({ AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "di-test-key", AI_MODEL: "XiaomiMiMo/MiMo-V2.6-Pro", ...overrides }));
  return { fetch, config, signal: () => signal };
};

describe("streaming failures", () => {
  it("classifies a provider error event that arrives mid-stream", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url).includes("count_tokens")
      ? new Response(JSON.stringify({ input_tokens: 10 }), json)
      : sseResponse(messageEvents({ content: [thinking] }, { type: "overloaded_error", message: "private provider detail" })));
    await expect(createStageRunner(deepinfra(), { fetch })("problem_analysis", input))
      .rejects.toMatchObject({ code: "AI_PROVIDER_ERROR", metrics: { attempts: 1 } });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ event: "ai_provider_error", provider: "deepinfra", category: "overloaded" });
    expect(String(log.mock.calls[0]![0])).not.toContain("private");
  });
  it("maps a stream aborted by the per-call signal to AI_TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      const s = stalling({ AI_CALL_TIMEOUT_SECONDS: "30", AI_DESIGN_CALL_TIMEOUT_SECONDS: "30", AI_STAGE_BUDGET_SECONDS: "600" });
      const pending = createStageRunner(s.config, { fetch: s.fetch })("problem_analysis", input).catch((error: unknown) => error);
      await vi.waitFor(() => expect(s.signal()).toBeDefined());
      await vi.advanceTimersByTimeAsync(29000);
      expect(s.signal()!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toMatchObject({ code: "AI_TIMEOUT", metrics: { attempts: 1 } });
      expect(s.signal()!.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("logs one content-free ai_stage_timeout line when the whole-stage budget expires", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = stalling({ AI_STAGE_BUDGET_SECONDS: "60", AI_CALL_TIMEOUT_SECONDS: "60", AI_DESIGN_CALL_TIMEOUT_SECONDS: "60" });
      const pending = createStageRunner(s.config, { fetch: s.fetch })("problem_analysis", input).catch((error: unknown) => error);
      await vi.waitFor(() => expect(s.signal()).toBeDefined());
      await vi.advanceTimersByTimeAsync(61000);
      expect(await pending).toMatchObject({ code: "AI_TIMEOUT" });
      const stage = log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("ai_stage_timeout"));
      expect(stage).toHaveLength(1);
      expect(JSON.parse(stage[0]!)).toEqual({ event: "ai_stage_timeout", provider: "deepinfra", model: "XiaomiMiMo/MiMo-V2.6-Pro",
        stage: "problem_analysis", elapsedMs: 60000, attempts: 1 });
      expect(stage[0]).not.toMatch(/re-key|Synthetic|di-test-key/);
    } finally { vi.useRealTimers(); }
  });
});
