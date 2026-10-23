import { describe, expect, it } from "vitest";
import { loadSapReferences } from "../src/lib/ai/sap-references";
import { runDesign, validateOutline, assemble, attributeErrors, type Outline } from "../src/lib/ai/to-be-pipeline";
import { toBeContext, validateToBeOutput, type ToBeInput } from "../src/lib/ai/to-be";
import { evaluateDesign } from "../src/lib/ai/design-quality";
import { loadExpert } from "./support/expert-control";

const codes = (errors: { code: string }[]) => [...new Set(errors.map(e => e.code))].sort();
const fail = () => { throw new Error("outline phase only"); };

describe("validators against the hand-written expert control (pump-o2c, the input --tobe-only builds)", async () => {
  const expert = await loadExpert("pump-o2c", { withRegister: true });
  const details = new Map(Object.entries(expert.details));

  it("builds the eval's input: public cloud 2023 has no catalog, so no verified references (this case measures the no-catalog path)", () => {
    expect(expert.input.targetProduct).toBe("S4HANA_CLOUD_PUBLIC");
    expect(expert.input.discovery.targetRelease).toBe("2023");
    expect(expert.references).toEqual([]);
    expect(expert.input.discovery.requirements).toHaveLength(16);
    expect(expert.input.discovery.asIsSteps.map(s => s.id)).toContain("st_as_is_11");
  });

  it("the unrepaired expert design fails the strict checks the model is held to", () => {
    const result = validateToBeOutput(expert.input, expert.design, expert.references);
    expect(result.success).toBe(false);
    if (!result.success) expect(codes(result.errors)).toEqual(
      // The control's step text also cites GAP-04, -06, -08 and -10, rows its register does not carry: DANGLING_ID_REFERENCE, a fixable blocker (see below), not an error.
      ["AS_IS_DISPOSITION_CONFLICT", "AS_IS_TRACE_MISMATCH", "CRITICAL_REQUIREMENT_UNTESTED", "SAP_APPLICABILITY_UNVERIFIED"]);
  });

  /** The control claims STANDARD/CONFIGURATION for two steps while citing no reference. With no catalog that claim is unevidenced,
   * and the check is right to reject it (fail closed, never relabelled by the server). */
  const claimed = () => structuredClone(expert.outline) as Outline;
  const weakened = () => ({ ...claimed(), steps: claimed().steps.map(step => step.implementation.kind === "STANDARD" || step.implementation.kind === "CONFIGURATION"
    ? { ...step, implementation: { ...step.implementation, kind: "NEEDS_VALIDATION" as const } } : step) });

  it("the expert outline fails only on the two unevidenced SAP claims once the server repairs the slips it makes", () => {
    const result = validateOutline(expert.input, expert.references, expert.outline);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.map(e => `${e.code}@${e.path}`)).toEqual([
      "SAP_APPLICABILITY_UNVERIFIED@outline.steps.3.implementation", "SAP_APPLICABILITY_UNVERIFIED@outline.steps.5.implementation"]);
  });

  it("with those claims weakened the outline validates, and every repair is reported", () => {
    const result = validateOutline(expert.input, expert.references, weakened());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(codes(result.warnings)).toEqual(["REPAIRED_AS_IS_DISPOSITION", "REPAIRED_AS_IS_TRACE"]);
    expect(result.warnings.filter(w => w.code === "REPAIRED_AS_IS_TRACE")).toHaveLength(7);
  });

  it("the assembled expert design keeps only the genuine defect: critical requirements a listing step never tests", () => {
    const outline = validateOutline(expert.input, expert.references, weakened());
    if (!outline.success) throw new Error("outline");
    const design = assemble(outline.outline, details);
    const result = validateToBeOutput(expert.input, design, expert.references);
    expect(result.success).toBe(false);
    if (result.success) return;
    // The genuine defect is the untested critical requirements; the four dangling GAP-nn citations are text heuristics, so they are no longer errors.
    expect(result.errors.filter(e => e.code === "DANGLING_ID_REFERENCE")).toHaveLength(0);
    const untested = result.errors.filter(e => e.code === "CRITICAL_REQUIREMENT_UNTESTED");
    expect(untested).toHaveLength(2);
    expect(result.errors).toHaveLength(2);
    expect(evaluateDesign(toBeContext(expert.input, expert.references), design).blockers.filter(b => b.code === "DANGLING_ID_REFERENCE")).toHaveLength(4);
    const { byStep } = attributeErrors(untested, design);
    expect([...byStep.keys()].sort()).toEqual(["O2C-ORD-030", "O2C-QTE-010", "O2C-RPT-110"]); // steps that list rq_otif / rq_dso without a test citing it
  });

  it("without the decision register the expert's DEC ids are an input mismatch, not a check defect", () => {
    const noRegister: ToBeInput = { ...expert.input }; delete noRegister.decisionRegister;
    const result = validateToBeOutput(noRegister, expert.design, expert.references);
    expect(result.success).toBe(false);
    if (!result.success) expect(codes(result.errors)).toContain("UNKNOWN_DECISION");
  });
});

describe("a realistic imperfect outline", async () => {
  const expert = await loadExpert("pump-o2c", { withRegister: true });
  const catalogInput: ToBeInput = { ...expert.input, targetProduct: "S4HANA_CLOUD_PRIVATE", discovery: { ...expert.input.discovery, targetRelease: "2023" } };
  const catalog = await loadSapReferences(catalogInput.targetProduct, "2023");
  const standard = catalog.find(r => r.fitType === "STANDARD")!, extension = catalog.find(r => r.fitType === "EXTENSION")!;

  /** The expert outline with the slips a model typically makes (indices are into expert.outline). */
  function slipped() {
    const outline = structuredClone(expert.outline) as Outline;
    const stepOf = (id: string) => outline.steps.find(s => s.id === id)!;
    const coverageOf = (id: string) => outline.coverage.find(c => c.requirementId === id)!;
    // rq_mto is implemented by two steps but coverage names only one; rq_serial's coverage row has no steps at all.
    coverageOf("rq_mto").stepIds = ["O2C-PRD-040"];
    coverageOf("rq_serial").stepIds = [];
    // a step with no requirementIds although coverage names it for rq_interplant; duplicated ids; wrong sequence
    stepOf("O2C-DLV-070").requirementIds = [];
    stepOf("O2C-ORD-020").requirementIds = [...stepOf("O2C-ORD-020").requirementIds, "rq_credit", "rq_credit"];
    stepOf("O2C-RET-090").sequence = 42;
    // a reference that is not in the catalog, and one that is but cannot support the STANDARD claim
    stepOf("O2C-PRD-040").implementation = { kind: "STANDARD", referenceIds: ["REF-INVENTED", standard.id] };
    stepOf("O2C-DLV-060").implementation = { kind: "NEEDS_VALIDATION", referenceIds: [] };
    stepOf("O2C-PRD-050").implementation = { kind: "NEEDS_VALIDATION", referenceIds: [] };
    // an open question that names no step but is linked from a coverage row
    outline.openQuestions.push({ id: "Q-NEW", question: "Who owns the gate-pass rule?", owner: "Plant head", affectedStepIds: [] });
    coverageOf("rq_returns").questionIds = ["Q-NEW"];
    return outline;
  }

  it("repairs each slip deterministically and reports it", () => {
    const raw = slipped(), before = structuredClone(raw);
    const result = validateOutline(catalogInput, catalog, raw);
    expect(raw).toEqual(before); // the model's payload is never mutated
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { outline, warnings } = result;
    const stepsOf = (requirementId: string) => outline.steps.filter(s => s.requirementIds.includes(requirementId)).map(s => s.id);
    expect(outline.coverage.find(c => c.requirementId === "rq_mto")!.stepIds).toEqual(stepsOf("rq_mto"));
    expect(stepsOf("rq_mto")).toHaveLength(2);
    expect(outline.coverage.find(c => c.requirementId === "rq_serial")!.stepIds).toEqual(stepsOf("rq_serial"));
    expect(outline.steps.find(s => s.id === "O2C-DLV-070")!.requirementIds).toEqual(["rq_interplant"]);
    expect(outline.steps.find(s => s.id === "O2C-ORD-020")!.requirementIds.filter(r => r === "rq_credit")).toHaveLength(1);
    expect(outline.steps.map(s => s.sequence)).toEqual(outline.steps.map((_, i) => i + 1));
    expect(outline.openQuestions.find(q => q.id === "Q-NEW")!.affectedStepIds).toEqual(stepsOf("rq_returns"));
    const unknown = outline.steps.find(s => s.id === "O2C-PRD-040")!.implementation;
    expect(unknown.referenceIds).toEqual([standard.id]);
    expect(unknown.kind).toBe("STANDARD"); // the surviving catalog reference still supports it; the kind is never relabelled
    expect(codes(warnings)).toEqual(expect.arrayContaining(["REPAIRED_COVERAGE_STEPS", "REPAIRED_STEP_REQUIREMENTS", "REPAIRED_DUPLICATE_TRACE",
      "REPAIRED_SEQUENCE", "REPAIRED_QUESTION_STEPS", "REPAIRED_UNKNOWN_REFERENCE"]));
    expect(JSON.stringify(warnings)).not.toMatch(/gate-pass|REF-INVENTED/); // paths and codes only, never model text
    // the repaired outline is a fixed point: validating it again reports nothing to repair except what still needs the as-is trace
    const again = validateOutline(catalogInput, catalog, outline);
    expect(again.success).toBe(true);
    if (again.success) expect(codes(again.warnings)).not.toContain("REPAIRED_COVERAGE_STEPS");
  });

  it("fails closed on a claim that rests on an invented reference, and raises a kind a verified reference outranks", () => {
    const only = slipped();
    only.steps.find(s => s.id === "O2C-PRD-040")!.implementation = { kind: "STANDARD", referenceIds: ["REF-INVENTED"] };
    const invented = validateOutline(catalogInput, catalog, only);
    expect(invented.success).toBe(false);
    if (!invented.success) expect(codes(invented.errors)).toContain("UNKNOWN_REFERENCE");
    const mismatch = slipped();
    mismatch.steps.find(s => s.id === "O2C-DLV-060")!.implementation = { kind: "STANDARD", referenceIds: [standard.id, extension.id] };
    const result = validateOutline(catalogInput, catalog, mismatch);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outline.steps.find(s => s.id === "O2C-DLV-060")!.implementation.kind).toBe("EXTENSION");
      expect(result.warnings).toContainEqual({ code: "REPAIRED_FIT_KIND", path: expect.stringMatching(/^outline\.steps\.\d+\.implementation$/) });
    }
  });

  it("does not invent: what it cannot derive still fails and goes to the model", () => {
    const raw = slipped();
    // no step lists rq_close and coverage names none: nothing to derive the trace from
    for (const step of raw.steps) step.requirementIds = step.requirementIds.filter(r => r !== "rq_close");
    raw.coverage.find(c => c.requirementId === "rq_close")!.stepIds = [];
    // a question with no affected steps and no coverage link
    raw.openQuestions.push({ id: "Q-ORPHAN", question: "Orphan?", owner: "Owner", affectedStepIds: [] });
    const result = validateOutline(catalogInput, catalog, raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.map(e => e.code)).toEqual(["INVALID_DRAFT"]); // schema first: the orphan question
    }
    raw.openQuestions.pop();
    const second = validateOutline(catalogInput, catalog, raw);
    expect(second.success).toBe(false);
    if (!second.success) expect(codes(second.errors)).toEqual(["COVERAGE_TRACE_MISMATCH", "CRITICAL_REQUIREMENT_UNTESTED"]);
  });

  it("runDesign repairs in place: one outline call, repairs recorded as warnings, no model repair spent", async () => {
    const asked: string[] = [], warned: string[] = [];
    await expect(runDesign(catalogInput, catalog, {
      parallelism: 1, invalid: () => new Error("invalid"), record: () => undefined, warn: issues => warned.push(...issues.map(i => i.code)),
      ask: async substage => { asked.push(substage); return substage === "to_be_outline" ? slipped() : fail(); },
    })).rejects.toThrow("outline phase only");
    expect(asked.filter(s => s === "to_be_outline")).toHaveLength(1);
    expect(warned).toContain("REPAIRED_COVERAGE_STEPS");
  });
});
