import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { evaluateDesign, DetailedDesignSchema } from "../src/lib/ai/design-quality";
import { toBeContext, parseToBeInput } from "../src/lib/ai/to-be";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { asStream } from "./support/sse";
import { fixture } from "./support/to-be-input";
import { splitDesign, stepIdOf, toolOf, toolResponse, type RequestBody } from "./support/to-be-split";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const settings = (overrides: Record<string, string> = {}) => parseEnvironment({ ...local, NODE_ENV: "test",
  AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-split-key", ...overrides });
const split = splitDesign(rentalDraft);
const STEP_IDS = rentalDraft.steps.map(step => step.id);

type Handlers = {
  outline?: (nth: number, body: RequestBody) => unknown | Promise<unknown>;
  step?: (id: string, nth: number, body: RequestBody) => unknown | Promise<unknown>;
  overrides?: Record<string, string>;
};
/** A fake provider that answers by requested tool and records every request and the in-flight high-water mark. */
function harness(handlers: Handlers = {}) {
  const outlineCalls: RequestBody[] = [], stepCalls: { id: string; body: RequestBody; signal: AbortSignal | null | undefined }[] = [];
  const stepCount: Record<string, number> = {};
  let inFlight = 0, maxInFlight = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    if (String(url).includes("count_tokens")) return new Response(JSON.stringify({ input_tokens: 1000 }), { headers: { "content-type": "application/json" } });
    const tool = toolOf(body);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (tool === "submit_to_be_outline") {
        outlineCalls.push(body);
        const out = await (handlers.outline?.(outlineCalls.length, body) ?? split.outline);
        return asStream(out instanceof Response ? out : toolResponse(out, tool));
      }
      expect(tool).toBe("submit_to_be_step");
      const id = stepIdOf(body); stepCount[id] = (stepCount[id] ?? 0) + 1;
      stepCalls.push({ id, body, signal: init?.signal });
      const out = await (handlers.step?.(id, stepCount[id]!, body) ?? split.details[id]);
      return asStream(out instanceof Response ? out : toolResponse(out, tool));
    } finally { inFlight--; }
  });
  const run = (input = fixture(), signal?: AbortSignal) => createStageRunner(settings(handlers.overrides), { fetch })("to_be", input, signal);
  return { run, fetch, outlineCalls, stepCalls, stepCount, max: () => maxInFlight };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("forced tool choice per provider", () => {
  const choiceOf = (body: RequestBody) => body.tool_choice;
  it("forces the outline and step tools on DeepInfra, in the call and in the token count", async () => {
    const seen: RequestBody[] = [];
    const h = harness();
    const spy = vi.fn<typeof globalThis.fetch>(async (url, init) => { seen.push(JSON.parse(String(init?.body))); return h.fetch(url, init); });
    await createStageRunner(settings({ AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "synthetic-di-key", AI_MODEL: "XiaomiMiMo/MiMo-V2.6-Pro" }), { fetch: spy })("to_be", fixture());
    const tooled = seen.filter(body => body.tools);
    expect(new Set(tooled.map(body => body.tools[0]!.name))).toEqual(new Set(["submit_to_be_outline", "submit_to_be_step"]));
    expect(tooled.length).toBe(2 * (1 + STEP_IDS.length)); // one count and one call for the outline, and for each step
    for (const body of tooled) expect(choiceOf(body)).toEqual({ type: "tool", name: body.tools[0]!.name, disable_parallel_tool_use: true });
  });
  it("keeps auto on Anthropic for the outline and step tools", async () => {
    const h = harness(); await h.run();
    for (const body of [...h.outlineCalls, ...h.stepCalls.map(call => call.body)]) expect(choiceOf(body)).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });
});

describe("skeleton-then-expansion assembly", () => {
  it("assembles the outline and N step stubs into a design that passes evaluateDesign", async () => {
    const h = harness();
    const result = await h.run();
    const design = result.payload.design;
    expect(DetailedDesignSchema.safeParse(design).success).toBe(true);
    expect(evaluateDesign(toBeContext(parseToBeInput(fixture())), design)).toMatchObject({ structurallyValid: true, errors: [] });
    expect(design).toEqual(rentalDraft);
    expect(result.payload.evaluation.structurallyValid).toBe(true);
    expect(h.outlineCalls).toHaveLength(1);
    expect(h.stepCalls.map(call => call.id).sort()).toEqual([...STEP_IDS].sort());
    expect(result.metrics).toMatchObject({ stage: "to_be", attempts: 4, inputTokens: 400, outputTokens: 800,
      substages: { to_be_outline: { calls: 1, inputTokens: 100, outputTokens: 200 }, to_be_step: { calls: 3, inputTokens: 300, outputTokens: 600 } } });
  });
  it("gives each step call only its own requirements, sources and the frozen outline", async () => {
    const h = harness(); await h.run();
    const call = h.stepCalls.find(entry => entry.id === "TB-2")!;
    const sent = JSON.parse(call.body.messages[0]!.content);
    expect(sent.requirements.map((r: { id: string }) => r.id)).toEqual(["R-3", "R-4"]);
    expect(sent.sources.map((s: { id: string }) => s.id)).toEqual(["SRC-2"]);
    expect(sent.outline.steps.map((s: { id: string }) => s.id)).toEqual(STEP_IDS);
    expect(sent.outline.coverage.map((c: { requirementId: string }) => c.requirementId)).toEqual(["R-3", "R-4"]);
    expect(call.body.tools[0]!.name).toBe("submit_to_be_step");
  });
  it("renames a business-rule or test id that two parallel steps both chose", async () => {
    const clash = (id: string) => ({ ...split.details[id]!, businessRules: [{ ...split.details[id]!.businessRules[0]!, id: "BR-X" }],
      acceptanceTests: split.details[id]!.acceptanceTests.map((test, i) => ({ ...test, id: `T-${i}` })) });
    const h = harness({ step: id => clash(id) });
    const design = (await h.run()).payload.design;
    const ids = design.steps.flatMap(step => [...step.businessRules.map(rule => rule.id), ...step.acceptanceTests.map(test => test.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(design.steps[0]!.businessRules[0]!.id).toBe("BR-X");
    expect(design.steps[1]!.businessRules[0]!.id).toBe("TB-2-BR-X");
  });
});

describe("bounded parallel expansion", () => {
  it("runs steps concurrently up to AI_DESIGN_PARALLELISM", async () => {
    const h = harness({ overrides: { AI_DESIGN_PARALLELISM: "2" }, step: async id => { await sleep(30); return split.details[id]; } });
    await h.run();
    expect(h.max()).toBe(2);
  });
  it("defaults to 4, so three steps all run at once", async () => {
    const h = harness({ step: async id => { await sleep(30); return split.details[id]; } });
    await h.run();
    expect(h.max()).toBe(3);
  });
  it("serialises with AI_DESIGN_PARALLELISM=1 and does not deadlock under AI_MAX_CONCURRENCY=1", async () => {
    const h = harness({ overrides: { AI_DESIGN_PARALLELISM: "1", AI_MAX_CONCURRENCY: "1" }, step: async id => { await sleep(10); return split.details[id]; } });
    await h.run();
    expect(h.max()).toBe(1);
  });
  it("lets fan-out within one stage exceed AI_MAX_CONCURRENCY=1 (the stage holds one permit)", async () => {
    const h = harness({ overrides: { AI_DESIGN_PARALLELISM: "3", AI_MAX_CONCURRENCY: "1" }, step: async id => { await sleep(30); return split.details[id]; } });
    await h.run();
    expect(h.max()).toBe(3);
  });
});

describe("per-step repair", () => {
  it("re-requests only the invalid step, once, with paths and codes but never the model's values", async () => {
    const h = harness({ step: (id, nth) => id === "TB-2" && nth === 1
      ? { ...split.details[id], note: "private-invalid-model-output" } : split.details[id] });
    const result = await h.run();
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 2, "TB-3": 1 });
    expect(h.outlineCalls).toHaveLength(1);
    const repair = h.stepCalls.filter(call => call.id === "TB-2")[1]!.body.messages[0]!.content;
    expect(repair).toContain("INVALID_DRAFT");
    expect(repair).not.toContain("private-invalid-model-output");
    expect(result.payload.design).toEqual(rentalDraft);
    expect(result.metrics.attempts).toBe(5);
    expect(result.metrics.substages!.to_be_step!.calls).toBe(4);
  });
  it("re-requests only the step that a post-assembly check attributes the error to", async () => {
    const bad = { ...split.details["TB-3"]!, acceptanceTests: split.details["TB-3"]!.acceptanceTests.map(test => ({ ...test, requirementIds: ["R-1"] })) };
    const h = harness({ step: (id, nth) => id === "TB-3" && nth === 1 ? bad : split.details[id] });
    const result = await h.run();
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 1, "TB-3": 2 });
    expect(h.stepCalls.filter(call => call.id === "TB-3")[1]!.body.messages[0]!.content).toContain("TEST_TRACE_MISMATCH");
    expect(result.payload.design).toEqual(rentalDraft);
  });
  it("fails with AI_INVALID_OUTPUT when the step is still invalid after its one retry", async () => {
    const h = harness({ step: id => id === "TB-1" ? { oops: true } : split.details[id] });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(h.stepCount["TB-1"]).toBe(2);
    expect(h.outlineCalls).toHaveLength(1);
  });
  it("sends a global error back to the outline once, then re-expands only the steps whose outline entry changed", async () => {
    // A step body valid on its own but breaking a coverage rule can only be fixed in the outline: here the outline omits R-6 on its first answer.
    const broken = { ...split.outline, coverage: split.outline.coverage.slice(0, 5) };
    const h = harness({ outline: nth => nth === 1 ? broken : split.outline });
    const result = await h.run();
    expect(h.outlineCalls).toHaveLength(2);
    expect(h.outlineCalls[1]!.messages[0]!.content).toContain("REQUIREMENT_UNDISPOSITIONED");
    expect(result.payload.design).toEqual(rentalDraft);
  });
});

describe("outline validation and repair", () => {
  it("repairs an invalid outline once", async () => {
    const wrong = { ...split.outline, processName: "private-invalid-model-output", coverage: split.outline.coverage.slice(0, 5) };
    const h = harness({ outline: nth => nth === 1 ? wrong : split.outline });
    const result = await h.run();
    expect(h.outlineCalls).toHaveLength(2);
    expect(h.outlineCalls[1]!.messages[0]!.content).toContain("REQUIREMENT_UNDISPOSITIONED");
    expect(h.outlineCalls[1]!.messages[0]!.content).not.toContain("private-invalid-model-output");
    expect(result.payload.design).toEqual(rentalDraft);
  });
  it("fails with AI_INVALID_OUTPUT, before any step call, when the outline is still invalid", async () => {
    const wrong = { ...split.outline, conflictDecisions: [{ conflictId: "CON-1", decisionId: "FAKE-APPROVAL" }] };
    const h = harness({ outline: () => wrong });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 2 } });
    expect(h.stepCalls).toHaveLength(0);
  });
  it("checks catalog-only reference ids and the fit ladder on the outline", async () => {
    const wrong = { ...split.outline, steps: split.outline.steps.map((step, i) => i ? step : { ...step, implementation: { kind: "STANDARD" as const, referenceIds: ["NOPE"] } }) };
    const h = harness({ outline: () => wrong });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(h.outlineCalls[1]!.messages[0]!.content).toContain("UNKNOWN_REFERENCE");
    expect(h.stepCalls).toHaveLength(0);
  });
});

describe("cancellation and deadlines", () => {
  it("cancels in-flight step calls when the external signal aborts", async () => {
    const release: (() => void)[] = [];
    const h = harness({ step: id => new Promise(resolve => { release.push(() => resolve(split.details[id])); }) });
    const controller = new AbortController();
    const pending = h.run(fixture(), controller.signal).catch(error => error);
    await vi.waitFor(() => expect(h.stepCalls).toHaveLength(3));
    controller.abort();
    expect(await pending).toMatchObject({ code: "AI_CANCELLED" });
    expect(h.stepCalls.every(call => call.signal?.aborted)).toBe(true);
    release.forEach(fn => fn());
  });
  it("fails with AI_TIMEOUT and aborts in-flight steps when the stage budget expires", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ overrides: { AI_STAGE_BUDGET_SECONDS: "300", AI_DESIGN_CALL_TIMEOUT_SECONDS: "300" }, step: () => new Promise(() => {}) });
      const pending = h.run().catch(error => error);
      await vi.waitFor(() => expect(h.stepCalls).toHaveLength(3));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(await pending).toMatchObject({ code: "AI_TIMEOUT" });
      expect(h.stepCalls.every(call => call.signal?.aborted)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("configuration", () => {
  it("validates AI_DESIGN_PARALLELISM like the other AI_* numbers", () => {
    expect(settings().AI_DESIGN_PARALLELISM).toBe(4);
    expect(settings({ AI_DESIGN_PARALLELISM: " " }).AI_DESIGN_PARALLELISM).toBe(4);
    expect(settings({ AI_DESIGN_PARALLELISM: "8" }).AI_DESIGN_PARALLELISM).toBe(8);
    for (const bad of ["0", "17", "2.5", "abc"]) expect(() => settings({ AI_DESIGN_PARALLELISM: bad })).toThrow("AI_DESIGN_PARALLELISM");
  });
  it("accepts the substage names in AI_NO_THINKING_STAGES and applies them per call on DeepInfra", async () => {
    const deepinfra = { AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "synthetic-di-key", AI_NO_THINKING_STAGES: "to_be_step" };
    expect(settings(deepinfra).AI_NO_THINKING_STAGES).toEqual(["to_be_step"]);
    expect(() => settings({ ...deepinfra, AI_NO_THINKING_STAGES: "to_be_chunk" })).toThrow("AI_NO_THINKING_STAGES");
    const h = harness({ overrides: deepinfra });
    await h.run();
    expect(h.outlineCalls[0]!.thinking).toBeUndefined();
    expect(h.stepCalls.every(call => JSON.stringify(call.body.thinking) === JSON.stringify({ type: "disabled" }))).toBe(true);
  });
});
