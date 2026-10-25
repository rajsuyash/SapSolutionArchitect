import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { evaluateDesign, DetailedDesignSchema } from "../src/lib/ai/design-quality";
import { toBeContext, parseToBeInput, validateToBeOutput } from "../src/lib/ai/to-be";
import { reviewBlockers } from "../src/lib/ai/to-be-review";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3, rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { LATE_GROUPS, REGISTER_GROUP_NAMES, type RegisterGroup } from "../src/lib/ai/design-registers";
import { asStream } from "./support/sse";
import { fixture, withCompanyContext } from "./support/to-be-input";
import { registerGroupOf, splitDesign, stepIdOf, toolOf, toolResponse, type RequestBody } from "./support/to-be-split";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const settings = (overrides: Record<string, string> = {}) => parseEnvironment({ ...local, NODE_ENV: "test", AI_TO_BE_REVIEW: "off", AI_TO_BE_FIX_MAX_PARTS: "0",
  AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-split-key", ...overrides });
const split = splitDesign(rentalDraft);
const STEP_IDS = rentalDraft.steps.map(step => step.id);

type Handlers = {
  outline?: (nth: number, body: RequestBody) => unknown | Promise<unknown>;
  /** Answer to a submit_to_be_outline_patch call; a test that expects no patch leaves it unset and fails if one is requested. */
  patch?: (nth: number, body: RequestBody) => unknown | Promise<unknown>;
  step?: (id: string, nth: number, body: RequestBody) => unknown | Promise<unknown>;
  registers?: (group: RegisterGroup, nth: number, body: RequestBody) => unknown | Promise<unknown>;
  /** Answer to a submit_to_be_review call; a test that does not expect the consistency pass leaves it unset and fails if one is requested. */
  review?: (nth: number, body: RequestBody) => unknown | Promise<unknown>;
  overrides?: Record<string, string>;
};
/** A fake provider that answers by requested tool and records every request and the in-flight high-water mark. */
function harness(handlers: Handlers = {}) {
  const reviewCalls: RequestBody[] = [];
  const outlineCalls: RequestBody[] = [], patchCalls: RequestBody[] = [], stepCalls: { id: string; body: RequestBody; signal: AbortSignal | null | undefined }[] = [];
  const registerCalls: { group: RegisterGroup; body: RequestBody; signal: AbortSignal | null | undefined }[] = [];
  const stepCount: Record<string, number> = {}, registerCount: Partial<Record<RegisterGroup, number>> = {};
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
      if (tool === "submit_to_be_outline_patch") {
        patchCalls.push(body);
        if (!handlers.patch) throw new Error("unexpected submit_to_be_outline_patch call");
        const out = await handlers.patch(patchCalls.length, body);
        return asStream(out instanceof Response ? out : toolResponse(out, tool));
      }
      if (tool === "submit_to_be_review") {
        reviewCalls.push(body);
        if (!handlers.review) throw new Error("unexpected submit_to_be_review call");
        const out = await handlers.review(reviewCalls.length, body);
        return asStream(out instanceof Response ? out : toolResponse(out, tool));
      }
      const group = registerGroupOf(body);
      if (group) {
        registerCount[group] = (registerCount[group] ?? 0) + 1;
        registerCalls.push({ group, body, signal: init?.signal });
        const out = await (handlers.registers?.(group, registerCount[group]!, body) ?? rentalRegisterGroups[group]);
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
  return { run, fetch, reviewCalls, outlineCalls, patchCalls, stepCalls, stepCount, registerCalls, registerCount, max: () => maxInFlight };
}
/** The rental outline with one invalid field in step 0: a path-attributable error, repaired with a patch. */
const badKindOutline = { ...split.outline, steps: split.outline.steps.map((step, i) => i === 0 ? { ...step, implementation: { ...step.implementation, kind: "LICENSE_DEPENDENT" } } : step) };
const outsideAnswer = (repair: string) => { const request = JSON.parse(repair) as Record<string, unknown>; delete request.currentAnswer; return JSON.stringify(request); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("worked examples in the system prompts", () => {
  it("sends the rendered example, with no unreplaced marker, in the outline, step and register calls", async () => {
    const seen: RequestBody[] = [];
    const h = harness();
    const spy = vi.fn<typeof globalThis.fetch>(async (url, init) => { seen.push(JSON.parse(String(init?.body))); return h.fetch(url, init); });
    await createStageRunner(settings(), { fetch: spy })("to_be", fixture());
    const systems = new Map(seen.filter(body => body.tools).map(body => [body.tools[0]!.name, String(typeof body.system === "string" ? body.system : JSON.stringify(body.system))]));
    expect(systems.size).toBe(2 + REGISTER_GROUP_NAMES.length);
    for (const system of systems.values()) {
      expect(system).toContain("Illustrative example from an unrelated process");
      expect(system).not.toContain("{{WORKED_EXAMPLE}}");
    }
  });
});

describe("forced tool choice per provider", () => {
  const choiceOf = (body: RequestBody) => body.tool_choice;
  it("forces the outline, step and every register tool on DeepInfra, in the call and in the token count", async () => {
    const seen: RequestBody[] = [];
    const h = harness();
    const spy = vi.fn<typeof globalThis.fetch>(async (url, init) => { seen.push(JSON.parse(String(init?.body))); return h.fetch(url, init); });
    await createStageRunner(settings({ AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "synthetic-di-key", AI_MODEL: "XiaomiMiMo/MiMo-V2.6-Pro" }), { fetch: spy })("to_be", fixture());
    const tooled = seen.filter(body => body.tools);
    expect(new Set(tooled.map(body => body.tools[0]!.name))).toEqual(new Set(["submit_to_be_outline", "submit_to_be_step",
      ...REGISTER_GROUP_NAMES.map(group => `submit_to_be_registers_${group}`)]));
    expect(tooled.length).toBe(2 * (1 + STEP_IDS.length + REGISTER_GROUP_NAMES.length)); // one count and one call for the outline, each step and each register group
    for (const body of tooled) expect(choiceOf(body)).toEqual({ type: "tool", name: body.tools[0]!.name, disable_parallel_tool_use: true });
  });
  it("keeps auto on Anthropic for the outline and step tools", async () => {
    const h = harness(); await h.run();
    for (const body of [...h.outlineCalls, ...h.stepCalls.map(call => call.body), ...h.registerCalls.map(call => call.body)]) expect(choiceOf(body)).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });
});

describe("OpenRouter provider", () => {
  const openrouter = { AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "synthetic-or-key" };
  const MODEL = "deepseek/deepseek-v4.1-flash-1017";
  async function spied(overrides: Record<string, string> = {}) {
    const requests: { url: string; headers: Headers; body: RequestBody }[] = [];
    const h = harness();
    const spy = vi.fn<typeof globalThis.fetch>(async (url, init) => { requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }); return h.fetch(url, init); });
    const result = await createStageRunner(settings({ ...openrouter, ...overrides }), { fetch: spy })("to_be", fixture());
    return { requests, result };
  }
  it("defaults the model to deepseek-v4.1-flash-1017 for every stage with its price, and requires OPENROUTER_API_KEY", () => {
    const env = settings(openrouter);
    expect(env).toMatchObject({ AI_MODEL: MODEL, AI_MODEL_PRICES: { [MODEL]: [0.15, 0.6] } });
    expect(env.AI_REASONING_EFFORT).toBeUndefined(); // the runner then uses "max"
    expect(env.AI_MODEL_DESIGN).toBeUndefined(); // falls back to AI_MODEL
    expect(settings({ ...openrouter, AI_MODEL: "x/y" }).AI_MODEL).toBe("x/y");
    expect(settings({ ...openrouter, AI_MODEL_PRICES: JSON.stringify({ [MODEL]: [1, 2] }) }).AI_MODEL_PRICES[MODEL]).toEqual([1, 2]);
    expect(() => settings({ AI_PROVIDER: "openrouter" })).toThrow("OPENROUTER_API_KEY");
    expect(() => settings({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: " " })).toThrow("OPENROUTER_API_KEY");
    expect(() => settings({ ...openrouter, AI_REASONING_EFFORT: "extreme" })).toThrow("AI_REASONING_EFFORT");
    expect(settings({ ...openrouter, AI_REASONING_EFFORT: " " }).AI_REASONING_EFFORT).toBeUndefined();
    expect(settings().AI_MODEL).toBe("claude-sonnet-5-5"); // other providers keep their default
  });
  it("posts to openrouter.ai/api/v1/messages with a Bearer token, forced tools, max effort on the outline only by default, and never calls count_tokens", async () => {
    const { requests, result } = await spied();
    expect(requests.length).toBe(1 + STEP_IDS.length + REGISTER_GROUP_NAMES.length); // calls only: no count request
    for (const request of requests) {
      expect(request.url).toBe("https://openrouter.ai/api/v1/messages");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-or-key");
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(request.body.model).toBe(MODEL);
      expect(request.body.tool_choice).toEqual({ type: "tool", name: request.body.tools[0]!.name, disable_parallel_tool_use: true });
      // DeepSeek does not support a forced tool while thinking: with no explicit effort only the outline thinks.
      const isOutline = request.body.tools[0]!.name === "submit_to_be_outline";
      expect(request.body.output_config).toEqual(isOutline ? { effort: "max" } : undefined);
      expect(request.body.thinking).toEqual(isOutline ? undefined : { type: "disabled" });
    }
    expect(result.metrics).toMatchObject({ provider: "openrouter", model: MODEL, thinkingDisabled: false });
  });
  it("sends exactly these keys for the to_be_outline call", async () => {
    const outline = (await spied()).requests[0]!.body;
    expect(Object.keys(outline).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "stream", "system", "tool_choice", "tools"]);
    expect({ ...outline, system: "<system prompt>", messages: "<1 user message>", tools: outline.tools.map(tool => tool.name) }).toEqual({
      model: MODEL, max_tokens: 16000, stream: true, system: "<system prompt>", messages: "<1 user message>", tools: ["submit_to_be_outline"],
      tool_choice: { type: "tool", name: "submit_to_be_outline", disable_parallel_tool_use: true }, output_config: { effort: "max" } });
    if (process.env.PRINT_OPENROUTER_BODY) writeFileSync(process.env.PRINT_OPENROUTER_BODY, JSON.stringify({ ...outline, system: `<${String(outline.system).length} chars>`,
      messages: `<${JSON.stringify(outline.messages).length} chars>`, tools: outline.tools.map(tool => ({ name: tool.name, input_schema: "<JSON schema>" })) }, null, 2));
  });
  it("an explicit AI_REASONING_EFFORT applies to every call, steps and registers included", async () => {
    for (const request of (await spied({ AI_REASONING_EFFORT: "max" })).requests) {
      expect(request.body.output_config).toEqual({ effort: "max" });
      expect(request.body.thinking).toBeUndefined();
    }
  });
  it("applies AI_REASONING_EFFORT and AI_NO_THINKING_STAGES per request kind", async () => {
    const medium = (await spied({ AI_REASONING_EFFORT: "medium" })).requests;
    expect(medium.every(request => JSON.stringify(request.body.output_config) === JSON.stringify({ effort: "medium" }))).toBe(true);
    const none = await spied({ AI_REASONING_EFFORT: "none" });
    expect(none.requests.every(request => JSON.stringify(request.body.thinking) === JSON.stringify({ type: "disabled" }) && request.body.output_config === undefined)).toBe(true);
    expect(none.result.metrics.thinkingDisabled).toBe(true);
    const mixed = (await spied({ AI_REASONING_EFFORT: "high", AI_NO_THINKING_STAGES: "to_be_step" })).requests;
    for (const request of mixed) {
      const isStep = request.body.tools[0]!.name === "submit_to_be_step";
      expect(request.body.thinking).toEqual(isStep ? { type: "disabled" } : undefined);
      expect(request.body.output_config).toEqual(isStep ? undefined : { effort: "high" });
    }
  });
  it("guards AI_MAX_INPUT_TOKENS with a local chars/3.5 estimate instead of a remote count", async () => {
    const requests: string[] = [];
    const h = harness();
    const spy = vi.fn<typeof globalThis.fetch>(async (url, init) => { requests.push(String(url)); return h.fetch(url, init); });
    await expect(createStageRunner(settings({ ...openrouter, AI_MAX_INPUT_TOKENS: "1000" }), { fetch: spy })("to_be", fixture())).rejects.toMatchObject({ code: "AI_INPUT_TOO_LARGE" });
    expect(requests).toEqual([]); // refused before any request, count or call
  });
});

describe("skeleton-then-expansion assembly", () => {
  it("assembles the outline and N step stubs into a design that passes evaluateDesign", async () => {
    const h = harness();
    const result = await h.run();
    const design = result.payload.design;
    expect(DetailedDesignSchema.safeParse(design).success).toBe(true);
    expect(evaluateDesign(toBeContext(parseToBeInput(fixture())), design)).toMatchObject({ structurallyValid: true, errors: [] });
    expect(design).toEqual(rentalDraftV3);
    expect(result.payload.evaluation.structurallyValid).toBe(true);
    expect(h.outlineCalls).toHaveLength(1);
    expect(h.stepCalls.map(call => call.id).sort()).toEqual([...STEP_IDS].sort());
    expect(h.registerCalls.map(call => call.group).sort()).toEqual([...REGISTER_GROUP_NAMES].sort());
    expect(result.metrics).toMatchObject({ stage: "to_be", attempts: 12, inputTokens: 1200, outputTokens: 2400,
      substages: { to_be_outline: { calls: 1, inputTokens: 100, outputTokens: 200 }, to_be_step: { calls: 3, inputTokens: 300, outputTokens: 600 },
        to_be_registers: { calls: 8, inputTokens: 800, outputTokens: 1600 } } });
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
  it("defaults to 4, shared by the step calls and the register calls", async () => {
    const h = harness({ step: async id => { await sleep(30); return split.details[id]; },
      registers: async group => { await sleep(30); return rentalRegisterGroups[group]; } });
    await h.run();
    expect(h.max()).toBe(4); // 3 steps + 4 register groups, never more than 4 at once
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
    expect(h.registerCalls).toHaveLength(REGISTER_GROUP_NAMES.length);
    const repair = h.stepCalls.filter(call => call.id === "TB-2")[1]!.body.messages[0]!.content;
    expect(repair).toContain("INVALID_DRAFT");
    expect(outsideAnswer(repair)).not.toContain("private-invalid-model-output"); // only currentAnswer carries the model's own value
    expect(repair).toContain("private-invalid-model-output");
    expect(result.payload.design).toEqual(rentalDraftV3);
    expect(result.metrics.attempts).toBe(13);
    expect(result.metrics.substages!.to_be_step!.calls).toBe(4);
  });
  it("re-requests only the step that a post-assembly check attributes the error to", async () => {
    const bad = { ...split.details["TB-3"]!, acceptanceTests: split.details["TB-3"]!.acceptanceTests.map(test => ({ ...test, requirementIds: ["R-1"] })) };
    const h = harness({ step: (id, nth) => id === "TB-3" && nth === 1 ? bad : split.details[id] });
    const result = await h.run();
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 1, "TB-3": 2 });
    expect(h.stepCalls.filter(call => call.id === "TB-3")[1]!.body.messages[0]!.content).toContain("TEST_TRACE_MISMATCH");
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("fails with AI_INVALID_OUTPUT when the step is still invalid after its AI_TO_BE_PART_REPAIRS=2 retries and one last call with thinking on", async () => {
    const h = harness({ step: id => id === "TB-1" ? { oops: true } : split.details[id] });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(h.stepCount["TB-1"]).toBe(4);
    expect(h.outlineCalls).toHaveLength(1);
  });
  it("the thinking retry omits thinking-disabled for that call only, records a warning and counts under to_be_step", async () => {
    const openrouter = { AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "synthetic-or-key" };
    const seen: { step: string; thinking: unknown; effort: unknown }[] = [];
    const h = harness({ step: (id, nth) => id === "TB-2" && nth < 4 ? { oops: true } : split.details[id], overrides: openrouter });
    const spy = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as RequestBody;
      if (body.tools?.[0]?.name === "submit_to_be_step") seen.push({ step: stepIdOf(body), thinking: body.thinking, effort: body.output_config });
      return h.fetch(url, init);
    });
    const result = await createStageRunner(settings(openrouter), { fetch: spy })("to_be", fixture());
    const calls = seen.filter(call => call.step === "TB-2");
    expect(calls.map(call => call.thinking)).toEqual([{ type: "disabled" }, { type: "disabled" }, { type: "disabled" }, undefined]);
    expect(calls[3]!.effort).toEqual({ effort: "max" });
    expect(seen.filter(call => call.step !== "TB-2").every(call => (call.thinking as { type: string }).type === "disabled")).toBe(true);
    expect(result.metrics.warnings).toContainEqual({ code: "RETRIED_WITH_THINKING", path: "draft.steps.1" });
    expect(result.metrics.substages!.to_be_step!.calls).toBe(STEP_IDS.length + 3);
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("recovers a step whose body comes back incomplete twice (seen live: EX-09 without effects.financial, addedValue, acceptanceTests, implementation)", async () => {
    const partial = Object.fromEntries(Object.entries(split.details["TB-2"]!).filter(([key]) => !["effects", "addedValue", "acceptanceTests", "implementation"].includes(key)));
    const h = harness({ step: (id, nth) => id === "TB-2" && nth < 3 ? partial : split.details[id] });
    const result = await h.run();
    expect(h.stepCount["TB-2"]).toBe(3);
    expect(h.stepCalls.filter(call => call.id === "TB-2")[2]!.body.messages[0]!.content).toContain("INVALID_DRAFT");
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("AI_TO_BE_PART_REPAIRS=1 allows one retry and 0 allows none", async () => {
    for (const [repairs, calls] of [["1", 3], ["0", 1]] as const) {
      const h = harness({ step: id => id === "TB-1" ? { oops: true } : split.details[id], overrides: { AI_TO_BE_PART_REPAIRS: repairs } });
      await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
      expect(h.stepCount["TB-1"]).toBe(calls);
    }
  });
  it("an invented decision id in a step body and a lower-case stepType are repaired on the first call, with warnings (seen live: draft.steps.10 UNKNOWN_DECISION, steps.7 stepType)", async () => {
    const h = harness({ step: id => id === "TB-2" ? { ...split.details[id], decisionIds: ["D-INVENTED"], stepType: "in-system manual" } : split.details[id] });
    const result = await h.run();
    expect(h.stepCount["TB-2"]).toBe(1);
    expect(result.metrics.warnings).toEqual(expect.arrayContaining([{ code: "REPAIRED_UNKNOWN_DECISION", path: "draft.steps.1" }, { code: "REPAIRED_ENUM_SYNONYM", path: "draft.steps.1.stepType" }]));
    expect(result.payload.design).toEqual({ ...rentalDraftV3, steps: rentalDraftV3.steps.map((step, i) => i === 1 ? { ...step, decisionIds: [] } : step) });
  });
  it("a governance control mapping that cites an invented requirement is dropped on the first call (seen live: draft.controlMappings.12 UNKNOWN_REQUIREMENT)", async () => {
    const bad = { ...rentalRegisterGroups.governance, controlMappings: [{ id: "CM-X", requirementId: "R-INVENTED", mechanism: "AUTHORIZATION", realization: "x", stepIds: ["TB-1"], ruleId: null }] };
    const h = harness({ registers: group => group === "governance" ? bad : rentalRegisterGroups[group] });
    const result = await h.run();
    expect(h.registerCount.governance).toBe(1);
    expect(result.metrics.warnings).toContainEqual({ code: "REPAIRED_DROPPED_ROW", path: "draft.controlMappings.0" });
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("a register group wrapped as {parameter: '<JSON>'} is unwrapped and accepted on the first call, with a warning (seen live)", async () => {
    const h = harness({ registers: group => group === "fitgap" ? { parameter: JSON.stringify(rentalRegisterGroups.fitgap) } : rentalRegisterGroups[group] });
    const result = await h.run();
    expect(h.registerCount.fitgap).toBe(1);
    expect(result.metrics.warnings).toEqual(expect.arrayContaining([{ code: "REPAIRED_WRAPPED_PAYLOAD", path: "draft", detail: "parameter" }]));
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("repairs an outline that omits a coverage row with a patch of the missing rows, then expands every step once", async () => {
    // The first outline omits R-6; the missing row is a path-attributable error, so the model is asked for that row only.
    const broken = { ...split.outline, coverage: split.outline.coverage.slice(0, 5) };
    const h = harness({ outline: () => broken, patch: () => ({ coverage: split.outline.coverage.slice(5) }) });
    const result = await h.run();
    expect(h.outlineCalls).toHaveLength(1);
    expect(h.patchCalls).toHaveLength(1);
    expect(h.patchCalls[0]!.messages[0]!.content).toContain("REQUIREMENT_UNDISPOSITIONED");
    for (const id of STEP_IDS) expect(h.stepCount[id]).toBe(1);
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
});

describe("outline validation and repair", () => {
  it("repairs an invalid outline with a patch that keeps the accepted fields, and keeps the model's prose out of the error list", async () => {
    const wrong = { ...split.outline, processName: "private-invalid-model-output", coverage: split.outline.coverage.slice(0, 5) };
    const h = harness({ outline: nth => nth === 1 ? wrong : split.outline, patch: () => ({ coverage: split.outline.coverage.slice(5) }) });
    const result = await h.run();
    expect(h.outlineCalls).toHaveLength(1);
    const request = JSON.parse(h.patchCalls[0]!.messages[0]!.content) as { validationErrors: unknown; repairNote: string };
    expect(JSON.stringify(request.validationErrors)).toContain("REQUIREMENT_UNDISPOSITIONED");
    expect(JSON.stringify(request.validationErrors)).not.toContain("private-invalid-model-output");
    expect(request.repairNote).not.toContain("private-invalid-model-output");
    expect(result.payload.design).toEqual({ ...rentalDraftV3, processName: "private-invalid-model-output" }); // the patch replaces only what was flagged
  });
  it("fails with AI_INVALID_OUTPUT, before any step call, when the outline is still invalid", async () => {
    const wrong = { ...split.outline, conflictDecisions: [{ conflictId: "CON-1", decisionId: "FAKE-APPROVAL" }] };
    const h = harness({ outline: () => wrong });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 3 } }); // first answer plus AI_TO_BE_OUTLINE_REPAIRS=2
    expect(h.stepCalls).toHaveLength(0);
  });
  it("checks catalog-only reference ids and the fit ladder on the outline", async () => {
    const wrong = { ...split.outline, steps: split.outline.steps.map((step, i) => i ? step : { ...step, implementation: { kind: "STANDARD" as const, referenceIds: ["NOPE"] } }) };
    const h = harness({ outline: () => wrong, patch: () => ({ steps: [wrong.steps[0]] }) });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 3 } });
    expect(h.patchCalls).toHaveLength(2); // a patch that fixes nothing spends the repair; the budget is the same as for a whole outline
    expect(h.patchCalls[0]!.messages[0]!.content).toContain("UNKNOWN_REFERENCE");
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

describe("reasoning switch for the register calls", () => {
  it("accepts to_be_registers in AI_NO_THINKING_STAGES and applies it to the register calls only, on DeepInfra", async () => {
    const deepinfra = { AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "synthetic-di-key", AI_NO_THINKING_STAGES: "to_be_registers" };
    expect(settings(deepinfra).AI_NO_THINKING_STAGES).toEqual(["to_be_registers"]);
    const h = harness({ overrides: deepinfra });
    const result = await h.run();
    expect(h.registerCalls.every(call => JSON.stringify(call.body.thinking) === JSON.stringify({ type: "disabled" }))).toBe(true);
    expect(h.stepCalls.every(call => call.body.thinking === undefined)).toBe(true);
    expect(result.metrics.thinkingDisabled).toBe(false); // only a stage with all three request kinds off reports true
    const all = harness({ overrides: { ...deepinfra, AI_NO_THINKING_STAGES: "to_be_outline,to_be_step,to_be_registers" } });
    expect((await all.run()).metrics.thinkingDisabled).toBe(true);
  });
});

describe("company context as design input", () => {
  const long = `Roughly 400 hire orders a month. ${"Peak season doubles the volume. ".repeat(30)}`;
  const answers = { operating_scale: long, approval_rules: "Credit memos above 500 need the finance lead.", kpi_targets: "Quote turnaround under 2 days" };
  const input = () => withCompanyContext(fixture(), answers);
  const kpiRows = [{ id: "KPI-1", name: "Quote turnaround in days", baseline: "not provided", target: "Quote turnaround under 2 days", measuredFrom: "Quotation documents",
    referenceIds: [], needsValidation: true, validationReason: "Confirm the app", requirementIds: [], contextFieldIds: ["kpi_targets"], stepIds: ["TB-1"],
    owner: "Rental operations lead", producingStepId: "TB-1" }];
  const objectives = [{ ...rentalRegisterGroups.scope.objectives[0]!, contextFieldIds: ["kpi_targets"] }, rentalRegisterGroups.scope.objectives[1]!];
  const registers = (group: RegisterGroup) => group === "integration" ? { ...rentalRegisterGroups.integration, kpis: kpiRows }
    : group === "scope" ? { ...rentalRegisterGroups.scope, objectives } : rentalRegisterGroups[group];

  it("sends the answered fields to the outline call and to every register call, whole", async () => {
    const h = harness({ registers: group => registers(group) });
    await h.run(input());
    const outline = JSON.parse(h.outlineCalls[0]!.messages[0]!.content).input.discovery.companyContext as { fieldId: string; value: string; evidence: unknown }[];
    expect(outline.map(item => item.fieldId)).toEqual(["operating_scale", "approval_rules", "kpi_targets"]);
    expect(outline[0]!.value).toBe(long);
    expect(h.registerCalls).toHaveLength(REGISTER_GROUP_NAMES.length);
    for (const call of h.registerCalls) {
      const sent = JSON.parse(call.body.messages[0]!.content);
      expect(sent.companyContext).toEqual([
        { fieldId: "operating_scale", label: "Label for operating_scale", value: long },
        { fieldId: "approval_rules", label: "Label for approval_rules", value: answers.approval_rules },
        { fieldId: "kpi_targets", label: "Label for kpi_targets", value: answers.kpi_targets }]);
      expect(sent.group).toBe(call.group);
      expect(sent.requirements).toHaveLength(6);
      expect(sent.sources).toBeUndefined();
    }
  });
  it("sends each step call only the fields a step needs, with long values cut", async () => {
    const h = harness({ registers: group => registers(group) });
    await h.run(input());
    for (const call of h.stepCalls) {
      const sent = JSON.parse(call.body.messages[0]!.content) as { companyContext: { fieldId: string; value: string }[] };
      expect(sent.companyContext.map(item => item.fieldId)).toEqual(["operating_scale", "approval_rules"]); // kpi_targets belongs to the registers
      expect(sent.companyContext[0]!.value.length).toBeLessThan(long.length);
      expect(sent.companyContext[0]!.value.startsWith("Roughly 400 hire orders a month.")).toBe(true);
      expect(sent.companyContext[1]!.value).toBe(answers.approval_rules);
    }
  });
  it("omits companyContext from step calls when nothing was answered, so old revisions behave as before", async () => {
    const h = harness(); await h.run();
    for (const call of h.stepCalls) expect(JSON.parse(call.body.messages[0]!.content)).not.toHaveProperty("companyContext");
    for (const call of h.registerCalls) expect(JSON.parse(call.body.messages[0]!.content).companyContext).toEqual([]);
  });
  it("rejects company context that carries a secret or an email address before any model call", async () => {
    const h = harness();
    const secret = withCompanyContext(fixture(), { constraints: "Contact the vendor at someone@example.com for the file" });
    await expect(h.run(secret)).rejects.toMatchObject({ code: "AI_INPUT_INVALID" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("register calls: repair and checks", () => {
  const badFitGap = { fitGap: [{ ...rentalRegisterGroups.fitgap.fitGap[0]!, note: "private-register-output" }] };
  it("re-requests only the invalid register group, once, with paths and codes but never the model's values", async () => {
    const h = harness({ registers: (group, nth) => group === "fitgap" && nth === 1 ? badFitGap : rentalRegisterGroups[group] });
    const result = await h.run();
    expect(h.registerCount).toEqual(Object.fromEntries(REGISTER_GROUP_NAMES.map(group => [group, group === "fitgap" ? 2 : 1])));
    expect(h.stepCalls).toHaveLength(3);
    expect(h.outlineCalls).toHaveLength(1);
    const repair = h.registerCalls.filter(call => call.group === "fitgap")[1]!.body.messages[0]!.content;
    expect(repair).toContain("INVALID_DRAFT");
    expect(repair).toContain("draft.fitGap.0");
    expect(outsideAnswer(repair)).not.toContain("private-register-output");
    expect(repair).toContain("private-register-output");
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("fails with AI_INVALID_OUTPUT when a register group is still invalid after its retries", async () => {
    const h = harness({ registers: group => group === "decisions" ? { oops: true } : rentalRegisterGroups[group] });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(h.registerCount.decisions).toBe(3);
  });
  it("sends a missing critical fit-gap row back to the fit-gap group only", async () => {
    const short = { fitGap: rentalRegisterGroups.fitgap.fitGap.filter(row => row.requirementId !== "R-3") };
    const h = harness({ registers: (group, nth) => group === "fitgap" && nth === 1 ? short : rentalRegisterGroups[group] });
    const result = await h.run();
    expect(h.registerCount.fitgap).toBe(2);
    expect(h.registerCount.decisions).toBe(1);
    expect(h.stepCalls).toHaveLength(3);
    expect(h.registerCalls.filter(call => call.group === "fitgap")[1]!.body.messages[0]!.content).toContain("FIT_GAP_MISSING");
    expect(result.payload.design.fitGap).toHaveLength(6);
  });
  it("requires the integration group to cover every retained system, and repairs it once", async () => {
    const withRetained = withCompanyContext(fixture(), { retained_systems: "Customer portal\nLegacy dispatch system" });
    const rows = ["Customer portal", "Legacy dispatch system"].map((system, i) => ({ id: `IF-${i + 1}`, counterpartSystem: system, direction: "BIDIRECTIONAL" as const,
      triggerFrequency: "Daily", payload: "Hire orders", errorOwner: "Integration lead", outOfScopeReason: null, referenceIds: [], needsValidation: true,
      validationReason: "Confirm the API", requirementIds: [], contextFieldIds: ["retained_systems"], stepIds: ["TB-1"],
      failureHandling: { detection: "Error list", alerting: "Mail to the integration lead", rerun: "Resend the message", idempotency: "Message key is stored" }, systemOfRecord: "SAP" }));
    const h = harness({ registers: (group, nth) => group !== "integration" ? rentalRegisterGroups[group]
      : { interfaces: nth === 1 ? rows.slice(0, 1) : rows, kpis: [] } });
    const result = await h.run(withRetained);
    expect(h.registerCount.integration).toBe(2);
    const repair = JSON.parse(h.registerCalls.filter(call => call.group === "integration")[1]!.body.messages[0]!.content) as { repairNote: string };
    expect(repair.repairNote).toContain("RETAINED_SYSTEM_UNCOVERED");
    // The code alone does not say what is missing: the note says what a row must carry and quotes the answer once, not as a list of system names.
    expect(repair.repairNote).toContain('the answer reads: "Customer portal\nLegacy dispatch system"');
    expect(repair.repairNote).not.toContain('"customer portal"'); expect(repair.repairNote).not.toContain("the retained systems are");
    expect(repair.repairNote).toContain("counterpartSystem"); expect(repair.repairNote).toContain('"retained_systems"');
    expect(result.payload.design.interfaces).toHaveLength(2);
  });
  it("sends an SAP object outside the catalog back to the step that named it, with the token", async () => {
    const h = harness({ step: (id, nth) => id === "TB-2" && nth === 1
      ? { ...split.details[id], effects: { ...split.details[id]!.effects, financial: "Post with movement type 777 and Fiori app F9999." } } : split.details[id] });
    const result = await h.run();
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 2, "TB-3": 1 });
    // The documents and governance groups read the step bodies, so they are written again once a step has been redone.
    expect(h.registerCalls).toHaveLength(REGISTER_GROUP_NAMES.length + LATE_GROUPS.length);
    expect(Object.fromEntries(LATE_GROUPS.map(group => [group, h.registerCount[group]]))).toEqual({ documents: 2, governance: 2 });
    const repair = h.stepCalls.filter(call => call.id === "TB-2")[1]!.body.messages[0]!.content;
    expect(repair).toContain("UNKNOWN_SAP_OBJECT");
    expect(repair).toContain("draft.steps.1.effects.financial");
    expect(repair).toContain("F9999");
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("sends placeholder text in a step back to that step alone, with the field named", async () => {
    const h = harness({ step: (id, nth) => id === STEP_IDS[1] && nth === 1 ? { ...split.details[id]!, outputDocuments: ["Placeholder"] } : split.details[id] });
    await h.run();
    expect(h.stepCount[STEP_IDS[1]!]).toBe(2);
    expect(STEP_IDS.filter(id => h.stepCount[id] !== 1)).toEqual([STEP_IDS[1]]);
    expect(h.stepCalls.filter(call => call.id === STEP_IDS[1])[1]!.body.messages[0]!.content).toContain("placeholder text in field outputDocuments");
  });
  it("sends an SAP object outside the catalog in a register back to that register group", async () => {
    const h = harness({ registers: (group, nth) => group === "decisions" && nth === 1
      ? { keyDesignDecisions: [{ ...rentalRegisterGroups.decisions.keyDesignDecisions[0]!, rationale: "Run transaction VA99 for the split." }] } : rentalRegisterGroups[group] });
    await h.run();
    expect(h.registerCount.decisions).toBe(2);
    expect(h.registerCalls.filter(call => call.group === "decisions")[1]!.body.messages[0]!.content).toContain("draft.keyDesignDecisions.0.rationale");
  });
});

describe("output ceilings and truncation", () => {
  const cut = (tool: string) => toolResponse({ processName: "private-cut-off-text" }, tool, "max_tokens");
  const maxTokens = (body: RequestBody) => (body as RequestBody & { max_tokens: number }).max_tokens;
  it("defaults to 16000 / 8000 / 8000 and takes overrides from the environment", async () => {
    const h = harness(); await h.run();
    expect([maxTokens(h.outlineCalls[0]!), maxTokens(h.stepCalls[0]!.body), maxTokens(h.registerCalls[0]!.body)]).toEqual([16000, 8000, 8000]);
    const o = harness({ overrides: { AI_TO_BE_OUTLINE_MAX_TOKENS: "20000", AI_TO_BE_STEP_MAX_TOKENS: "5000", AI_TO_BE_REGISTERS_MAX_TOKENS: "4000" } }); await o.run();
    expect([maxTokens(o.outlineCalls[0]!), maxTokens(o.stepCalls[0]!.body), maxTokens(o.registerCalls[0]!.body)]).toEqual([20000, 5000, 4000]);
  });
  it.each(["AI_TO_BE_OUTLINE_MAX_TOKENS", "AI_TO_BE_STEP_MAX_TOKENS", "AI_TO_BE_REGISTERS_MAX_TOKENS"])("rejects an invalid %s by name only", name => {
    for (const bad of ["abc", "999", "64001", "1.5"]) expect(() => settings({ [name]: bad })).toThrow(`Invalid environment variables: ${name}`);
    expect(settings({ [name]: " " })).toBeTruthy(); // blank = default
  });
  it("reports a max_tokens outline as OUTPUT_TRUNCATED and asks the repair for a shorter answer, without echoing the cut text", async () => {
    const h = harness({ outline: () => cut("submit_to_be_outline") });
    const error = await h.run().then(() => null, e => e);
    // The first two cut-off answers are free (16000 -> 32000 -> 64000); at the cap the two ordinary repairs follow.
    expect(error).toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 5, stopReasons: Array(5).fill("max_tokens") } });
    expect(error.metrics.attemptIssues).toEqual(Array(5).fill([{ path: "to_be_outline", code: "OUTPUT_TRUNCATED" }]));
    expect(error.metrics.substages.to_be_outline.calls).toBe(5);
    expect(h.outlineCalls.map(maxTokens)).toEqual([16000, 32000, 64000, 64000, 64000]);
    const first = h.outlineCalls[0]!.messages[0]!.content, repair = h.outlineCalls[1]!.messages[0]!.content;
    expect(first).not.toContain("repairNote");
    expect(repair).toContain("OUTPUT_TRUNCATED"); expect(repair).toContain("cut off"); expect(repair).toContain("more concisely");
    expect(repair).not.toContain("private-cut-off-text");
  });
  const callsOf = (calls: { body: RequestBody }[]) => calls.map(call => maxTokens(call.body));
  it("doubles a step's ceiling after each cut-off answer, up to the 64000 cap, and a cut-off answer costs no repair", async () => {
    const h = harness({ step: (id, n) => id === STEP_IDS[0] && n <= 3 ? cut("submit_to_be_step") : split.details[id] });
    const result = await h.run();
    expect(callsOf(h.stepCalls.filter(call => call.id === STEP_IDS[0]))).toEqual([8000, 16000, 32000, 64000]);
    expect(callsOf(h.stepCalls.filter(call => call.id === STEP_IDS[1]))).toEqual([8000]); // another step keeps its own ceiling
    expect(result.metrics.warnings!.filter(w => w.code === "OUTPUT_CEILING_RAISED").map(w => w.path)).toEqual(Array(3).fill("draft.steps.0"));
  });
  it("keeps the repairs a genuinely invalid draft needs after a cut-off answer", async () => {
    const h = harness({ step: (id, n) => id !== STEP_IDS[0] ? split.details[id] : n === 1 ? cut("submit_to_be_step") : n <= 4 ? {} : split.details[id] });
    await h.run();
    expect(callsOf(h.stepCalls.filter(call => call.id === STEP_IDS[0]))).toEqual([8000, 16000, 16000, 16000, 16000]); // cut, two repairs, the thinking retry, and it fits
  });
  it("never asks for more than the cap and gives up once the cap is reached and the repairs are spent", async () => {
    const h = harness({ overrides: { AI_TO_BE_STEP_MAX_TOKENS: "40000" }, step: (id) => id === STEP_IDS[0] ? cut("submit_to_be_step") : split.details[id] });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(callsOf(h.stepCalls.filter(call => call.id === STEP_IDS[0]))).toEqual([40000, 64000, 64000, 64000, 64000]);
  });
  it("raises a register group's ceiling after an answer with no tool payload", async () => {
    const empty = () => new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "synthetic", content: [{ type: "text", text: "no tool" }],
      stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 200 } }), { headers: { "content-type": "application/json" } });
    const h = harness({ registers: (group, n) => group === "decisions" && n <= 2 ? empty() : rentalRegisterGroups[group] });
    await h.run();
    expect(callsOf(h.registerCalls.filter(call => call.group === "decisions"))).toEqual([8000, 16000, 32000]);
    expect(callsOf(h.registerCalls.filter(call => call.group === "governance"))).toEqual([8000]);
  });
  it("recovers when the repaired outline fits, and marks a truncated step for a concise retry", async () => {
    const h = harness({ outline: n => n === 1 ? cut("submit_to_be_outline") : split.outline,
      step: (id, n) => id === STEP_IDS[0] && n === 1 ? cut("submit_to_be_step") : split.details[id] });
    const result = await h.run();
    expect(result.metrics.stopReasons).toContain("max_tokens");
    expect(result.metrics.attemptIssues!.flat().map(issue => issue.code)).toEqual(["OUTPUT_TRUNCATED", "OUTPUT_TRUNCATED"]);
    expect(h.stepCalls.find(c => c.id === STEP_IDS[0])!.body.messages[0]!.content).not.toContain("cut off");
    const retry = h.stepCalls.filter(c => c.id === STEP_IDS[0])[1]!.body.messages[0]!.content;
    expect(retry).toContain("cut off");
  });
});

describe("outline repair by patch", () => {
  it("asks for a small patch when the only error is one bad step, merges it, and counts the call under to_be_outline", async () => {
    const h = harness({ outline: () => badKindOutline, patch: () => ({ steps: [split.outline.steps[0]] }) });
    const result = await h.run();
    expect(result.payload.design).toEqual(rentalDraftV3);
    expect(h.outlineCalls).toHaveLength(1);
    expect(h.patchCalls).toHaveLength(1);
    expect(result.metrics.substages!.to_be_outline!.calls).toBe(2); // the outline and its patch
    expect(result.metrics.attemptIssues![0]).toEqual([expect.objectContaining({ code: "INVALID_DRAFT", path: "outline.steps.0.implementation.kind" })]);
    const request = JSON.parse(h.patchCalls[0]!.messages[0]!.content) as { outline: { steps: { id: string }[] }; repairNote: string };
    expect(h.patchCalls[0]!.tools.map(tool => tool.name)).toEqual(["submit_to_be_outline_patch"]);
    expect(request.outline.steps.map(step => step.id)).toEqual(STEP_IDS);
    expect(request.repairNote).toContain(`step "${STEP_IDS[0]}"`);
    expect(String(h.patchCalls[0]!.system)).toContain("Repairing with a patch");
  });
  it("forces the patch tool on DeepInfra like the other tools", async () => {
    const h = harness({ outline: () => badKindOutline, patch: () => ({ steps: [split.outline.steps[0]] }), overrides: { AI_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "synthetic-di-key", AI_MODEL: "XiaomiMiMo/MiMo-V2.6-Pro" } });
    await h.run();
    expect(h.patchCalls[0]!.tool_choice).toEqual({ type: "tool", name: "submit_to_be_outline_patch", disable_parallel_tool_use: true });
  });
  it("a patch that is cut off or fails its schema is a failed repair; the third answer is a patch again, built on the same outline", async () => {
    const h = harness({ outline: () => badKindOutline, patch: n => n === 1 ? { steps: "x" } : { steps: [split.outline.steps[0]] } });
    const result = await h.run();
    expect(result.payload.design).toEqual(rentalDraftV3);
    expect(h.patchCalls).toHaveLength(2);
    expect(result.metrics.substages!.to_be_outline!.calls).toBe(3);
    expect(result.metrics.attemptIssues!.flat().map(issue => issue.path)).toEqual(["outline.steps.0.implementation.kind", "outline.patch.steps"]);
  });
  it("keeps a failed patch's raw payload for the eval, under its own key", async () => {
    const h = harness({ outline: () => badKindOutline, patch: () => ({ steps: [badKindOutline.steps[0]] }) });
    const failed = await createStageRunner(settings(), { fetch: h.fetch, captureRaw: true })("to_be", fixture()).then(() => null, e => e);
    expect(failed.code).toBe("AI_INVALID_OUTPUT");
    expect(failed.metrics.rawFailures.map((raw: { key: string }) => raw.key)).toEqual(["outline", "outline-patch", "outline-patch"]);
    expect(failed.metrics.substages.to_be_outline.calls).toBe(3);
  });
});

describe("model slips in tool inputs", () => {
  const notes = (result: Awaited<ReturnType<ReturnType<typeof harness>["run"]>>) => (result.metrics.warnings ?? []).map(w => `${w.code}@${w.path}`);
  it("accepts an outline whose list fields arrive as JSON strings or a bare id, without a repair call, and records the repairs", async () => {
    const stringy = { ...split.outline, coverage: JSON.stringify(split.outline.coverage), openQuestions: JSON.stringify(split.outline.openQuestions),
      conflictDecisions: JSON.stringify(split.outline.conflictDecisions),
      steps: split.outline.steps.map((step, i) => i === 0 && step.requirementIds.length === 1 ? { ...step, requirementIds: step.requirementIds[0] } : step) };
    const h = harness({ outline: () => stringy });
    const result = await h.run();
    expect(h.outlineCalls).toHaveLength(1);
    expect(result.payload.design).toEqual(rentalDraftV3);
    expect(notes(result)).toEqual(expect.arrayContaining(["REPAIRED_STRINGIFIED_JSON@outline.coverage", "REPAIRED_STRINGIFIED_JSON@outline.conflictDecisions",
      "REPAIRED_STRINGIFIED_JSON@outline.openQuestions"]));
  });
  it("accepts a step and a register group whose nested fields arrive as JSON strings", async () => {
    const h = harness({ step: (id, n) => id === STEP_IDS[0] && n === 1 ? { ...split.details[id], actions: JSON.stringify(split.details[id]!.actions), effects: JSON.stringify(split.details[id]!.effects) } : split.details[id],
      registers: group => group === "decisions" ? { keyDesignDecisions: JSON.stringify(rentalRegisterGroups.decisions.keyDesignDecisions) } : rentalRegisterGroups[group] });
    const result = await h.run();
    expect(h.stepCount[STEP_IDS[0]!]).toBe(1); expect(h.registerCount.decisions).toBe(1);
    expect(notes(result)).toEqual(expect.arrayContaining([`REPAIRED_STRINGIFIED_JSON@draft.steps.0.actions`, "REPAIRED_STRINGIFIED_JSON@draft.keyDesignDecisions"]));
  });
  it("tells the repair request where each problem is and what kind it is, with no model text", async () => {
    const h = harness({ outline: n => n === 1 ? { ...split.outline, coverage: "private-model-prose", steps: split.outline.steps.map((step, i) => i === 0 ? { ...step, implementation: { ...step.implementation, kind: "LICENSE_DEPENDENT" } } : step) } : split.outline });
    await h.run();
    const first = h.outlineCalls[0]!.messages[0]!.content, repair = JSON.parse(h.outlineCalls[1]!.messages[0]!.content) as { repairNote: string; validationErrors: { path: string; detail: string }[] };
    expect(first).not.toContain("repairNote");
    expect(repair.validationErrors).toEqual(expect.arrayContaining([{ code: "INVALID_DRAFT", path: "outline.coverage", detail: "invalid_type: expected array, received string" }]));
    expect(repair.repairNote).toContain("outline.coverage: expected an array, got a string");
    expect(repair.repairNote).toContain("outline.steps.0.implementation.kind: one of 6 allowed values");
    expect(JSON.stringify(repair)).not.toContain("private-model-prose");
  });
  it("keeps raw failed payloads only when the eval asks for them, capped, and never in production metrics", async () => {
    const bad = { ...split.outline, coverage: "x".repeat(30000) };
    const eval_ = harness({ outline: () => bad });
    const failed = await createStageRunner(settings(), { fetch: eval_.fetch, captureRaw: true })("to_be", fixture()).then(() => null, e => e);
    expect(failed.code).toBe("AI_INVALID_OUTPUT");
    expect(failed.metrics.rawFailures).toHaveLength(3);
    expect(failed.metrics.rawFailures[0]).toMatchObject({ substage: "to_be_outline", key: "outline", attempt: 1, truncated: true });
    expect(failed.metrics.rawFailures[0].json.length).toBe(20000); expect(failed.metrics.rawFailures[1].attempt).toBe(2); expect(failed.metrics.rawFailures[2].attempt).toBe(3);
    const prod = harness({ outline: () => bad });
    const failedProd = await prod.run().then(() => null, e => e);
    expect(failedProd.metrics.rawFailures).toBeUndefined();
  });
});

describe("enabling steps through the pipeline", () => {
  const outlineWithSetup = () => ({ ...split.outline, steps: [
    { id: "TB-0", sequence: 1, title: "Set up project and master data", purpose: "Create the project structure the hire items hang on",
      asIsStepIds: [], requirementIds: [] as string[], enablesStepIds: ["TB-1"], implementation: { kind: "MANUAL" as const, referenceIds: [] as string[] } },
    ...split.outline.steps.map((step, i) => ({ ...step, sequence: i + 2 }))] });
  const setupDetail = () => {
    const base = structuredClone(split.details["TB-1"]!);
    return { ...base, implementation: { detail: "Manual set-up by the project office." },
      businessRules: base.businessRules.map(rule => ({ ...rule, id: `TB-0-${rule.id}` })),
      acceptanceTests: base.acceptanceTests.map(test => ({ ...test, id: `TB-0-${test.id}`, requirementIds: [] as string[] })) };
  };

  /** The fixture registers with TB-0 added where every step must appear (objectives, roles, end-to-end tests). */
  const withSetup = (group: RegisterGroup) => {
    const base = structuredClone(rentalRegisterGroups[group]) as Record<string, { stepIds: string[] }[]>;
    if (group === "scope") base.objectives![0]!.stepIds.push("TB-0");
    if (group === "governance") base.roles![0]!.stepIds.push("TB-0");
    if (group === "reporting") base.endToEndTests![0]!.stepIds.push("TB-0");
    // The set-up step is a copy of TB-1, so it also produces the hire order and needs a transition of its own.
    if (group === "documents") (base.documentStatusModels![0] as unknown as { transitions: unknown[] }).transitions.push({ from: "Open", to: "Open", stepId: "TB-0", event: "Set-up" });
    return base;
  };
  it("accepts an outline step with no requirements that enables a step, expands it with the enabled step's requirements in view, and assembles it", async () => {
    const h = harness({ outline: () => outlineWithSetup(), step: id => id === "TB-0" ? setupDetail() : split.details[id], registers: group => withSetup(group) });
    const result = await h.run();
    const setup = result.payload.design.steps[0]!;
    expect(setup).toMatchObject({ id: "TB-0", requirementIds: [], enablesStepIds: ["TB-1"] });
    expect(result.payload.design.steps[1]).not.toHaveProperty("enablesStepIds");
    const request = JSON.parse(h.stepCalls.find(call => call.id === "TB-0")!.body.messages[0]!.content) as { requirements: unknown[]; enables: { id: string; requirements: { id: string }[] }[] };
    expect(request.requirements).toEqual([]);
    expect(request.enables.map(item => item.id)).toEqual(["TB-1"]);
    expect(request.enables[0]!.requirements.map(item => item.id)).toEqual(["R-1", "R-2"]);
    expect(JSON.parse(h.stepCalls.find(call => call.id === "TB-1")!.body.messages[0]!.content)).not.toHaveProperty("enables");
  });

  it("links an empty-requirement outline step that enables nothing to the next requirement-bearing step", async () => {
    const bad = outlineWithSetup(); delete (bad.steps[0] as { enablesStepIds?: string[] }).enablesStepIds;
    const h = harness({ outline: () => bad, step: id => id === "TB-0" ? setupDetail() : split.details[id], registers: group => withSetup(group), overrides: { AI_TO_BE_OUTLINE_REPAIRS: "0" } });
    const result = await h.run();
    expect(result.payload.design.steps[0]).toMatchObject({ id: "TB-0", requirementIds: [], enablesStepIds: ["TB-1"] });
    expect(result.metrics.warnings).toContainEqual({ code: "REPAIRED_ENABLING_LINK", path: "outline.steps.0" });
  });
});

describe("To-Be answers without a tool call", () => {
  const textMessage = (text: string, stop = "end_turn", extra: unknown[] = []) => new Response(JSON.stringify({ id: "msg_synthetic", type: "message", role: "assistant",
    model: "synthetic", content: [...extra, { type: "text", text }], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 20 } }), { headers: { "content-type": "application/json" } });
  const fenced = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";

  it("accepts a step and an outline sent as one JSON text block, counts them as textFallbacks, and validates them like a tool call", async () => {
    const h = harness({ outline: () => textMessage(JSON.stringify(split.outline)), step: id => id === STEP_IDS[0] ? textMessage(fenced(split.details[id])) : split.details[id],
      registers: group => group === "fitgap" ? textMessage(JSON.stringify(rentalRegisterGroups.fitgap)) : rentalRegisterGroups[group] });
    const result = await h.run();
    expect(result.metrics.textFallbacks).toBe(3);
    expect(h.stepCount[STEP_IDS[0]!]).toBe(1);
    expect(result.payload.design).toEqual(rentalDraftV3);
  });

  it("does not trust text that is invalid for the schema: it is repaired twice, retried once with thinking, then fails closed", async () => {
    const wrong = { ...split.details[STEP_IDS[0]!]!, actions: [] };
    const h = harness({ step: id => id === STEP_IDS[0] ? textMessage(JSON.stringify(wrong)) : split.details[id] });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(h.stepCount[STEP_IDS[0]!]).toBe(4);
  });

  it("treats prose, two text blocks and a text block next to a tool call as no payload", async () => {
    const h = harness({ step: (id, n) => id === STEP_IDS[0] && n === 1 ? textMessage("I will now design the step.") : split.details[id] });
    const result = await h.run();
    expect(h.stepCount[STEP_IDS[0]!]).toBe(2);
    expect(result.metrics.textFallbacks).toBe(0);
    expect(result.metrics.validationErrors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NO_TOOL_PAYLOAD" })]));
  });

  it("keeps a description of a no-tool answer (stop reason, block types, start of text) only when the eval asks for raw capture", async () => {
    const answer = () => textMessage("Here is my plan, not JSON.", "end_turn", [{ type: "thinking", thinking: "private reasoning", signature: "s" }]);
    const run = async (captureRaw: boolean) => {
      const h = harness({ step: (id, n) => id === STEP_IDS[0] && n === 1 ? answer() : split.details[id] });
      const fetch = h.fetch;
      return (await createStageRunner(settings(), { fetch, captureRaw })("to_be", fixture())).metrics;
    };
    const on = await run(true);
    expect(on.rawFailures).toHaveLength(1);
    const kept = JSON.parse(on.rawFailures![0]!.json) as { noToolPayload: { stopReason: string; blocks: { type: string; head?: string }[] } };
    expect(on.rawFailures![0]).toMatchObject({ substage: "to_be_step", key: STEP_IDS[0] });
    expect(kept.noToolPayload).toMatchObject({ stopReason: "end_turn", blocks: [{ type: "thinking" }, { type: "text", head: "Here is my plan, not JSON." }] });
    expect(on.rawFailures![0]!.json).not.toContain("private reasoning");
    expect((await run(false)).rawFailures).toBeUndefined();
  });
});

describe("tool input schemas sent to the provider", () => {
  type Node = { properties?: Record<string, Node>; required?: string[]; items?: Node; anyOf?: Node[] };
  /** Properties a model may legitimately omit (the schema's .optional()/.default() fields); everything else must be listed in `required`. */
  const OPTIONAL = new Set(["decisionIds", "questionIds", "enablesStepIds"]);
  const missing = (node: Node | undefined, path: string, out: string[] = [], seen = { objects: 0 }): string[] => {
    if (!node) return out;
    if (node.properties) {
      seen.objects++;
      for (const key of Object.keys(node.properties)) if (!OPTIONAL.has(key) && !node.required?.includes(key)) out.push(`${path}.${key}`);
      for (const [key, child] of Object.entries(node.properties)) missing(child, `${path}.${key}`, out, seen);
    }
    missing(node.items, `${path}[]`, out, seen);
    for (const branch of node.anyOf ?? []) missing(branch, path, out, seen);
    return out;
  };
  it("lists every non-optional field as required in the outline, step and all eight register tools (nested objects included)", async () => {
    const seen: RequestBody[] = [];
    // The first outline has one bad field, so the repair asks for a patch and every tool the pipeline can send is requested once.
    const h = harness({ outline: () => badKindOutline, patch: () => ({ steps: [split.outline.steps[0]] }) });
    const spy = vi.fn<typeof globalThis.fetch>(async (url, init) => { seen.push(JSON.parse(String(init?.body))); return h.fetch(url, init); });
    await createStageRunner(settings(), { fetch: spy })("to_be", fixture());
    const tools = new Map(seen.flatMap(body => body.tools ?? []).map((tool: { name: string; input_schema: unknown }) => [tool.name, tool.input_schema as Node] as const));
    expect([...tools.keys()].sort()).toEqual(["submit_to_be_outline", "submit_to_be_outline_patch", ...REGISTER_GROUP_NAMES.map(group => `submit_to_be_registers_${group}`), "submit_to_be_step"].sort());
    // The patch's four sections and its remove block (with its three key lists) are each optional (a patch names only what it changes); the items inside the sections must be fully required.
    const patchSections = ["steps", "coverage", "openQuestions", "eliminatedAsIsSteps", "remove", "remove.coverageRequirementIds", "remove.stepIds", "remove.openQuestionIds"].map(key => `submit_to_be_outline_patch.${key}`);
    for (const [name, schema] of tools) expect(missing(schema, name).filter(path => !patchSections.includes(path)), name).toEqual([]);
    expect(missing(tools.get("submit_to_be_outline_patch")!, "submit_to_be_outline_patch").sort()).toEqual([...patchSections].sort());
    expect(tools.get("submit_to_be_outline_patch")!.properties!.steps!.items!.required).toEqual(expect.arrayContaining(["id", "sequence", "implementation"]));
    const step = tools.get("submit_to_be_step")!;
    expect(step.required).toEqual(expect.arrayContaining(["effects", "addedValue", "acceptanceTests", "implementation"]));
    expect(step.properties!.effects!.required).toEqual(expect.arrayContaining(["financial", "ownership"]));
    // A tool whose required list has been dropped must be caught by the same walker.
    const stripped = structuredClone(step); delete stripped.properties!.effects!.required;
    expect(missing(stripped, "step").length).toBeGreaterThan(0);
  });
});

describe("late register groups (documents, governance)", () => {
  const isLate = (group: RegisterGroup) => (LATE_GROUPS as readonly string[]).includes(group);
  it("run only after every step call, and are the only register calls that receive the step digest", async () => {
    const order: string[] = [];
    const h = harness({ step: id => { order.push(`step:${id}`); return split.details[id]; },
      registers: group => { order.push(`group:${group}`); return rentalRegisterGroups[group]; } });
    await h.run();
    const lastStep = Math.max(...STEP_IDS.map(id => order.indexOf(`step:${id}`)));
    for (const group of LATE_GROUPS) expect(order.indexOf(`group:${group}`), group).toBeGreaterThan(lastStep);
    for (const call of h.registerCalls) {
      const sent = JSON.parse(call.body.messages[0]!.content) as { steps?: { id: string; actor: string; outputDocuments: string[]; businessRules: { id: string }[] }[] };
      if (!isLate(call.group)) { expect(sent.steps, call.group).toBeUndefined(); continue; }
      expect(sent.steps!.map(step => step.id)).toEqual(STEP_IDS);
      expect(sent.steps![0]).toMatchObject({ actor: "Rental coordinator", outputDocuments: rentalDraft.steps[0]!.outputDocuments });
      expect(sent.steps![0]!.businessRules.map(rule => rule.id)).toEqual(["BR-1", "BR-2"]);
    }
  });
  it("a governance answer whose roles do not match the step actors is delivered as a review finding, with no repair call", async () => {
    const wrong = { ...rentalRegisterGroups.governance, roles: rentalRegisterGroups.governance.roles.map((role, i) => i === 2 ? { ...role, name: "Accounts clerk" } : role) };
    const h = harness({ registers: group => group === "governance" ? wrong : rentalRegisterGroups[group] });
    const result = await h.run();
    expect(h.registerCount).toEqual(Object.fromEntries(REGISTER_GROUP_NAMES.map(group => [group, 1])));
    const evaluation = evaluateDesign(toBeContext(parseToBeInput(fixture())), result.payload.design);
    expect(evaluation.errors).toEqual([]);
    expect(evaluation.blockers).toContainEqual({ code: "ROLE_ACTOR_UNMATCHED", path: "draft.steps.2" });
  });
  it("a governance answer that cites an unknown role is a structural error and goes back to governance alone", async () => {
    const sod = rentalRegisterGroups.governance.sodAssessments.map((row, i) => i === 0 ? { ...row, roleIds: ["ROLE-99"] } : row);
    const wrong = { ...rentalRegisterGroups.governance, sodAssessments: sod };
    const h = harness({ registers: (group, nth) => group === "governance" && nth === 1 ? wrong : rentalRegisterGroups[group] });
    const result = await h.run();
    expect(h.registerCount).toEqual(Object.fromEntries(REGISTER_GROUP_NAMES.map(group => [group, group === "governance" ? 2 : 1])));
    expect(h.stepCalls).toHaveLength(3);
    const repair = h.registerCalls.filter(call => call.group === "governance")[1]!.body.messages[0]!.content;
    expect(repair).toContain("UNKNOWN_ROLE");
    expect(outsideAnswer(repair)).not.toContain("ROLE-99");
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("a step answer without stepType is sent back to that step with the path of the field", async () => {
    const h = harness({ step: (id, nth) => id === "TB-2" && nth === 1 ? { ...split.details[id], stepType: undefined } : split.details[id] });
    const result = await h.run();
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 2, "TB-3": 1 });
    expect(h.stepCalls.filter(call => call.id === "TB-2")[1]!.body.messages[0]!.content).toContain("draft.steps.1.stepType");
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("a phase other than Phase 1 without an interim process is attributed to the step, not to a register", async () => {
    const h = harness({ step: (id, nth) => id === "TB-3" && nth === 1 ? { ...split.details[id], phase: "Deferred" } : split.details[id] });
    const result = await h.run();
    expect(h.stepCount["TB-3"]).toBe(2);
    expect(h.stepCalls.filter(call => call.id === "TB-3")[1]!.body.messages[0]!.content).toContain("STEP_INTERIM_MISSING");
    expect(result.payload.design.steps[2]).toMatchObject({ phase: "Phase 1", interimProcess: null });
  });
  it("sends the SAP catalog only to the groups whose rows can cite it", async () => {
    const h = harness(); await h.run();
    const withCatalog = (group: RegisterGroup) => "references" in JSON.parse(h.registerCalls.find(call => call.group === group)!.body.messages[0]!.content);
    expect(Object.fromEntries(REGISTER_GROUP_NAMES.map(group => [group, withCatalog(group)]))).toEqual({
      decisions: true, fitgap: true, foundation: true, integration: true, scope: false, reporting: true, documents: true, governance: false });
  });
});

describe("stop reason of a complete tool call", () => {
  it("accepts one call of the expected tool whatever the stop reason (OpenRouter reports end_turn), and counts the call", async () => {
    const h = harness({ outline: () => toolResponse(split.outline, "submit_to_be_outline", "end_turn"),
      step: id => toolResponse(split.details[id], "submit_to_be_step", "end_turn") });
    const result = await h.run();
    expect(h.outlineCalls).toHaveLength(1);
    expect(h.stepCalls).toHaveLength(STEP_IDS.length);
    expect(result.metrics.stopReasons).toContain("end_turn");
    expect(result.payload.design.steps).toHaveLength(STEP_IDS.length);
  });
  it("still treats max_tokens as truncated even when a tool_use block is present, and a wrong tool as no payload", async () => {
    const cut = harness({ outline: () => toolResponse(split.outline, "submit_to_be_outline", "max_tokens"), patch: () => toolResponse(split.outline, "submit_to_be_outline_patch", "max_tokens") });
    await expect(cut.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    const wrong = harness({ outline: () => toolResponse(split.outline, "some_other_tool", "end_turn") });
    await expect(wrong.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });
});

describe("consistency review through the stage runner", () => {
  it("is on by default in the environment, can be switched off, and rejects other values", () => {
    const base = { ...local, NODE_ENV: "test", AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-split-key" };
    expect(parseEnvironment(base).AI_TO_BE_REVIEW).toBe("on");
    expect(parseEnvironment({ ...base, AI_TO_BE_REVIEW: "off" }).AI_TO_BE_REVIEW).toBe("off");
    expect(parseEnvironment({ ...base, AI_TO_BE_REVIEW: " " }).AI_TO_BE_REVIEW).toBe("on");
    expect(() => parseEnvironment({ ...base, AI_TO_BE_REVIEW: "maybe" })).toThrow("AI_TO_BE_REVIEW");
  });
  it("makes one extra call under the to_be_review substage and reports it", async () => {
    const h = harness({ overrides: { AI_TO_BE_REVIEW: "on" }, review: () => ({ findings: [] }) });
    const result = await h.run();
    expect(h.reviewCalls).toHaveLength(1);
    expect(result.metrics.substages).toMatchObject({ to_be_review: { calls: 1, inputTokens: 100, outputTokens: 200 } });
    expect(result.payload.reviewFindings).toEqual([]);
    expect(h.reviewCalls[0]!.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    const sent = JSON.parse(h.reviewCalls[0]!.messages[0]!.content) as { design: { steps: unknown[] } };
    expect(sent.design.steps).toHaveLength(STEP_IDS.length);
  });
  it("AI_TO_BE_FIX_MAX_PARTS defaults to 8, accepts 0 to 20 and a blank, and to_be_fix is a reasoning-switch name", () => {
    const base = { ...local, NODE_ENV: "test" };
    expect(parseEnvironment(base).AI_TO_BE_FIX_MAX_PARTS).toBe(8);
    expect(parseEnvironment({ ...base, AI_TO_BE_FIX_MAX_PARTS: "0" }).AI_TO_BE_FIX_MAX_PARTS).toBe(0);
    expect(parseEnvironment({ ...base, AI_TO_BE_FIX_MAX_PARTS: " " }).AI_TO_BE_FIX_MAX_PARTS).toBe(8);
    for (const bad of ["21", "-1", "x"]) expect(() => parseEnvironment({ ...base, AI_TO_BE_FIX_MAX_PARTS: bad })).toThrow("AI_TO_BE_FIX_MAX_PARTS");
    expect(parseEnvironment({ ...base, AI_NO_THINKING_STAGES: "to_be_fix" }).AI_NO_THINKING_STAGES).toEqual(["to_be_fix"]);
  });
  it("the fix pass sends a blocker's part back under the to_be_fix substage with that part's own tool, and reports its calls", async () => {
    const unmapped = { ...rentalRegisterGroups.scope, objectives: rentalRegisterGroups.scope.objectives.map(row => row.id === "OBJ-2" ? { ...row, stepIds: ["TB-2"] } : row) };
    const dirty = { ...split.details["TB-2"]!, addedValue: "The register call fills this field." };
    const h = harness({ overrides: { AI_TO_BE_FIX_MAX_PARTS: "8" },
      registers: (group, nth) => group === "scope" && nth === 1 ? unmapped : rentalRegisterGroups[group],
      step: (id, nth) => id === "TB-2" && nth === 1 ? dirty : split.details[id] });
    const result = await h.run();
    expect(h.registerCount.scope).toBe(2);
    expect(h.stepCount["TB-2"]).toBe(2);
    expect(result.metrics.substages).toMatchObject({ to_be_fix: { calls: 2, inputTokens: 200, outputTokens: 400 } });
    expect(result.payload.design).toEqual(rentalDraftV3);
    expect(result.payload.evaluation.blockers.map(item => item.code)).not.toEqual(expect.arrayContaining(["OBJECTIVE_STEP_UNMAPPED"]));
    expect(result.payload.evaluation.blockers.map(item => item.code)).not.toContain("INTERNAL_TERM");
    const repair = JSON.parse(h.registerCalls[h.registerCalls.length - 1]!.body.messages[0]!.content) as { repairNote: string; currentAnswer: unknown };
    expect(repair.repairNote).toContain("not served by any objective");
    expect(repair.currentAnswer).toEqual(unmapped);
  });
  it("a finding that needs a new step takes the outline-patch tool under to_be_fix, and only the new step is expanded", async () => {
    const newStep = { id: "TB-4", sequence: 4, title: "Receive returned goods", purpose: "Book the receipt of returned items.", asIsStepIds: [], requirementIds: [], enablesStepIds: ["TB-2"],
      implementation: { kind: "MANUAL", referenceIds: [] } };
    const base = split.details["TB-3"]!;
    const tb4 = { ...base, businessRules: base.businessRules.map(rule => ({ ...rule, id: `${rule.id}-RECEIPT` })), outputDocuments: ["Goods receipt note"], inputDocuments: ["Return note"],
      acceptanceTests: base.acceptanceTests.map(test => ({ ...test, id: `${test.id}-RECEIPT`, requirementIds: [] })) };
    const g = rentalRegisterGroups;
    const covered: Partial<Record<RegisterGroup, unknown>> = {
      scope: { ...g.scope, objectives: g.scope.objectives.map(row => row.id === "OBJ-2" ? { ...row, stepIds: ["TB-3", "TB-4"] } : row) },
      reporting: { ...g.reporting, endToEndTests: g.reporting.endToEndTests.map(row => ({ ...row, stepIds: [...row.stepIds, "TB-4"] })) },
      governance: { ...g.governance, roles: g.governance.roles.map(role => role.id === "ROLE-3" ? { ...role, stepIds: ["TB-3", "TB-4"] } : role) } };
    const h = harness({ overrides: { AI_TO_BE_REVIEW: "on", AI_TO_BE_FIX_MAX_PARTS: "8" },
      review: () => ({ findings: [{ kind: "COVERAGE_GAP", paths: ["R-99"], explanation: "No step owns the goods receipt." }] }),
      patch: () => ({ steps: [newStep] }), step: id => id === "TB-4" ? tb4 : split.details[id],
      registers: (group, nth) => nth > 1 && covered[group] ? covered[group] : g[group] });
    const result = await h.run();
    expect(h.patchCalls).toHaveLength(1);
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 1, "TB-3": 1, "TB-4": 1 });
    expect(result.payload.design.steps.map(step => step.id)).toEqual(["TB-1", "TB-2", "TB-3", "TB-4"]);
    expect(result.payload.reviewFindings).toEqual([expect.objectContaining({ kind: "COVERAGE_GAP", outcome: "REPAIRED" })]);
    // outline patch + new step + scope, reporting and governance groups
    expect(result.metrics.substages).toMatchObject({ to_be_fix: { calls: 5 } });
    expect(result.metrics.substages!.to_be_outline!.calls).toBe(1);
  });
  it("AI_TO_BE_FIX_MAX_PARTS=0 makes no fix call and reports no to_be_fix substage", async () => {
    const unmapped = { ...rentalRegisterGroups.scope, objectives: rentalRegisterGroups.scope.objectives.map(row => row.id === "OBJ-2" ? { ...row, stepIds: ["TB-2"] } : row) };
    const h = harness({ overrides: { AI_TO_BE_FIX_MAX_PARTS: "0" }, registers: group => group === "scope" ? unmapped : rentalRegisterGroups[group] });
    const result = await h.run();
    expect(h.registerCount.scope).toBe(1);
    expect(result.metrics.substages).not.toHaveProperty("to_be_fix");
    expect(result.payload.evaluation.blockers.map(item => item.code)).toContain("OBJECTIVE_STEP_UNMAPPED");
  });
  it("AI_TO_BE_REVIEW=off makes no review call", async () => {
    const h = harness({ overrides: { AI_TO_BE_REVIEW: "off" } });
    const result = await h.run();
    expect(h.reviewCalls).toHaveLength(0);
    expect(result.metrics.substages).not.toHaveProperty("to_be_review");
  });
  it("an unresolved finding reaches the payload as a blocker with the reviewer's sentence, and revalidating with the payload's findings reproduces it", async () => {
    const h = harness({ overrides: { AI_TO_BE_REVIEW: "on" }, review: () => ({ findings: [{ kind: "COVERAGE_GAP", paths: ["R-1"], explanation: "Nothing covers the quarterly count." }] }) });
    const result = await h.run();
    expect(result.payload.evaluation.blockers).toContainEqual({ code: "REVIEW_COVERAGE_GAP", path: "draft", detail: "Nothing covers the quarterly count." });
    const again = validateToBeOutput(parseToBeInput(fixture()), result.payload.design, [], reviewBlockers(result.payload.reviewFindings));
    expect(again.success && again.data.evaluation.blockers).toContainEqual({ code: "REVIEW_COVERAGE_GAP", path: "draft", detail: "Nothing covers the quarterly count." });
  });
});

describe("repair requests", () => {
  const MARKUP = "<｜DSML｜ parameter name=\"trigger\" string=\"true\">x</｜DSML｜ parameter>";
  const textMessage = (text: string) => new Response(JSON.stringify({ id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic",
    content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } }), { headers: { "content-type": "application/json" } });
  const second = (h: ReturnType<typeof harness>, id: string) => h.stepCalls.filter(call => call.id === id)[1]!.body.messages[0]!.content;

  it("a field holding tool-call markup is TOOL_MARKUP_LEAKED even though the schema accepts it; the re-ask says to call the tool and does not send the corrupt answer back (checked by its actor text)", async () => {
    const leaked = { ...split.details["TB-2"]!, actor: `Clerk</｜DSML｜ parameter>\n${MARKUP}` };
    const h = harness({ step: (id, nth) => id === "TB-2" && nth === 1 ? leaked : split.details[id] });
    const result = await h.run();
    expect(h.stepCount["TB-2"]).toBe(2);
    expect(result.metrics.validationErrors).toContainEqual(expect.objectContaining({ code: "TOOL_MARKUP_LEAKED", path: "draft.steps.1.actor" }));
    const repair = second(h, "TB-2");
    expect(repair).toContain("Call the tool");
    expect(repair).not.toContain("Clerk");
    expect(repair).not.toContain("currentAnswer");
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("a text answer written as tool-call markup is TOOL_MARKUP_LEAKED, not NO_TOOL_PAYLOAD", async () => {
    const h = harness({ step: (id, nth) => id === "TB-1" && nth === 1 ? textMessage(`<｜DSML｜ calls>\n<｜DSML｜ invoke name="submit_to_be_step">\n${MARKUP}`) : split.details[id] });
    const result = await h.run();
    expect(h.stepCount["TB-1"]).toBe(2);
    expect(result.metrics.validationErrors).toContainEqual(expect.objectContaining({ code: "TOOL_MARKUP_LEAKED" }));
    expect(result.metrics.validationErrors).not.toContainEqual(expect.objectContaining({ code: "NO_TOOL_PAYLOAD" }));
    expect(second(h, "TB-1")).toContain("Call the tool");
  });
  it("an outline whose processName holds tool-call markup is TOOL_MARKUP_LEAKED even though the schema accepts it; the re-ask says to call the tool and the final design is clean", async () => {
    const leaked = { ...split.outline, processName: `Quote to report</｜DSML｜ parameter>\n${MARKUP}` };
    const h = harness({ outline: nth => nth === 1 ? leaked : split.outline });
    const result = await h.run();
    expect(h.outlineCalls).toHaveLength(2);
    expect(result.metrics.validationErrors).toContainEqual(expect.objectContaining({ code: "TOOL_MARKUP_LEAKED", path: "outline.processName" }));
    const repair = h.outlineCalls[1]!.messages[0]!.content;
    expect(repair).toContain("Call the tool");
    expect(repair).not.toContain("Quote to report");
    expect(JSON.stringify(result.payload.design)).not.toContain("DSML");
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("an outline patch holding tool-call markup is rejected, not merged", async () => {
    const h = harness({ outline: n => n === 1 ? badKindOutline : split.outline,
      patch: n => ({ steps: [n === 1 ? { ...split.outline.steps[0], title: `Step${MARKUP}` } : split.outline.steps[0]] }) });
    const result = await h.run();
    expect(h.patchCalls).toHaveLength(2);
    expect(result.metrics.validationErrors).toContainEqual(expect.objectContaining({ code: "TOOL_MARKUP_LEAKED", path: "outline.patch.steps.0.title" }));
    expect(JSON.stringify(result.payload.design)).not.toContain("DSML");
  });
  it("a register payload holding tool-call markup is TOOL_MARKUP_LEAKED and re-asked", async () => {
    const group = rentalRegisterGroups.governance as Record<string, unknown>;
    const key = Object.keys(group).find(name => Array.isArray(group[name]) && typeof (group[name] as Record<string, unknown>[])[0]?.[Object.keys((group[name] as Record<string, unknown>[])[0]!)[0]!] === "string")!;
    const rows = group[key] as Record<string, unknown>[], field = Object.keys(rows[0]!).find(name => typeof rows[0]![name] === "string")!;
    const leaked = { ...group, [key]: [{ ...rows[0], [field]: `x${MARKUP}` }, ...rows.slice(1)] };
    const h = harness({ registers: (name, nth) => name === "governance" && nth === 1 ? leaked : rentalRegisterGroups[name] });
    const result = await h.run();
    expect(h.registerCount.governance).toBe(2);
    expect(result.metrics.validationErrors).toContainEqual(expect.objectContaining({ code: "TOOL_MARKUP_LEAKED", path: expect.stringContaining(`draft.${key}`) }));
    expect(JSON.stringify(result.payload.design)).not.toContain("DSML");
  });
  it("a consistency review holding tool-call markup is dropped, not stored as findings", async () => {
    const h = harness({ overrides: { AI_TO_BE_REVIEW: "on" }, review: () => ({ findings: [{ kind: "COVERAGE_GAP", paths: ["R-1"], explanation: `Gap${MARKUP}` }] }) });
    const result = await h.run();
    expect(JSON.stringify(result.payload)).not.toContain("DSML");
  });
  it("an assembled design with tool-call markup in any string field fails validation with TOOL_MARKUP_LEAKED at that path", () => {
    const input = parseToBeInput(fixture());
    expect(validateToBeOutput(input, rentalDraftV3).success).toBe(true);
    const inStep = { ...rentalDraftV3, steps: rentalDraftV3.steps.map((step, i) => i === 1 ? { ...step, actor: `Clerk${MARKUP}` } : step) };
    expect(validateToBeOutput(input, inStep)).toMatchObject({ success: false, errors: [expect.objectContaining({ code: "TOOL_MARKUP_LEAKED", path: "draft.steps.1.actor" })] });
    const inName = validateToBeOutput(input, { ...rentalDraftV3, processName: `Name${MARKUP}` });
    expect(inName).toMatchObject({ success: false, errors: [expect.objectContaining({ code: "TOOL_MARKUP_LEAKED", path: "draft.processName" })] });
  });
  it("a step re-ask after a schema failure carries the previous answer as currentAnswer, so the note's 'copy the other fields' is true", async () => {
    const wrong = { ...split.details["TB-2"]!, actions: [] };
    const h = harness({ step: (id, nth) => id === "TB-2" && nth === 1 ? wrong : split.details[id] });
    await h.run();
    const request = JSON.parse(second(h, "TB-2")) as { currentAnswer?: unknown; repairNote: string };
    expect(request.currentAnswer).toEqual(wrong);
    expect(request.repairNote).toContain("currentAnswer");
  });
  it("a register re-ask carries the previous answer; an answer too large to resend is left out and the note does not claim it was sent", async () => {
    const wrong = { ...rentalRegisterGroups.governance, controlMappings: "oops" };
    const huge = { ...split.details["TB-1"]!, actions: [], addedValue: "x".repeat(40000) };
    const h = harness({ registers: (group, nth) => group === "governance" && nth === 1 ? wrong : rentalRegisterGroups[group],
      step: (id, nth) => id === "TB-1" && nth === 1 ? huge : split.details[id] });
    await h.run();
    const group = JSON.parse(h.registerCalls.filter(call => call.group === "governance")[1]!.body.messages[0]!.content) as { currentAnswer?: unknown };
    expect(group.currentAnswer).toEqual(wrong);
    const step = JSON.parse(second(h, "TB-1")) as { currentAnswer?: unknown; repairNote: string };
    expect(step.currentAnswer).toBeUndefined();
    expect(step.repairNote).not.toContain("currentAnswer");
  });
  const badTrace = { ...split.details["TB-3"]!, acceptanceTests: split.details["TB-3"]!.acceptanceTests.map(test => ({ ...test, requirementIds: ["R-1"] })) };
  it("a part that still fails the assembled design's checks after one re-expansion gets a second round, within its AI_TO_BE_PART_REPAIRS", async () => {
    const h = harness({ step: (id, nth) => id === "TB-3" && nth < 3 ? badTrace : split.details[id] });
    const result = await h.run();
    expect(h.stepCount["TB-3"]).toBe(3);
    expect(result.payload.design).toEqual(rentalDraftV3);
  });
  it("re-expansion rounds are bounded: a part that never passes the assembled checks is asked 3 times, then the stage fails", async () => {
    const h = harness({ step: id => id === "TB-3" ? badTrace : split.details[id] });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(h.stepCount["TB-3"]).toBe(3);
  });
});
