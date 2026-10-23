import { describe, expect, it } from "vitest";
import { allowedKinds, applyOutlinePatch, isPatchable } from "../src/lib/ai/outline-patch";
import { repairOutlineShape } from "../src/lib/ai/outline-repair";
import { loadSapReferences } from "../src/lib/ai/sap-references";
import { OutlinePatchSchema, runDesign, type Outline } from "../src/lib/ai/to-be-pipeline";
import type { ToBeInput } from "../src/lib/ai/to-be";
import { loadExpert } from "./support/expert-control";

const issue = (path: string, code = "X") => ({ path, code });
const base = {
  steps: [{ id: "A", n: 1 }, { id: "B", n: 2 }], coverage: [{ requirementId: "R1", v: 1 }], openQuestions: [{ id: "Q1", v: 1 }],
  eliminatedAsIsSteps: [{ asIsStepId: "S1", reason: "r" }], conflictDecisions: [], processName: "P",
};

describe("applyOutlinePatch", () => {
  it("replaces by id or key in place, appends what is new, leaves every other field alone and never mutates the base", () => {
    const frozen = structuredClone(base);
    const merged = applyOutlinePatch(base, {
      steps: [{ id: "B", n: 20 }, { id: "C", n: 3 }], coverage: [{ requirementId: "R1", v: 2 }, { requirementId: "R2", v: 1 }],
      openQuestions: [{ id: "Q2", v: 1 }], eliminatedAsIsSteps: [{ asIsStepId: "S1", reason: "new" }],
    }) as typeof base;
    expect(base).toEqual(frozen);
    expect(merged.steps).toEqual([{ id: "A", n: 1 }, { id: "B", n: 20 }, { id: "C", n: 3 }]);
    expect(merged.coverage).toEqual([{ requirementId: "R1", v: 2 }, { requirementId: "R2", v: 1 }]);
    expect(merged.openQuestions).toEqual([{ id: "Q1", v: 1 }, { id: "Q2", v: 1 }]);
    expect(merged.eliminatedAsIsSteps).toEqual([{ asIsStepId: "S1", reason: "new" }]);
    expect(merged.processName).toBe("P");
  });
  it("leaves a section the patch does not name untouched, and the last of two patch items with one key wins", () => {
    const merged = applyOutlinePatch(base, { steps: [{ id: "A", n: 5 }, { id: "A", n: 6 }] }) as typeof base;
    expect(merged.steps[0]).toEqual({ id: "A", n: 6 });
    expect(merged.coverage).toBe(base.coverage);
  });
});

describe("isPatchable", () => {
  const ok = (...paths: string[]) => isPatchable(paths.map(path => issue(path)), base);
  it("accepts errors that each point into one step, coverage row, question or elimination, or name a missing As-Is mapping or coverage row", () => {
    expect(ok("outline.steps.1.implementation", "outline.steps.0", "outline.coverage.0", "outline.openQuestions.0",
      "outline.eliminatedAsIsSteps.0", "input.asIsSteps.4", "input.requirements.2")).toBe(true);
  });
  it.each([["outline"], ["outline.steps"], ["outline.coverage"], ["outline.steps.2.implementation"], ["outline.coverage.1"], ["outline.conflictDecisions.0"],
    ["input.conflicts.0"], ["to_be_outline"], ["input"]])("is global for %s", path => {
    expect(ok("outline.steps.0", path)).toBe(false);
  });
  it("is global for a cut-off answer, for no errors, and for a base that is not an outline", () => {
    expect(isPatchable([{ path: "outline.steps.0", code: "OUTPUT_TRUNCATED" }], base)).toBe(false);
    expect(isPatchable([], base)).toBe(false);
    expect(isPatchable([issue("outline.steps.0")], { steps: "x" })).toBe(false);
    expect(isPatchable([issue("outline.steps.0")], undefined)).toBe(false);
  });
});

describe("allowedKinds", () => {
  it.each([
    [["STANDARD"], ["STANDARD", "CONFIGURATION", "MANUAL", "NEEDS_VALIDATION"]],
    [["STANDARD", "CONFIGURATION"], ["CONFIGURATION", "MANUAL", "NEEDS_VALIDATION"]],
    [["STANDARD", "CONFIGURATION", "LICENSE_DEPENDENT"], ["MANUAL", "NEEDS_VALIDATION"]],
    [["STANDARD", "EXTENSION"], ["EXTENSION", "MANUAL", "NEEDS_VALIDATION"]],
    [["CONFIGURATION", "INTEGRATION", "EXTENSION"], ["EXTENSION", "INTEGRATION", "MANUAL", "NEEDS_VALIDATION"]],
    [[], ["MANUAL", "NEEDS_VALIDATION"]],
  ])("cited %j allows %j", (cited, allowed) => { expect(allowedKinds(cited)).toEqual(allowed); });
});

describe("OutlinePatchSchema", () => {
  it("is strict, needs at least one non-empty section and takes whole step objects", () => {
    expect(OutlinePatchSchema.safeParse({}).success).toBe(false);
    expect(OutlinePatchSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(OutlinePatchSchema.safeParse({ coverage: [], note: "x" }).success).toBe(false);
    expect(OutlinePatchSchema.safeParse({ steps: [{ id: "A" }] }).success).toBe(false);
    expect(OutlinePatchSchema.safeParse({ openQuestions: [{ id: "Q", question: "q", owner: "o", affectedStepIds: ["A"] }] }).success).toBe(true);
    expect(OutlinePatchSchema.safeParse({ eliminatedAsIsSteps: [{ asIsStepId: "S", reason: "r" }] }).success).toBe(true);
  });
});

describe("REPAIRED_UNKNOWN_DECISION", () => {
  const raw = (register: string[]) => ({ steps: [{ id: "A", sequence: 1, asIsStepIds: [], requirementIds: [], implementation: { referenceIds: [] } }],
    coverage: [{ requirementId: "R", disposition: "CONDITIONAL", stepIds: [], decisionId: null, decisionIds: ["D1", "DX"], questionIds: ["Q"] },
      { requirementId: "S", disposition: "IMPLEMENTED", stepIds: [], decisionId: null }],
    openQuestions: [{ id: "Q", question: "q", owner: "o", affectedStepIds: ["A"], decisionIds: ["DX"] }], eliminatedAsIsSteps: [] , register });
  const run = (register: string[]) => repairOutlineShape({ requirements: [] }, new Set(), raw(register), new Set(register));
  it("drops decision ids outside the supplied register from coverage rows and questions, reports paths only, and keeps the rest", () => {
    const out = run(["D1"]);
    const v = out.value as ReturnType<typeof raw>;
    expect(v.coverage[0]).toMatchObject({ decisionIds: ["D1"], questionIds: ["Q"] });
    expect(v.openQuestions[0]).toMatchObject({ decisionIds: [] });
    expect(out.warnings.filter(w => w.code === "REPAIRED_UNKNOWN_DECISION")).toEqual([
      { code: "REPAIRED_UNKNOWN_DECISION", path: "outline.coverage.0" }, { code: "REPAIRED_UNKNOWN_DECISION", path: "outline.openQuestions.0" }]);
  });
  it("with no register drops every decision id and leaves a CONDITIONAL row without its link for the model", () => {
    const v = run([]).value as ReturnType<typeof raw>;
    expect(v.coverage[0]).toMatchObject({ disposition: "CONDITIONAL", decisionIds: [], questionIds: ["Q"] });
    expect(v.coverage[1]).not.toHaveProperty("decisionIds");
  });
  it("does not touch decisionId (a DEFERRED or REJECTED outcome needs the supplied approval, which only the model can cite)", () => {
    const input = raw([]); (input.coverage[1] as Record<string, unknown>).disposition = "DEFERRED"; (input.coverage[1] as Record<string, unknown>).decisionId = "APPR";
    const v = repairOutlineShape({ requirements: [] }, new Set(), input, new Set()).value as typeof input;
    expect(v.coverage[1]).toMatchObject({ decisionId: "APPR" });
  });
});

describe("runDesign: a patch for path-attributable outline errors", async () => {
  const expert = await loadExpert("pump-o2c", { withRegister: true });
  const input: ToBeInput = { ...expert.input, targetProduct: "S4HANA_CLOUD_PRIVATE", discovery: { ...expert.input.discovery, targetRelease: "2023" } };
  const catalog = await loadSapReferences(input.targetProduct, "2023");
  const standard = catalog.find(r => r.fitType === "STANDARD")!;
  const stop = () => { throw new Error("outline phase only"); };
  /** The expert outline with its unevidenced STANDARD / CONFIGURATION claims weakened: valid after the server's repairs. */
  const good = () => {
    const outline = structuredClone(expert.outline) as Outline;
    for (const step of outline.steps) if (step.implementation.kind === "STANDARD" || step.implementation.kind === "CONFIGURATION") step.implementation = { kind: "NEEDS_VALIDATION", referenceIds: [] };
    return outline;
  };
  /** Step 3 claims INTEGRATION while citing only a STANDARD reference: SAP_FIT_MISMATCH at outline.steps.2.implementation. */
  const mismatched = () => {
    const outline = good();
    outline.steps[2]!.implementation = { kind: "INTEGRATION", referenceIds: [standard.id] };
    return outline;
  };
  function drive(answers: { outline: (n: number) => unknown; patch?: (n: number) => unknown }) {
    const asked: string[] = [], requests: Record<string, unknown>[] = [], recorded: string[] = [];
    let outlines = 0, patches = 0;
    const result = runDesign(input, catalog, {
      parallelism: 1, invalid: () => new Error("invalid"), record: issues => { recorded.push(...issues.map(issue => `${issue.code}@${issue.path}`)); }, maxOutlineRepairs: 2,
      ask: async (substage, request, target) => {
        asked.push(target ? `${substage}:${target}` : substage); requests.push(request as Record<string, unknown>);
        if (substage !== "to_be_outline") return stop(); // the outline was accepted: the expansion is not under test
        return target === "patch" ? answers.patch!(++patches) : answers.outline(++outlines);
      },
    });
    return { result, get asked() { return asked.filter(call => call.startsWith("to_be_outline")); }, requests, recorded };
  }

  it("asks for a patch, not a whole outline, tells the model the allowed kinds, and merges the patch onto the last outline", async () => {
    const fixedStep = { ...good().steps[2]!, implementation: { kind: "STANDARD", referenceIds: [standard.id] } };
    const run = drive({ outline: () => mismatched(), patch: () => ({ steps: [fixedStep] }) });
    await expect(run.result).rejects.toThrow("outline phase only"); // reached the step calls: the merged outline validated
    expect(run.asked).toEqual(["to_be_outline", "to_be_outline:patch"]);
    const request = run.requests[1]!;
    expect(request.outline).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: fixedStep.id })]) });
    // The flagged step travels in full; every other step is reduced to ids, links and kinds, and the process name is left out.
    const sent = request.outline as { steps: Record<string, unknown>[] };
    expect(sent.steps[2]).toHaveProperty("title");
    expect(sent.steps.filter((_, i) => i !== 2).some(step => "title" in step || "purpose" in step)).toBe(false);
    expect(request.outline).not.toHaveProperty("processName");
    expect(request.validationErrors).toEqual([expect.objectContaining({ code: "SAP_FIT_MISMATCH", path: "outline.steps.2.implementation" })]);
    const note = String(request.repairNote);
    expect(note).toContain(`step "${fixedStep.id}"`);
    expect(note).toContain("cited fit types STANDARD");
    expect(note).toContain("allowed kinds: STANDARD, CONFIGURATION, MANUAL, NEEDS_VALIDATION");
  });

  it("falls back to a whole new outline when any error is global, and when the base is a cut-off answer", async () => {
    const global = { ...mismatched(), coverage: "x" };
    const run = drive({ outline: n => n === 1 ? global : good() });
    await expect(run.result).rejects.toThrow("outline phase only");
    expect(run.asked).toEqual(["to_be_outline", "to_be_outline"]);
  });

  it("a patch that leaves the error unfixed spends another repair and the next patch is built on the merged outline", async () => {
    const still = { ...good().steps[2]!, implementation: { kind: "INTEGRATION", referenceIds: [standard.id] } };
    const run = drive({ outline: () => mismatched(), patch: n => ({ steps: [n === 1 ? still : { ...still, implementation: { kind: "NEEDS_VALIDATION", referenceIds: [] } }] }) });
    await expect(run.result).rejects.toThrow("outline phase only");
    expect(run.asked).toEqual(["to_be_outline", "to_be_outline:patch", "to_be_outline:patch"]);
  });

  it("a patch answer that fails its schema is a failed repair and the base outline stays the reference", async () => {
    const run = drive({ outline: () => mismatched(), patch: n => n === 1 ? { steps: "nope" } : { steps: [{ ...good().steps[2]!, implementation: { kind: "MANUAL", referenceIds: [] } }] } });
    await expect(run.result).rejects.toThrow("outline phase only");
    expect(run.asked).toEqual(["to_be_outline", "to_be_outline:patch", "to_be_outline:patch"]);
  });
});
