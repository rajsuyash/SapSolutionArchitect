import { describe, expect, it } from "vitest";
import { repairIdVariants } from "../src/lib/ai/id-variant-repair";
import { evaluateDesign } from "../src/lib/ai/design-quality";
import { collectTargets } from "../src/lib/ai/to-be-fix";
import { rentalContext } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";

const IDS = ["ETO-05", "ETO-OQ-4", "ETO-10", "TB-2", "TB-02"];
const fix = (value: unknown) => repairIdVariants(value, IDS, "draft");

describe("repairIdVariants", () => {
  it("rewrites a zero-padding or case variant to the one existing id, warning with the element path only", () => {
    const r = fix({ steps: [{ id: "x", note: "after ETO-5 and eto-oq-4, also ETO-10." }] });
    expect(r.value).toEqual({ steps: [{ id: "x", note: "after ETO-05 and ETO-OQ-4, also ETO-10." }] });
    expect(r.warnings).toEqual([{ code: "REPAIRED_ID_VARIANT", path: "draft.steps.0" }]);
  });
  it("never rewrites with 0 candidates, with 2 candidates, or when the token already exists", () => {
    const r = fix({ a: "ETO-7 and TB-2 and ETO-0010x", b: "TB-002" });
    expect(r.value).toEqual({ a: "ETO-7 and TB-2 and ETO-0010x", b: "TB-002" }); // TB-002 matches TB-2 and TB-02: ambiguous
    expect(r.warnings).toEqual([]);
  });
  it("leaves id-list fields alone", () => {
    const value = { stepIds: ["ETO-5"], id: "ETO-5", note: "ok" };
    expect(fix(value).value).toBe(value);
  });
});

describe("DANGLING_ID_REFERENCE is a fixable heuristic blocker, not an error", () => {
  const draft = structuredClone(rentalDraftV3);
  draft.steps[0]!.effects.financial = "Billing follows TB-9.";
  const evaluation = evaluateDesign(rentalContext, draft);
  it("is a blocker and the design stays structurally valid", () => {
    expect(evaluation.errors.filter(e => e.code === "DANGLING_ID_REFERENCE")).toEqual([]);
    expect(evaluation.blockers.filter(b => b.code === "DANGLING_ID_REFERENCE")).toEqual([{ code: "DANGLING_ID_REFERENCE", path: "draft.steps.0", detail: "TB-9 does not exist in this design" }]);
  });
  it("is routed to the step that cites it", () => {
    const { targets } = collectTargets(draft as never, evaluation.blockers);
    expect(targets.map(t => t.part)).toEqual([{ type: "step", stepId: draft.steps[0]!.id }]);
  });
});
