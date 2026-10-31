import { describe, expect, it } from "vitest";
import { evaluateDesign, type DetailedDesign } from "../src/lib/ai/design-quality";
import { danglingIdHits } from "../src/lib/ai/design-text-lint";
import { rentalContext } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";

const design = (change: (draft: DetailedDesign) => void) => { const draft = structuredClone(rentalDraftV3); change(draft); return draft; };
const dangling = (draft: DetailedDesign, context = rentalContext) =>
  evaluateDesign(context, draft).blockers.filter(item => item.code === "DANGLING_ID_REFERENCE").map(item => `${item.path} ${item.detail}`);

describe("DANGLING_ID_REFERENCE: an id the text cites in this design's own id pattern that does not exist", () => {
  it("the fixture, which cites only ids it has, has none", () => {
    expect(dangling(rentalDraftV3)).toEqual([]);
  });
  it("flags a step id, a rule id and an open question id in step text, at the step, naming the token", () => {
    expect(dangling(design(draft => { draft.steps[0]!.effects.financial = "Billing follows TB-9 once the hire order closes."; }))).toEqual(["draft.steps.0 TB-9 does not exist in this design"]);
    expect(dangling(design(draft => { draft.steps[1]!.businessRules[0]!.response = "Apply rule BR-7 before posting."; }))).toEqual(["draft.steps.1 BR-7 does not exist in this design"]);
    expect(dangling(design(draft => { draft.steps[2]!.addedValue = "The open policy is held on question Q-4."; }))).toEqual(["draft.steps.2 Q-4 does not exist in this design"]);
  });
  it("flags a sub-id of a question the design never defined (Q-1-F1), as the same family, and accepts the real ids around it", () => {
    expect(dangling(design(draft => { draft.steps[0]!.effects.financial = "The release act is held under Q-1-F1."; }))).toEqual(["draft.steps.0 Q-1-F1 does not exist in this design"]);
    expect(dangling(design(draft => { draft.steps[0]!.effects.financial = "The release act is held under Q-1."; }))).toEqual([]);
  });
  it("flags it in an open question and in a register row", () => {
    expect(dangling(design(draft => { draft.openQuestions[0]!.question += " See also Q-12."; }))).toEqual(["draft.openQuestions.0 Q-12 does not exist in this design"]);
    expect(dangling(design(draft => { draft.reports![0]!.purpose += " Follows decision KDD-7."; }))).toEqual(["draft.reports.0 KDD-7 does not exist in this design"]);
  });
  it("accepts every id that exists: steps, rules, tests, questions, register rows, requirements, input ids", () => {
    const ok = design(draft => { draft.steps[0]!.effects.financial = "See TB-2, BR-3, TEST-4, Q-1, KDD-1, R-1 and the rows ROLE-1 and DSM-1 for the whole picture."; });
    expect(dangling(ok)).toEqual([]);
  });
  it("cites of the decision register count as own ids", () => {
    const context = { ...rentalContext, decisionRegister: [{ id: "DEC-1" }] };
    expect(dangling(design(draft => { draft.steps[0]!.effects.financial = "Subject to DEC-1."; }), context)).toEqual([]);
    expect(dangling(design(draft => { draft.steps[0]!.effects.financial = "Subject to DEC-2."; }), context)).toEqual(["draft.steps.0 DEC-2 does not exist in this design"]);
  });
  it("never matches SAP codes, release names or standards: only a family the design itself uses counts", () => {
    const text = "Use movement type 101, document type ZOR, condition type PR00, Fiori app F0842, transaction VA01, ME21N, scope item 1Y2, BAPI_SALESORDER_CREATE, "
      + "release 2023 FPS-02, ISO-8601 dates, MM-01, S4-1, XTB-9, tb-9, TB9, plant 1710-20, SD-BIL-3 and order 4500001234-10.";
    expect(dangling(design(draft => { draft.steps[0]!.effects.financial = text; }))).toEqual([]);
  });
  it("is reported once per element and token, and ignores id fields", () => {
    const twice = design(draft => { draft.steps[0]!.effects.financial = "TB-9 then TB-9 again, and Q-8."; });
    expect(dangling(twice)).toEqual(["draft.steps.0 TB-9 does not exist in this design", "draft.steps.0 Q-8 does not exist in this design"]);
    const idsOnly = design(draft => { draft.steps[0]!.decisionIds = ["TB-9"]; });
    expect(dangling(idsOnly)).toEqual([]); // a bad id in an id field is another check's error
  });
  it("is a heuristic blocker, not a structural error: the design stays valid but BLOCKED (the fix pass sends the part back)", () => {
    const result = evaluateDesign(rentalContext, design(draft => { draft.steps[0]!.effects.financial = "Needs TB-9."; }));
    expect(result.structurallyValid).toBe(true);
    expect(result.reviewStatus).toBe("BLOCKED");
  });
  it("danglingIdHits has no hit when the design has no id family to compare with", () => {
    expect(danglingIdHits({ note: "see AB-12" }, [], new Set())).toEqual([]);
    expect(danglingIdHits({ note: "see AB-12" }, ["AB-1"], new Set(["AB-1"]))).toEqual([{ path: "draft.note", token: "AB-12" }]);
  });
});
