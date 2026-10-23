import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { evaluateDesign, DetailedDesignSchema } from "../src/lib/ai/design-quality";
import { toBeContext, parseToBeInput } from "../src/lib/ai/to-be";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV2, rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { REGISTER_GROUP_NAMES, type RegisterGroup } from "../src/lib/ai/design-registers";
import { asStream } from "./support/sse";
import { fixture, withCompanyContext } from "./support/to-be-input";
import { registerGroupOf, splitDesign, stepIdOf, toolOf, toolResponse, type RequestBody } from "./support/to-be-split";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const settings = (overrides: Record<string, string> = {}) => parseEnvironment({ ...local, NODE_ENV: "test",
  AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-split-key", ...overrides });
const split = splitDesign(rentalDraft);
const STEP_IDS = rentalDraft.steps.map(step => step.id);

type Handlers = {
  outline?: (nth: number, body: RequestBody) => unknown | Promise<unknown>;
  step?: (id: string, nth: number, body: RequestBody) => unknown | Promise<unknown>;
  registers?: (group: RegisterGroup, nth: number, body: RequestBody) => unknown | Promise<unknown>;
  overrides?: Record<string, string>;
};
/** A fake provider that answers by requested tool and records every request and the in-flight high-water mark. */
function harness(handlers: Handlers = {}) {
  const outlineCalls: RequestBody[] = [], stepCalls: { id: string; body: RequestBody; signal: AbortSignal | null | undefined }[] = [];
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
  return { run, fetch, outlineCalls, stepCalls, stepCount, registerCalls, registerCount, max: () => maxInFlight };
}
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

describe("skeleton-then-expansion assembly", () => {
  it("assembles the outline and N step stubs into a design that passes evaluateDesign", async () => {
    const h = harness();
    const result = await h.run();
    const design = result.payload.design;
    expect(DetailedDesignSchema.safeParse(design).success).toBe(true);
    expect(evaluateDesign(toBeContext(parseToBeInput(fixture())), design)).toMatchObject({ structurallyValid: true, errors: [] });
    expect(design).toEqual(rentalDraftV2);
    expect(result.payload.evaluation.structurallyValid).toBe(true);
    expect(h.outlineCalls).toHaveLength(1);
    expect(h.stepCalls.map(call => call.id).sort()).toEqual([...STEP_IDS].sort());
    expect(h.registerCalls.map(call => call.group).sort()).toEqual([...REGISTER_GROUP_NAMES].sort());
    expect(result.metrics).toMatchObject({ stage: "to_be", attempts: 8, inputTokens: 800, outputTokens: 1600,
      substages: { to_be_outline: { calls: 1, inputTokens: 100, outputTokens: 200 }, to_be_step: { calls: 3, inputTokens: 300, outputTokens: 600 },
        to_be_registers: { calls: 4, inputTokens: 400, outputTokens: 800 } } });
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
    expect(h.registerCalls).toHaveLength(4);
    const repair = h.stepCalls.filter(call => call.id === "TB-2")[1]!.body.messages[0]!.content;
    expect(repair).toContain("INVALID_DRAFT");
    expect(repair).not.toContain("private-invalid-model-output");
    expect(result.payload.design).toEqual(rentalDraftV2);
    expect(result.metrics.attempts).toBe(9);
    expect(result.metrics.substages!.to_be_step!.calls).toBe(4);
  });
  it("re-requests only the step that a post-assembly check attributes the error to", async () => {
    const bad = { ...split.details["TB-3"]!, acceptanceTests: split.details["TB-3"]!.acceptanceTests.map(test => ({ ...test, requirementIds: ["R-1"] })) };
    const h = harness({ step: (id, nth) => id === "TB-3" && nth === 1 ? bad : split.details[id] });
    const result = await h.run();
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 1, "TB-3": 2 });
    expect(h.stepCalls.filter(call => call.id === "TB-3")[1]!.body.messages[0]!.content).toContain("TEST_TRACE_MISMATCH");
    expect(result.payload.design).toEqual(rentalDraftV2);
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
    expect(result.payload.design).toEqual(rentalDraftV2);
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
    expect(result.payload.design).toEqual(rentalDraftV2);
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
    referenceIds: [], needsValidation: true, validationReason: "Confirm the app", requirementIds: [], contextFieldIds: ["kpi_targets"], stepIds: ["TB-1"] }];
  const registers = (group: RegisterGroup) => group === "integration" ? { ...rentalRegisterGroups.integration, kpis: kpiRows } : rentalRegisterGroups[group];

  it("sends the answered fields to the outline call and to every register call, whole", async () => {
    const h = harness({ registers: group => registers(group) });
    await h.run(input());
    const outline = JSON.parse(h.outlineCalls[0]!.messages[0]!.content).input.discovery.companyContext as { fieldId: string; value: string; evidence: unknown }[];
    expect(outline.map(item => item.fieldId)).toEqual(["operating_scale", "approval_rules", "kpi_targets"]);
    expect(outline[0]!.value).toBe(long);
    expect(h.registerCalls).toHaveLength(4);
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
    expect(h.registerCount).toEqual({ decisions: 1, fitgap: 2, foundation: 1, integration: 1 });
    expect(h.stepCalls).toHaveLength(3);
    expect(h.outlineCalls).toHaveLength(1);
    const repair = h.registerCalls.filter(call => call.group === "fitgap")[1]!.body.messages[0]!.content;
    expect(repair).toContain("INVALID_DRAFT");
    expect(repair).toContain("draft.fitGap.0");
    expect(repair).not.toContain("private-register-output");
    expect(result.payload.design).toEqual(rentalDraftV2);
  });
  it("fails with AI_INVALID_OUTPUT when a register group is still invalid after its retry", async () => {
    const h = harness({ registers: group => group === "decisions" ? { oops: true } : rentalRegisterGroups[group] });
    await expect(h.run()).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(h.registerCount.decisions).toBe(2);
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
      validationReason: "Confirm the API", requirementIds: [], contextFieldIds: ["retained_systems"], stepIds: ["TB-1"] }));
    const h = harness({ registers: (group, nth) => group !== "integration" ? rentalRegisterGroups[group]
      : { interfaces: nth === 1 ? rows.slice(0, 1) : rows, kpis: [] } });
    const result = await h.run(withRetained);
    expect(h.registerCount.integration).toBe(2);
    expect(h.registerCalls.filter(call => call.group === "integration")[1]!.body.messages[0]!.content).toContain("RETAINED_SYSTEM_UNCOVERED");
    expect(result.payload.design.interfaces).toHaveLength(2);
  });
  it("sends an SAP object outside the catalog back to the step that named it, with the token", async () => {
    const h = harness({ step: (id, nth) => id === "TB-2" && nth === 1
      ? { ...split.details[id], effects: { ...split.details[id]!.effects, financial: "Post with movement type 777 and Fiori app F9999." } } : split.details[id] });
    const result = await h.run();
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 2, "TB-3": 1 });
    expect(h.registerCalls).toHaveLength(4);
    const repair = h.stepCalls.filter(call => call.id === "TB-2")[1]!.body.messages[0]!.content;
    expect(repair).toContain("UNKNOWN_SAP_OBJECT");
    expect(repair).toContain("draft.steps.1.effects.financial");
    expect(repair).toContain("F9999");
    expect(result.payload.design).toEqual(rentalDraftV2);
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
    expect(error).toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 2, stopReasons: ["max_tokens", "max_tokens"] } });
    expect(error.metrics.attemptIssues).toEqual([[{ path: "to_be_outline", code: "OUTPUT_TRUNCATED" }], [{ path: "to_be_outline", code: "OUTPUT_TRUNCATED" }]]);
    expect(error.metrics.substages.to_be_outline.calls).toBe(2);
    const first = h.outlineCalls[0]!.messages[0]!.content, repair = h.outlineCalls[1]!.messages[0]!.content;
    expect(first).not.toContain("repairNote");
    expect(repair).toContain("OUTPUT_TRUNCATED"); expect(repair).toContain("cut off"); expect(repair).toContain("more concisely");
    expect(repair).not.toContain("private-cut-off-text");
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
