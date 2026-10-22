import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { fixture as interviewInput } from "./support/interview-input";
import { asStream } from "./support/sse";
import { fixture as toBeInput } from "./support/to-be-input";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const FLASH = "XiaomiMiMo/MiMo-V2.6-Flash", PRO = "XiaomiMiMo/MiMo-V2.6-Pro";
const settings = (overrides: Record<string, string> = {}) => parseEnvironment({ ...local, NODE_ENV: "test",
  AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "synthetic-di-key", AI_MODEL: FLASH, ...overrides });
const analysisInput = { name: "Synthetic project", clientName: "Synthetic client",
  problemStatement: "Orders arrive by email and staff re-key them into spreadsheets, causing delays and errors.",
  targetProduct: "S4HANA_CLOUD_PUBLIC", startingLandscape: "NON_SAP", modules: ["SD"], orgUnits: [] };
const json = { headers: { "content-type": "application/json" } };

/** The provider answers every call with a wrong tool, so no output validates. Only the request model and recorded metrics matter here. */
function run(stage: "problem_analysis" | "to_be" | "interview_turn", overrides: Record<string, string> = {}) {
  const generated: string[] = [], counted: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (String(url).includes("count_tokens")) { counted.push(body.model); return new Response(JSON.stringify({ input_tokens: 10 }), json); }
    generated.push(body.model);
    return asStream(new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn",
      content: [{ type: "text", text: "no tool" }], usage: { input_tokens: 30, output_tokens: 20 } }), json));
  });
  const input = stage === "to_be" ? toBeInput() : stage === "interview_turn" ? interviewInput() : analysisInput;
  const result = createStageRunner(settings(overrides), { fetch })(stage, input).then(() => null, (error: { metrics: { model: string } }) => error.metrics);
  return result.then((metrics) => ({ metrics, generated, counted }));
}

describe("per-stage model selection", () => {
  it.each(["problem_analysis", "to_be", "interview_turn"] as const)("uses AI_MODEL for %s when AI_MODEL_DESIGN is unset", async (stage) => {
    const r = await run(stage);
    expect(r.generated.length).toBeGreaterThan(0);
    expect(new Set(r.generated)).toEqual(new Set([FLASH]));
    expect(r.metrics?.model).toBe(FLASH);
  });
  it("treats a blank AI_MODEL_DESIGN as unset", async () => {
    expect((await run("to_be", { AI_MODEL_DESIGN: "  " })).metrics?.model).toBe(FLASH);
  });
  it("runs to_be on AI_MODEL_DESIGN, including its count_tokens guard", async () => {
    const r = await run("to_be", { AI_MODEL_DESIGN: PRO });
    expect(new Set(r.generated)).toEqual(new Set([PRO]));
    expect(new Set(r.counted)).toEqual(new Set([PRO]));
    expect(r.metrics?.model).toBe(PRO);
  });
  it.each(["problem_analysis", "interview_turn"] as const)("keeps %s on AI_MODEL when AI_MODEL_DESIGN is set", async (stage) => {
    const r = await run(stage, { AI_MODEL_DESIGN: PRO });
    expect(new Set(r.generated)).toEqual(new Set([FLASH]));
    expect(r.metrics?.model).toBe(FLASH);
  });
});

describe("AI_MODEL_PRICES validation", () => {
  const prices = (value: string) => () => settings({ AI_MODEL_PRICES: value });
  it("defaults to no overrides and accepts the recommended production value", () => {
    expect(settings().AI_MODEL_PRICES).toEqual({});
    expect(settings({ AI_MODEL_PRICES: " " }).AI_MODEL_PRICES).toEqual({});
    expect(settings({ AI_MODEL_PRICES: JSON.stringify({ [FLASH]: [0.14, 0.28], [PRO]: [0.43, 0.87] }) }).AI_MODEL_PRICES)
      .toEqual({ [FLASH]: [0.14, 0.28], [PRO]: [0.43, 0.87] });
  });
  it.each([
    ["not json", "{nope"], ["array at the top", "[[1,2]]"], ["wrong tuple length", `{"m":[1]}`], ["three numbers", `{"m":[1,2,3]}`],
    ["zero price", `{"m":[0,1]}`], ["negative price", `{"m":[-1,1]}`], ["above 1000", `{"m":[1,1000.01]}`],
    ["string price", `{"m":["1",2]}`], ["empty model id", `{"":[1,2]}`],
  ])("rejects %s", (_name, value) => {
    expect(prices(value)).toThrow("AI_MODEL_PRICES");
  });
  it("accepts the 1000 upper bound", () => {
    expect(prices(`{"m":[1000,1000]}`)).not.toThrow();
  });
});
