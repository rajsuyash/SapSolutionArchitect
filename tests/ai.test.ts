import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { parseEnv } from "node:util";
import { createStageRunner } from "../src/lib/ai/runStage";
import { ProblemAnalysisSchema, validateProblemAnalysis } from "../src/lib/ai/problem-analysis";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const config = (overrides: Record<string, string> = {}) => parseEnvironment({ ...local, NODE_ENV: "test", ...overrides });
const input = { name: "Synthetic project", clientName: "Synthetic client",
  problemStatement: "Orders arrive by email and staff re-key them into spreadsheets, causing delays and errors.",
  targetProduct: "S4HANA_CLOUD_PUBLIC", startingLandscape: "NON_SAP", modules: ["SD"], orgUnits: [] };
const payload = () => ({ schemaVersion: 1, objectives: [{ id: "OBJ-1", text: "Reduce order delays" }],
  painPoints: [{ id: "PPS-1", text: "Manual entry", quote: "re-key them into spreadsheets" }], scopeSummary: "Order processing",
  proposedProcesses: [{ ref: "p1", parentRef: null, level: 1, code: "O2C", name: "Order to Cash", module: "SD", rationale: "Orders are the stated problem" },
    { ref: "p2", parentRef: "p1", level: 2, code: "O2C-01", name: "Order entry", module: "SD", rationale: "Manual entry" }],
  clarifyingQuestions: ["What is the current error rate?"], inputTruncated: false });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("scope schema and invariants", () => {
  it("accepts the documented structure", () => {
    expect(ProblemAnalysisSchema.safeParse(payload()).success).toBe(true);
    expect(validateProblemAnalysis(payload(), input.problemStatement)).toEqual({ success: true, data: payload() });
  });
  it.each(["quote", "duplicate", "orphan", "level", "cycle", "no-objective", "unknown"])("rejects %s", (kind) => {
    const value = payload();
    if (kind === "quote") value.painPoints[0]!.quote = "Invented client statement";
    if (kind === "duplicate") value.proposedProcesses[1]!.ref = "p1";
    if (kind === "orphan") value.proposedProcesses[1]!.parentRef = "missing";
    if (kind === "level") value.proposedProcesses[1]!.level = 3;
    if (kind === "cycle") value.proposedProcesses[0]!.parentRef = "p2";
    if (kind === "no-objective") value.objectives = [];
    const result = validateProblemAnalysis(kind === "unknown" ? { ...value, secret: "do not log" } : value, input.problemStatement);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("do not log");
  });
});

describe("stage runner", () => {
  it("loads a deterministic fixture without making a provider request", async () => {
    const fetch = vi.fn();
    const run = createStageRunner(config(), { fetch });
    const first = await run("problem_analysis", input);
    const second = await run("problem_analysis", input);
    expect(first.payload).toEqual(second.payload);
    expect(first.metrics).toMatchObject({ stage: "problem_analysis", provider: "stub", attempts: 1, inputTokens: 0, outputTokens: 0 });
    expect(validateProblemAnalysis(first.payload, input.problemStatement).success).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("repairs once, records safe validation errors, and counts both model attempts", async () => {
    const run = createStageRunner(config({ AI_FAULT_INJECTION: "problem_analysis:invalid:once" }));
    const result = await run("problem_analysis", input);
    expect(result.metrics.attempts).toBe(2);
    expect(result.metrics.validationErrors.length).toBeGreaterThan(0);
  });
  it("fails after two invalid outputs", async () => {
    const run = createStageRunner(config({ AI_FAULT_INJECTION: "problem_analysis:invalid" }));
    await expect(run("problem_analysis", input)).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 2 } });
  });
  it.each(["timeout", "error"])("consumes %s:once only once per runner", async (fault) => {
    const run = createStageRunner(config({ AI_FAULT_INJECTION: `problem_analysis:${fault}:once` }));
    await expect(run("problem_analysis", input)).rejects.toMatchObject({ code: fault === "timeout" ? "AI_TIMEOUT" : "AI_PROVIDER_ERROR" });
    expect((await run("problem_analysis", input)).metrics.attempts).toBe(1);
  });
});

type Body = { model: string; messages: Array<{ content: string }>; system: string; tools: Array<{ name: string; input_schema: unknown }>; tool_choice: unknown };
const message = (output: unknown = payload(), stop = "tool_use") => new Response(JSON.stringify({ id: "msg_test", type: "message", role: "assistant",
  model: "synthetic-model", content: [{ type: "tool_use", id: "tool_1", name: "submit_analysis", input: output }],
  stop_reason: stop, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 20 } }), { headers: { "content-type": "application/json" } });
function providerHarness(generate: (body: Body, init: RequestInit, attempt: number) => Response | Promise<Response> = () => message()) {
  const bodies: Body[] = [], counted: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    if (String(url).includes("count_tokens")) {
      counted.push(body.messages[0]!.content);
      // Deliberately synthetic tokenizer; tests verify cap logic, not real-model tokenization.
      return new Response(JSON.stringify({ input_tokens: Array.from(body.messages[0]!.content).length }), { headers: { "content-type": "application/json" } });
    }
    bodies.push(body);
    return generate(body, init!, bodies.length);
  });
  const settings = (overrides: Record<string, string> = {}) => config({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-test-key", ...overrides });
  return { fetch, bodies, counted, settings };
}

describe("real SDK protocol with an intercepted transport", () => {
  it("disables SDK tracing even when inherited environment enables full content capture", async () => {
    // Resolve the SDK's telemetry dependency without adding a production dependency or another SDK importer.
    const require = createRequire(import.meta.url);
    const sdkRequire = createRequire(require.resolve("@anthropic-ai/sdk"));
    const { trace } = sdkRequire("@opentelemetry/api") as { trace: {
      disable(): void; setGlobalTracerProvider(provider: { getTracer: () => unknown }): boolean;
    } };
    const getTracer = vi.fn(() => ({ startSpan: vi.fn() }));
    trace.disable();
    expect(trace.setGlobalTracerProvider({ getTracer })).toBe(true);
    vi.stubEnv("ANTHROPIC_OPEN_TELEMETRY", "true");
    vi.stubEnv("ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE", "content");
    try {
      const harness = providerHarness();
      await createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", input);
      expect(getTracer).not.toHaveBeenCalled();
    } finally { trace.disable(); }
  });

  it("uses Sonnet-compatible tool selection, validates one tool and repairs quote failures", async () => {
    const harness = providerHarness((_body, _init, attempt) => {
      const value = payload(); if (attempt === 1) value.painPoints[0]!.quote = "private-invented-fact";
      return message(value);
    });
    const log = vi.spyOn(console, "log"), error = vi.spyOn(console, "error"), debug = vi.spyOn(console, "debug");
    const result = await createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", input);
    expect(harness.bodies).toHaveLength(2);
    expect(harness.bodies[0]!.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(harness.bodies[0]!.tools).toHaveLength(1);
    expect(harness.bodies[0]!.tools[0]!.input_schema).toMatchObject({ type: "object", additionalProperties: false, required: expect.arrayContaining(["objectives", "proposedProcesses"]) });
    expect(harness.bodies[1]!.messages[0]!.content).toContain("quote_not_in_source");
    expect(harness.bodies[1]!.messages[0]!.content).not.toContain("private-invented-fact");
    expect(result.metrics).toMatchObject({ attempts: 2, inputTokens: 60, outputTokens: 40 });
    expect(JSON.stringify(result.metrics)).not.toContain(input.problemStatement);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(debug).not.toHaveBeenCalled();
  });

  it("caps Unicode source without splitting code points and strips identity/secrets before token counting", async () => {
    const harness = providerHarness(() => message({ ...payload(), painPoints: [] }));
    const run = createStageRunner(harness.settings({ AI_MAX_INPUT_TOKENS: "60" }), { fetch: harness.fetch });
    const result = await run("problem_analysis", { ...input, email: "hidden@example.com", session: "private-session",
      problemStatement: "Contact person@example.com password=private-password about delays. " + "界😀".repeat(100) });
    const data = JSON.parse(harness.bodies[0]!.messages[0]!.content.split("\n\n")[1]!);
    expect(Array.from(data.problemStatement).length).toBeLessThanOrEqual(60);
    expect(data.problemStatement).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(result.payload.inputTruncated).toBe(true);
    expect(JSON.stringify([...harness.counted, ...harness.bodies])).not.toMatch(/person@example|private-password|hidden@example|private-session/);
  });

  it("does not interpolate template markers pasted into source data", async () => {
    const harness = providerHarness();
    await createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", {
      ...input, problemStatement: input.problemStatement + " {{validationErrors}} {{input}}" });
    expect(harness.bodies[0]!.messages[0]!.content).toContain("{{validationErrors}} {{input}}");
  });

  it.each([429, 500, "network"])("retries %s exactly twice at 2s and 8s", async (status) => {
    vi.useFakeTimers();
    const times: number[] = [];
    const harness = providerHarness((_body, _init, attempt) => {
      times.push(Date.now());
      if (attempt === 3) return message();
      if (status === "network") throw new TypeError("private network detail");
      return new Response(JSON.stringify({ error: { type: "api_error", message: "private provider detail" } }), { status: Number(status), headers: { "content-type": "application/json" } });
    });
    const pending = createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", input);
    await vi.waitFor(() => expect(harness.bodies).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).metrics.attempts).toBe(3);
    expect(times[1]! - times[0]!).toBe(2000);
    expect(times[2]! - times[1]!).toBe(8000);
  });

  it("fails permanent provider errors without leaking provider messages or retrying", async () => {
    const harness = providerHarness(() => new Response(JSON.stringify({ error: { message: "private provider response" } }), { status: 401 }));
    const failure = await createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", input).catch((error) => error);
    expect(failure).toMatchObject({ code: "AI_PROVIDER_ERROR", metrics: { attempts: 1 } });
    expect(JSON.stringify(failure)).not.toContain("private"); expect(harness.bodies).toHaveLength(1);
  });

  it("exhausts transient failures after three calls", async () => {
    vi.useFakeTimers();
    const harness = providerHarness(() => new Response("{}", { status: 503 }));
    const pending = createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", input).catch((error) => error);
    await vi.waitFor(() => expect(harness.bodies).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ code: "AI_PROVIDER_ERROR", metrics: { attempts: 3 } });
  });

  it("rejects truncated tool output even if the partial payload happens to validate", async () => {
    const harness = providerHarness(() => message(payload(), "max_tokens"));
    await expect(createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", input))
      .rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 2 } });
  });

  it.each(["text", "multiple-tools"])("rejects %s responses when automatic tool selection is used", async (kind) => {
    const harness = providerHarness(async () => {
      const body = await message().json();
      body.content = kind === "text" ? [{ type: "text", text: "An unstructured proposal" }]
        : [...body.content, { ...body.content[0], id: "tool_2" }];
      body.stop_reason = kind === "text" ? "end_turn" : "tool_use";
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
    await expect(createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", input))
      .rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 2 } });
  });

  it("ignores stub and fault settings in production", async () => {
    const harness = providerHarness();
    const production = { ...harness.settings(), NODE_ENV: "production" as const, AI_PROVIDER: "stub" as const, AI_FAULT_INJECTION: "problem_analysis:error" };
    const result = await createStageRunner(production, { fetch: harness.fetch })("problem_analysis", input);
    expect(result.metrics.provider).toBe("anthropic"); expect(harness.bodies).toHaveLength(1);
  });

  it("rejects bad inputs before invoking the model", async () => {
    const harness = providerHarness();
    await expect(createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", { ...input, problemStatement: "short" }))
      .rejects.toMatchObject({ code: "AI_INPUT_INVALID", metrics: { attempts: 0 } });
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it.each(["modules", "orgUnits", "candidates"])("rejects credential-like %s codes before any provider request", async (field) => {
    const harness = providerHarness();
    const credential = "AKIA1234567890ABCDEF";
    const value = field === "modules" ? [credential] : field === "orgUnits" ? [{ type: "PLANT", code: credential, name: "Plant" }]
      : [{ kind: "TCODE", code: credential, title: "Reference", summary: "Reference summary" }];
    await expect(createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", { ...input, [field]: value }))
      .rejects.toMatchObject({ code: "AI_INPUT_INVALID", metrics: { attempts: 0 } });
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it("cancels a call after 120s and does not release its concurrency slot until transport settles", async () => {
    vi.useFakeTimers();
    let settle!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const harness = providerHarness((_body, init, attempt) => {
      if (attempt !== 1) return message();
      signal = init.signal;
      return new Promise<Response>((resolve) => { settle = resolve; });
    });
    const run = createStageRunner(harness.settings({ AI_MAX_CONCURRENCY: "1" }), { fetch: harness.fetch });
    const first = run("problem_analysis", input).catch((error) => error);
    await vi.waitFor(() => expect(harness.bodies).toHaveLength(1));
    const second = run("problem_analysis", input);
    await vi.advanceTimersByTimeAsync(120000);
    expect(await first).toMatchObject({ code: "AI_TIMEOUT" }); expect(signal?.aborted).toBe(true);
    expect(harness.bodies).toHaveLength(1);
    settle(message());
    await vi.waitFor(() => expect(harness.bodies).toHaveLength(2));
    expect((await second).metrics.attempts).toBe(1);
  });

  it("enforces the 300s whole-job deadline across calls and repair", async () => {
    vi.useFakeTimers();
    const harness = providerHarness((_body, init, attempt) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(attempt < 3 ? new Response("{}", { status: 503 }) : message()), 110000);
      init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    }));
    const pending = createStageRunner(harness.settings(), { fetch: harness.fetch })("problem_analysis", input).catch((error) => error);
    await vi.waitFor(() => expect(harness.bodies).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(300000);
    expect(await pending).toMatchObject({ code: "AI_TIMEOUT", metrics: { attempts: 3 } });
  });

  it("removes cancelled queued jobs without consuming provider capacity", async () => {
    let settle!: (response: Response) => void;
    const harness = providerHarness((_body, _init, attempt) => attempt === 1 ? new Promise<Response>((resolve) => { settle = resolve; }) : message());
    const run = createStageRunner(harness.settings({ AI_MAX_CONCURRENCY: "1" }), { fetch: harness.fetch });
    const first = run("problem_analysis", input);
    await vi.waitFor(() => expect(harness.bodies).toHaveLength(1));
    const controller = new AbortController();
    const cancelled = run("problem_analysis", input, controller.signal).catch((error) => error);
    controller.abort(); expect(await cancelled).toMatchObject({ code: "AI_CANCELLED", metrics: { attempts: 0 } });
    settle(message()); await first;
    expect((await run("problem_analysis", input)).metrics.attempts).toBe(1);
    expect(harness.bodies).toHaveLength(2);
  });
});
