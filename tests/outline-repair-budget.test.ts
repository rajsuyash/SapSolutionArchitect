import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { loadExpert } from "./support/expert-control";
import { parseEnvironment } from "../src/lib/env";
import { restoreFromPrevious } from "../src/lib/ai/outline-repair";
import { outlineRepairAllowed, runDesign, validateOutline } from "../src/lib/ai/to-be-pipeline";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const settings = (overrides: Record<string, string> = {}) => parseEnvironment({ ...local, NODE_ENV: "test",
  AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-key", ...overrides });

const step = (id: string, over: Record<string, unknown> = {}, ref: unknown = ["REF-1"]) =>
  ({ id, requirementIds: ["R-1"], asIsStepIds: ["A-1"], implementation: { kind: "STANDARD", referenceIds: ref }, ...over });
const outline = (...steps: unknown[]) => ({ processName: "p", steps });

describe("restoreFromPrevious", () => {
  const previous = (issues: { path: string; code: string }[]) => ({ value: outline(step("S-1"), step("S-2")), issues });

  it("restores list fields the repair emptied when the previous attempt was valid and did not name them", () => {
    const now = outline(step("S-1", { requirementIds: [], asIsStepIds: undefined }, []), step("S-2"));
    const { value, warnings } = restoreFromPrevious(previous([{ path: "outline.steps.1.implementation", code: "SAP_FIT_MISMATCH" }]), now);
    expect(value).toEqual(outline(step("S-1"), step("S-2")));
    expect(warnings).toEqual([
      { code: "REPAIRED_FROM_PREVIOUS_ATTEMPT", path: "outline.steps.0.requirementIds" },
      { code: "REPAIRED_FROM_PREVIOUS_ATTEMPT", path: "outline.steps.0.asIsStepIds" },
      { code: "REPAIRED_FROM_PREVIOUS_ATTEMPT", path: "outline.steps.0.implementation.referenceIds" }]);
  });
  it("leaves a field the previous attempt's issues named, and a step with a new id, alone", () => {
    const now = outline(step("S-1", { requirementIds: [] }), step("S-9", { requirementIds: [] }));
    const prev = previous([{ path: "outline.steps.0.requirementIds", code: "too_small" }]);
    expect(restoreFromPrevious(prev, now)).toEqual({ value: now, warnings: [] });
  });
  it("treats an issue on an ancestor path as naming the field, and never restores onto a usable value", () => {
    const now = outline(step("S-1", { requirementIds: [] }), step("S-2", { requirementIds: ["R-2"] }));
    expect(restoreFromPrevious(previous([{ path: "outline.steps.0", code: "X" }]), now).warnings).toEqual([]);
    expect(restoreFromPrevious(previous([]), now).value).toEqual(outline(step("S-1"), step("S-2", { requirementIds: ["R-2"] })));
  });
  it("does not refill empty referenceIds of a NEEDS_VALIDATION step", () => {
    const now = outline(step("S-1", { implementation: { kind: "NEEDS_VALIDATION", referenceIds: [] } }), step("S-2"));
    expect(restoreFromPrevious(previous([]), now).warnings).toEqual([]);
  });
});

describe("validateOutline with a previous attempt", async () => {
  const expert = await loadExpert("pump-o2c", { withRegister: true });
  const weakened = (requirementIds: string[]) => {
    const outline = structuredClone(expert.outline) as { steps: { requirementIds: string[]; implementation: { kind: string } }[] };
    outline.steps.forEach(s => { if (s.implementation.kind === "STANDARD" || s.implementation.kind === "CONFIGURATION") s.implementation.kind = "NEEDS_VALIDATION"; });
    outline.steps[0]!.requirementIds = requirementIds;
    return outline;
  };
  it("restores a step's requirementIds that the repair answer blanked, and reports it as a warning", () => {
    const good = weakened(structuredClone(expert.outline.steps[0]!.requirementIds));
    const blanked = weakened([]);
    const plain = validateOutline(expert.input, expert.references, blanked);
    const restored = validateOutline(expert.input, expert.references, blanked, { value: good, issues: [] });
    expect(restored.success).toBe(true);
    if (restored.success) expect(restored.warnings.filter(w => w.code === "REPAIRED_FROM_PREVIOUS_ATTEMPT"))
      .toEqual([{ code: "REPAIRED_FROM_PREVIOUS_ATTEMPT", path: "outline.steps.0.requirementIds" }]);
    expect(plain.success && plain.warnings.some(w => w.code === "REPAIRED_FROM_PREVIOUS_ATTEMPT")).toBe(false);
  });
});

describe("outline repair budget", () => {
  it("always allows the first repair, the second only above half of the stage budget, never beyond the maximum", () => {
    expect(outlineRepairAllowed(0, 2, 0.1)).toBe(true);
    expect(outlineRepairAllowed(1, 2, 0.51)).toBe(true);
    expect(outlineRepairAllowed(1, 2, 0.5)).toBe(false);
    expect(outlineRepairAllowed(2, 2, 1)).toBe(false);
    expect(outlineRepairAllowed(1, 1, 1)).toBe(false);
    expect(outlineRepairAllowed(0, 0, 1)).toBe(false);
  });
  it("validates AI_TO_BE_OUTLINE_REPAIRS (default 2, range 0-2)", () => {
    expect(settings().AI_TO_BE_OUTLINE_REPAIRS).toBe(2);
    expect(settings({ AI_TO_BE_OUTLINE_REPAIRS: " " }).AI_TO_BE_OUTLINE_REPAIRS).toBe(2);
    expect(settings({ AI_TO_BE_OUTLINE_REPAIRS: "0" }).AI_TO_BE_OUTLINE_REPAIRS).toBe(0);
    for (const bad of ["3", "-1", "1.5", "x"]) expect(() => settings({ AI_TO_BE_OUTLINE_REPAIRS: bad })).toThrow("AI_TO_BE_OUTLINE_REPAIRS");
  });
  const calls = async (deps: { maxOutlineRepairs?: number; remainingBudget?: () => number }) => {
    let n = 0;
    const run = runDesign({ targetProduct: "S4HANA_PRIVATE_CLOUD", discovery: { targetRelease: "2023", requirements: [], asIsSteps: [], openQuestions: [] } } as never, [], {
      ask: async () => { n++; return { processName: "invalid" }; }, invalid: () => new Error("invalid"), record: () => {}, parallelism: 1, ...deps });
    await expect(run).rejects.toThrow("invalid");
    return n;
  };
  it("makes 3 outline calls by default, 2 when the budget is spent past half, and 1 with 0 repairs", async () => {
    expect(await calls({})).toBe(3);
    expect(await calls({ remainingBudget: () => 0.4 })).toBe(2);
    expect(await calls({ maxOutlineRepairs: 1 })).toBe(2);
    expect(await calls({ maxOutlineRepairs: 0 })).toBe(1);
  });
});
describe("part repair budget (AI_TO_BE_PART_REPAIRS)", () => {
  it("validates the setting (default 2, range 0-2)", () => {
    expect(settings().AI_TO_BE_PART_REPAIRS).toBe(2);
    expect(settings({ AI_TO_BE_PART_REPAIRS: " " }).AI_TO_BE_PART_REPAIRS).toBe(2);
    expect(settings({ AI_TO_BE_PART_REPAIRS: "0" }).AI_TO_BE_PART_REPAIRS).toBe(0);
    for (const bad of ["3", "-1", "1.5", "x"]) expect(() => settings({ AI_TO_BE_PART_REPAIRS: bad })).toThrow("AI_TO_BE_PART_REPAIRS");
  });
  it("the step and register retry gate is the same rule: second retry only above half the stage budget", () => {
    expect(outlineRepairAllowed(0, 2, 0.1)).toBe(true);
    expect(outlineRepairAllowed(1, 2, 0.4)).toBe(false);
    expect(outlineRepairAllowed(1, 2, 0.6)).toBe(true);
  });
});

