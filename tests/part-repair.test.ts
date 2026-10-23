import { describe, expect, it } from "vitest";
import { repairRegisterGroup, repairStepBody } from "../src/lib/ai/part-repair";
import { normalizeToolInput } from "../src/lib/ai/tool-input-normalizer";
import { StepDetailSchema } from "../src/lib/ai/to-be-pipeline";
import { RegisterGroupSchemas } from "../src/lib/ai/design-registers";
import { REVIEW_FINDINGS } from "../src/lib/consultant-report";
import { rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";

const refs = { requirementIds: new Set(["R-1", "R-2"]), stepIds: new Set(["TB-1", "TB-2"]), decisionIds: new Set(["D-1"]) };

describe("repairStepBody", () => {
  it("drops decision ids that are not in the register and reports the step path", () => {
    const out = repairStepBody({ actor: "x", decisionIds: ["D-1", "D-9"] }, new Set(["D-1"]), "draft.steps.3");
    expect(out.value).toEqual({ actor: "x", decisionIds: ["D-1"] });
    expect(out.warnings).toEqual([{ code: "REPAIRED_UNKNOWN_DECISION", path: "draft.steps.3" }]);
  });
  it("with no register every decision id is unknown", () => {
    expect(repairStepBody({ decisionIds: ["D-1"] }, new Set(), "p").value).toEqual({ decisionIds: [] });
  });
  it("leaves a body with valid or no decision ids untouched", () => {
    const body = { decisionIds: ["D-1"] };
    expect(repairStepBody(body, new Set(["D-1"]), "p")).toEqual({ value: body, warnings: [] });
    expect(repairStepBody({ a: 1 }, new Set(), "p").warnings).toEqual([]);
  });
});

describe("repairRegisterGroup", () => {
  const governance = () => structuredClone(rentalRegisterGroups.governance) as unknown as Record<string, Record<string, unknown>[]>;
  const real = { requirementIds: new Set(["R-1", "R-2", "R-3", "R-4", "R-5", "R-6"]), stepIds: new Set(["TB-1", "TB-2", "TB-3"]), decisionIds: new Set<string>() };
  it("leaves a group whose ids are all valid exactly as it is", () => {
    const out = repairRegisterGroup(governance(), real);
    expect(out.warnings).toEqual([]); expect(out.value).toEqual(rentalRegisterGroups.governance);
  });
  it("drops an invented requirement id and step id from a row's lists, keeping the valid ones", () => {
    const rows = [{ id: "OBJ-1", statement: "s", measure: "m", requirementIds: ["R-1", "R-99"], contextFieldIds: [], stepIds: ["TB-1", "TB-99"] }];
    const out = repairRegisterGroup({ objectives: rows }, refs);
    expect(out.value).toEqual({ objectives: [{ ...rows[0], requirementIds: ["R-1"], stepIds: ["TB-1"] }] });
    expect(out.warnings).toEqual([{ code: "REPAIRED_UNKNOWN_REF", path: "draft.objectives.0" }]);
  });
  const mapping = (id: string, requirementId: string) => ({ id, requirementId, mechanism: "AUTHORIZATION", realization: "r", stepIds: ["TB-1"], ruleId: null });
  it("drops a control mapping and a fit-gap row whose only requirement is unknown, and keeps the others", () => {
    const g = { ...governance(), controlMappings: [mapping("CM-1", "R-1"), mapping("CM-X", "R-99"), mapping("CM-2", "R-2")] };
    const out = repairRegisterGroup(g, real);
    expect((out.value as typeof g).controlMappings.map(row => row.id)).toEqual(["CM-1", "CM-2"]);
    expect(out.warnings).toEqual([{ code: "REPAIRED_DROPPED_ROW", path: "draft.controlMappings.1" }]);
    const fit = repairRegisterGroup({ fitGap: [{ requirementId: "R-1", stepIds: ["TB-9"] }, { requirementId: "R-77", stepIds: [] }] }, refs);
    expect(fit.value).toEqual({ fitGap: [{ requirementId: "R-1", stepIds: [] }] });
    expect(fit.warnings.map(w => `${w.code}@${w.path}`)).toEqual(["REPAIRED_UNKNOWN_REF@draft.fitGap.0", "REPAIRED_DROPPED_ROW@draft.fitGap.1"]);
  });
  it("drops an unknown role from an assessment but never empties a list the schema requires (the model gets the UNKNOWN_ROLE error)", () => {
    const g = governance();
    g.sodAssessments![0] = { ...g.sodAssessments![0]!, roleIds: [...(g.sodAssessments![0]!.roleIds as string[]), "ROLE-99"] };
    const partial = repairRegisterGroup(g, real);
    expect((partial.value as typeof g).sodAssessments![0]!.roleIds).toEqual(rentalRegisterGroups.governance.sodAssessments[0]!.roleIds);
    expect(partial.warnings).toEqual([{ code: "REPAIRED_UNKNOWN_REF", path: "draft.sodAssessments.0" }]);
    const all = governance();
    all.sodAssessments![0] = { ...all.sodAssessments![0]!, roleIds: ["ROLE-99"] };
    const kept = repairRegisterGroup(all, real);
    expect(kept.warnings).toEqual([]); expect((kept.value as typeof g).sodAssessments![0]!.roleIds).toEqual(["ROLE-99"]);
  });
  it("without input requirements there is nothing to compare, so requirement links stay", () => {
    const rows = [{ requirementIds: ["R-99"] }];
    expect(repairRegisterGroup({ reports: rows }, { ...refs, requirementIds: new Set() }).warnings).toEqual([]);
  });
  it("is not fooled by a non-object payload", () => {
    expect(repairRegisterGroup("x", refs)).toEqual({ value: "x", warnings: [] });
  });
  it("the repaired governance group parses and no longer cites the invented requirement", () => {
    const g = { ...governance(), controlMappings: [mapping("CM-X", "R-99"), mapping("CM-1", "R-1")] };
    const repaired = repairRegisterGroup(g, real).value;
    expect(RegisterGroupSchemas.governance.safeParse(repaired).success).toBe(true);
    expect(JSON.stringify(repaired)).not.toContain("R-99");
  });
});

describe("enum synonyms in the normaliser", () => {
  const step = (stepType: unknown) => normalizeToolInput(StepDetailSchema, { stepType }, "draft.steps.7");
  it("fixes case, spaces and hyphens and a listed synonym, with a REPAIRED_ENUM_SYNONYM warning at the field", () => {
    for (const [sent, wanted] of [["automatic", "AUTOMATIC"], ["In-System Manual", "IN_SYSTEM_MANUAL"], ["outside system", "OUTSIDE_SYSTEM"],
      ["AUTOMATED", "AUTOMATIC"], ["Manual in system", "IN_SYSTEM_MANUAL"], ["INTERFACE", "INTEGRATION"]]) {
      const out = step(sent);
      expect(out.value, sent).toEqual({ stepType: wanted });
      expect(out.warnings, sent).toEqual([{ code: "REPAIRED_ENUM_SYNONYM", path: "draft.steps.7.stepType" }]);
    }
  });
  it("leaves a valid value, an ambiguous word (MANUAL) and an unknown value (NEEDS_VALIDATION) alone, to fail validation", () => {
    for (const sent of ["AUTOMATIC", "MANUAL", "NEEDS_VALIDATION", "", 7]) {
      const out = step(sent);
      expect(out.value).toEqual({ stepType: sent }); expect(out.warnings).toEqual([]);
    }
  });
  it("a synonym applies only where its target is an allowed value of that enum", () => {
    // INTEGRATION is valid for an implementation kind and a step type; the fit-gap class has no such value, and INTEGRATION is not guessed there.
    const out = normalizeToolInput(RegisterGroupSchemas.fitgap, { fitGap: [{ classification: "INTEGRATION", ricefwType: "interface" }] }, "draft");
    expect(out.value).toEqual({ fitGap: [{ classification: "INTEGRATION", ricefwType: "INTERFACE" }] });
    expect(out.warnings).toEqual([{ code: "REPAIRED_ENUM_SYNONYM", path: "draft.fitGap.0.ricefwType" }]);
  });
});

describe("review finding text", () => {
  it("explains SOD_CONFLICT_STEPS", () => { expect(REVIEW_FINDINGS.SOD_CONFLICT_STEPS).toMatch(/fewer than two steps/); });
});
