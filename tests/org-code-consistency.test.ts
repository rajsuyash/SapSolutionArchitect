import { describe, expect, it } from "vitest";
import { evaluateDesign, orgCodeConflicts, type DetailedDesign } from "../src/lib/ai/design-quality";
import { FIXABLE_BLOCKERS, collectTargets, explainBlocker } from "../src/lib/ai/to-be-fix";
import { rentalContext } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";
import { fixture } from "./support/to-be-input";

const company = { id: "ORG-1", unitType: "Company code", proposal: "Chakan company code for the hire business", code: "2000", parentId: null };
const plant = { id: "ORG-2", unitType: "Plant", proposal: "Pune Works plant for refurbishment", code: "2100", parentId: "ORG-1" };
const org = [company, plant];
const hits = (...texts: string[]) => orgCodeConflicts(org, texts.map((text, i) => ({ path: `draft.steps.${i}`, text })));

describe("orgCodeConflicts", () => {
  it("flags a unit paired with a code other than the organisation structure's, in both phrasings", () => {
    expect(hits("Chakan (company code 1000) books the invoice.")).toEqual([{ path: "draft.steps.0", detail: "Chakan is 2000, text says 1000" }]);
    expect(hits("The order is posted in company code 1000 (Chakan).")).toEqual([{ path: "draft.steps.0", detail: "Chakan is 2000, text says 1000" }]);
    expect(hits("Stock is moved at plant Pune Works plant 2200 only.")).toEqual([{ path: "draft.steps.0", detail: "Pune Works is 2100, text says 2200" }]);
  });
  it("stays quiet when the code matches, the unit is not named, or the pairing cannot be judged", () => {
    expect(hits("Chakan (company code 2000) books the invoice.", "Plant 2100 (Pune Works) holds the stock.")).toEqual([]);
    expect(hits("Another site (company code 1000) books the invoice.")).toEqual([]);
    // Pune Works is a plant under company code 2000: naming its company code is judged against the parent, naming a storage location cannot be judged.
    expect(hits("Pune Works sits in company code 2000.", "Pune Works storage location 0001 holds spares.")).toEqual([]);
    expect(hits("Pune Works sits in company code 1000.")).toEqual([{ path: "draft.steps.0", detail: "Pune Works is 2000, text says 1000" }]);
    expect(orgCodeConflicts([{ ...company, code: null }], [{ path: "p", text: "Chakan (company code 1000)" }])).toEqual([]);
  });
});

describe("ORG_CODE_MISMATCH blocker", () => {
  const withOrg = (stepText: string): DetailedDesign => {
    const draft = structuredClone(rentalDraftV3);
    draft.orgStructure = [{ ...draft.orgStructure![0]!, ...company, codeStatus: "CODE_CONFIRMED", owner: "Billing clerk" }];
    draft.steps[0]!.trigger = stepText;
    return draft;
  };
  const context = { ...rentalContext, companyContext: [{ fieldId: "org", value: "Company code 2000" }] };
  const found = (draft: DetailedDesign) => evaluateDesign(context, draft).blockers.filter(item => item.code === "ORG_CODE_MISMATCH");

  it("blocks a step that states another code for the unit, with the two codes in the detail, and is fixable", () => {
    const draft = withOrg("Chakan (company code 1000) receives the hire order.");
    expect(found(draft)).toEqual([{ code: "ORG_CODE_MISMATCH", path: "draft.steps.0", detail: "Chakan is 2000, text says 1000" }]);
    expect(FIXABLE_BLOCKERS.has("ORG_CODE_MISMATCH")).toBe(true);
    const { targets } = collectTargets(draft, found(draft));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.part).toEqual({ type: "step", stepId: draft.steps[0]!.id });
    expect(explainBlocker(found(draft)[0]!, draft, fixture())).toContain("Chakan is 2000, text says 1000");
  });
  it("raises nothing when the text agrees with the organisation structure", () => {
    expect(found(withOrg("Chakan (company code 2000) receives the hire order."))).toEqual([]);
  });
});
