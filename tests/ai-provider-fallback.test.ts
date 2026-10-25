import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENROUTER_DEFAULT_MODEL, parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { FALLBACK_COOLDOWN_MS } from "../src/lib/ai/provider";
import { fixture as toBeInput } from "./support/to-be-input";
import { asStream, messageEvents, sseResponse } from "./support/sse";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const FLASH = "XiaomiMiMo/MiMo-V2.6-Flash", PRO = "XiaomiMiMo/MiMo-V2.6-Pro";
const base = { ...local, NODE_ENV: "test", AI_TO_BE_REVIEW: "off", AI_TO_BE_FIX_MAX_PARTS: "0",
  AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "di-secret-key", AI_MODEL: FLASH, AI_MODEL_DESIGN: PRO };
const settings = (overrides: Record<string, string> = {}) => parseEnvironment({ ...base, AI_FALLBACK_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "or-secret-key", AI_FALLBACK_MODEL: "fb/chat", AI_FALLBACK_MODEL_DESIGN: "fb/design", ...overrides });
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
const noTool = () => asStream(new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn",
  content: [{ type: "text", text: "no tool" }], usage: { input_tokens: 30, output_tokens: 20 } }), { headers: { "content-type": "application/json" } }));
const errorJson = (status: number, message = "private detail") =>
  new Response(JSON.stringify({ type: "error", error: { type: status === 400 ? "invalid_request_error" : "api_error", message } }), { status, headers: { "content-type": "application/json" } });
const credit = () => errorJson(402, "Insufficient credits");

type Seen = { host: "primary" | "fallback"; model: string };
/** Fake network: `primary` and `fallback` answer by host; every generating request is recorded with its host and model. */
function network(primary: () => Response | Promise<Response>, fallback: () => Response | Promise<Response> = ok) {
  const seen: Seen[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const host = String(url).includes("openrouter.ai") ? "fallback" : "primary";
    if (String(url).includes("count_tokens")) return new Response(JSON.stringify({ input_tokens: 10 }), { headers: { "content-type": "application/json" } });
    seen.push({ host, model: (JSON.parse(String(init?.body)) as { model: string }).model });
    return host === "primary" ? primary() : fallback();
  });
  return { fetch, seen };
}
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("credit fallback", () => {
  it("re-sends a credit-refused call once to the fallback, logs the switch and attributes the result to the fallback model", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const n = network(credit);
    const result = await createStageRunner(settings(), { fetch: n.fetch })("problem_analysis", input);
    expect(n.seen).toEqual([{ host: "primary", model: FLASH }, { host: "fallback", model: "fb/chat" }]);
    expect(result.metrics).toMatchObject({ provider: "openrouter", model: "fb/chat", inputTokens: 30, outputTokens: 20 });
    const events = lines(log).filter(line => line.event === "ai_provider_fallback");
    expect(events).toEqual([{ event: "ai_provider_fallback", fromProvider: "deepinfra", toProvider: "openrouter", model: "fb/chat", stage: "problem_analysis", reason: "credit" }]);
    expect(JSON.stringify(lines(log))).not.toMatch(/Insufficient|secret|private/);
  });

  it("uses AI_FALLBACK_MODEL_DESIGN for the design stage and AI_FALLBACK_MODEL for the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const n = network(credit, noTool);
    const result = await createStageRunner(settings(), { fetch: n.fetch })("to_be", toBeInput()).then(() => null, (error: { metrics: { model: string; provider: string } }) => error.metrics);
    expect(n.seen[0]).toEqual({ host: "primary", model: PRO });
    expect(new Set(n.seen.slice(1).map(call => call.host))).toEqual(new Set(["fallback"]));
    expect(new Set(n.seen.slice(1).map(call => call.model))).toEqual(new Set(["fb/design"]));
    expect(result).toMatchObject({ provider: "openrouter", model: "fb/design" });
  });

  it("defaults the fallback models to the fallback provider's default model", () => {
    const env = parseEnvironment({ ...base, AI_FALLBACK_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-secret-key" });
    expect(env).toMatchObject({ AI_FALLBACK_MODEL: OPENROUTER_DEFAULT_MODEL, AI_FALLBACK_MODEL_DESIGN: OPENROUTER_DEFAULT_MODEL });
    expect(Object.keys(env.AI_MODEL_PRICES)).toContain(OPENROUTER_DEFAULT_MODEL);
  });

  it.each([400, 401])("does not fall back on a non-credit %s", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const n = network(() => errorJson(status));
    await expect(createStageRunner(settings(), { fetch: n.fetch })("problem_analysis", input)).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
    expect(n.seen.map(call => call.host)).toEqual(["primary"]);
  });

  it("does not fall back on a persistent 500 (retried on the primary, never moved)", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const n = network(() => errorJson(500));
    const pending = createStageRunner(settings(), { fetch: n.fetch })("problem_analysis", input).catch((error: unknown) => error);
    await vi.waitFor(() => expect(n.seen.length).toBe(1));
    await vi.advanceTimersByTimeAsync(2000 + 6000 + 18000);
    expect(await pending).toMatchObject({ code: "AI_PROVIDER_ERROR" });
    expect(new Set(n.seen.map(call => call.host))).toEqual(new Set(["primary"]));
  });

  it("without AI_FALLBACK_PROVIDER a credit failure surfaces as before", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const n = network(credit);
    await expect(createStageRunner(parseEnvironment(base), { fetch: n.fetch })("problem_analysis", input)).rejects.toMatchObject({ code: "AI_PROVIDER_CREDIT" });
    expect(n.seen.map(call => call.host)).toEqual(["primary"]);
  });

  it("surfaces the fallback's own error when it also fails (credit -> AI_PROVIDER_CREDIT)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const n = network(credit, credit);
    await expect(createStageRunner(settings(), { fetch: n.fetch })("problem_analysis", input)).rejects.toMatchObject({ code: "AI_PROVIDER_CREDIT", metrics: { provider: "openrouter", model: "fb/chat" } });
    expect(n.seen.map(call => call.host)).toEqual(["primary", "fallback"]);
    expect(lines(log).filter(line => line.event === "ai_provider_error").map(line => line.provider)).toEqual(["deepinfra", "openrouter"]);
  });

  it("goes straight to the fallback for the cooldown, then tries the primary again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 1_000_000;
    let primaryOk = false;
    const n = network(() => primaryOk ? ok() : credit());
    const run = createStageRunner(settings(), { fetch: n.fetch, now: () => now });
    await run("problem_analysis", input);
    n.seen.length = 0;
    now += FALLBACK_COOLDOWN_MS - 1;
    expect((await run("problem_analysis", input)).metrics.model).toBe("fb/chat");
    expect(n.seen.map(call => call.host)).toEqual(["fallback"]);
    n.seen.length = 0; primaryOk = true; now += 1;
    expect((await run("problem_analysis", input)).metrics).toMatchObject({ provider: "deepinfra", model: FLASH });
    expect(n.seen.map(call => call.host)).toEqual(["primary"]);
  });
});

describe("fallback configuration", () => {
  const names = (overrides: Record<string, string | undefined>) => {
    try { parseEnvironment({ ...base, ...overrides }); return null; } catch (error) { return (error as Error).message; }
  };
  it("rejects a fallback equal to the primary provider", () => {
    expect(names({ AI_FALLBACK_PROVIDER: "deepinfra" })).toBe("Invalid environment variables: AI_FALLBACK_PROVIDER");
  });
  it("rejects a fallback provider without its key, naming only the variable", () => {
    expect(names({ AI_FALLBACK_PROVIDER: "openrouter" })).toBe("Invalid environment variables: OPENROUTER_API_KEY");
  });
  it("rejects stub and unknown fallback providers; blank means none", () => {
    expect(names({ AI_FALLBACK_PROVIDER: "stub" })).toBe("Invalid environment variables: AI_FALLBACK_PROVIDER");
    expect(names({ AI_FALLBACK_PROVIDER: "nope" })).toBe("Invalid environment variables: AI_FALLBACK_PROVIDER");
    expect(names({ AI_FALLBACK_PROVIDER: "  " })).toBeNull();
  });
  it("rejects a fallback model without a fallback provider", () => {
    expect(names({ AI_FALLBACK_MODEL: "x/y" })).toBe("Invalid environment variables: AI_FALLBACK_MODEL");
  });
});
