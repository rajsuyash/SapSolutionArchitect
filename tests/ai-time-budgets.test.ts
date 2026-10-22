import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { jobTiming } from "../src/lib/ai/timeouts";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const env = (overrides: Record<string, string> = {}) => parseEnvironment({ ...local, NODE_ENV: "test", ...overrides });
const input = { name: "Synthetic project", clientName: "Synthetic client",
  problemStatement: "Orders arrive by email and staff re-key them into spreadsheets, causing delays and errors.",
  targetProduct: "S4HANA_CLOUD_PUBLIC", startingLandscape: "NON_SAP", modules: ["SD"], orgUnits: [] };
afterEach(() => vi.useRealTimers());

describe("AI time budget configuration", () => {
  it("defaults reproduce the previous Claude numbers", () => {
    const config = env();
    expect([config.AI_STAGE_BUDGET_SECONDS, config.AI_CALL_TIMEOUT_SECONDS, config.AI_DESIGN_CALL_TIMEOUT_SECONDS]).toEqual([300, 120, 240]);
    expect(jobTiming(config.AI_STAGE_BUDGET_SECONDS)).toEqual({ deadlineSeconds: 360, queueExpireSeconds: 420 });
  });
  it("derives deadline = budget + 60 and queue expiry = deadline + 60", () => {
    expect(jobTiming(1200)).toEqual({ deadlineSeconds: 1260, queueExpireSeconds: 1320 });
  });
  it("treats blank values as defaults and accepts the recommended slow-model set", () => {
    expect(env({ AI_STAGE_BUDGET_SECONDS: " " }).AI_STAGE_BUDGET_SECONDS).toBe(300);
    const slow = env({ AI_STAGE_BUDGET_SECONDS: "1200", AI_CALL_TIMEOUT_SECONDS: "300", AI_DESIGN_CALL_TIMEOUT_SECONDS: "1000" });
    expect([slow.AI_STAGE_BUDGET_SECONDS, slow.AI_CALL_TIMEOUT_SECONDS, slow.AI_DESIGN_CALL_TIMEOUT_SECONDS]).toEqual([1200, 300, 1000]);
  });
  it.each([
    ["AI_STAGE_BUDGET_SECONDS", "59"], ["AI_STAGE_BUDGET_SECONDS", "1801"], ["AI_STAGE_BUDGET_SECONDS", "300.5"],
    ["AI_CALL_TIMEOUT_SECONDS", "29"], ["AI_CALL_TIMEOUT_SECONDS", "1501"],
    ["AI_DESIGN_CALL_TIMEOUT_SECONDS", "29"], ["AI_DESIGN_CALL_TIMEOUT_SECONDS", "1501"], ["AI_CALL_TIMEOUT_SECONDS", "abc"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => env({ [name]: value })).toThrow(name);
  });
  it("rejects a per-call timeout above the stage budget", () => {
    expect(() => env({ AI_STAGE_BUDGET_SECONDS: "100", AI_CALL_TIMEOUT_SECONDS: "101" })).toThrow("AI_CALL_TIMEOUT_SECONDS");
    expect(() => env({ AI_STAGE_BUDGET_SECONDS: "200" })).toThrow("AI_DESIGN_CALL_TIMEOUT_SECONDS"); // design default 240 > 200
    expect(env({ AI_STAGE_BUDGET_SECONDS: "240" }).AI_STAGE_BUDGET_SECONDS).toBe(240);
  });
});

describe("runStage honours the configured per-call timeout", () => {
  async function outcome(overrides: Record<string, string>, advanceMs: number) {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).includes("count_tokens")) return new Response(JSON.stringify({ input_tokens: 10 }), { headers: { "content-type": "application/json" } });
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {}); // never answers
    });
    const config = env({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-test-key", ...overrides });
    const pending = createStageRunner(config, { fetch })("problem_analysis", input).catch((error: unknown) => error);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(advanceMs);
    return { pending, signal: signal! };
  }
  it("aborts at 45s when AI_CALL_TIMEOUT_SECONDS=45 and not before", async () => {
    const early = await outcome({ AI_CALL_TIMEOUT_SECONDS: "45" }, 44000);
    expect(early.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await early.pending).toMatchObject({ code: "AI_TIMEOUT" });
  });
  it("keeps a call alive past 120s when the timeout is raised", async () => {
    const run = await outcome({ AI_STAGE_BUDGET_SECONDS: "600", AI_CALL_TIMEOUT_SECONDS: "300" }, 200000);
    expect(run.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(101000);
    expect(await run.pending).toMatchObject({ code: "AI_TIMEOUT" });
  });
});
