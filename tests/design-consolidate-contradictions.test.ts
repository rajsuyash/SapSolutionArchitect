import { describe, expect, it } from "vitest";
import { evaluateDesign, type DetailedDesign } from "../src/lib/ai/design-quality";
import { consolidateDesign, holdCoverageOnPendingQuestions, repairOrgCodes } from "../src/lib/ai/design-consolidate";
import { rentalContext } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";

const orgRows = [
  { id: "ORG-1", unitType: "Company code", proposal: "Chakan company code for the hire business", code: "2000", codeStatus: "CODE_CONFIRMED" as const, owner: "Billing clerk", parentId: null },
  { id: "ORG-2", unitType: "Plant", proposal: "Pune Works plant for refurbishment", code: "2100", codeStatus: "CODE_CONFIRMED" as const, owner: "Billing clerk", parentId: "ORG-1" },
];
const withOrg = (change: (draft: DetailedDesign) => void) => {
  const draft = structuredClone(rentalDraftV3);
  draft.orgStructure = orgRows.map(row => ({ ...draft.orgStructure![0]!, ...row }));
  change(draft);
  return draft;
};
const mismatches = (draft: DetailedDesign) => evaluateDesign({ ...rentalContext, companyContext: [{ fieldId: "org", value: "Company code 2000, plant 2100" }] }, draft).blockers.filter(item => item.code === "ORG_CODE_MISMATCH");

describe("repairOrgCodes", () => {
  it("rewrites only the wrong code token to the organisation structure's code and warns, after which the blocker no longer fires", () => {
    const draft = withOrg(d => {
      d.steps[0]!.trigger = "Chakan (company code 1000) receives the hire order; plant 1100 (Pune Works) picks the stock. Quote 1000 stays.";
      d.steps[1]!.businessRules[0]!.response = "Post to company code 2000 (Chakan).";
    });
    expect(mismatches(draft).length).toBeGreaterThan(0);
    const out = repairOrgCodes(draft);
    expect(out.design.steps[0]!.trigger).toBe("Chakan (company code 2000) receives the hire order; plant 2100 (Pune Works) picks the stock. Quote 1000 stays.");
    expect(out.design.steps[1]!.businessRules[0]!.response).toBe("Post to company code 2000 (Chakan).");
    expect(out.warnings).toEqual([{ code: "ORG_CODE_REPAIRED", path: "draft.steps.0.trigger" }]);
    expect(mismatches(out.design)).toEqual([]);
    expect(consolidateDesign(draft).warnings.map(w => w.code)).toContain("ORG_CODE_REPAIRED");
  });
  it("leaves the design alone when two units of one name disagree, or nothing conflicts", () => {
    const clash = withOrg(d => { d.orgStructure = [...d.orgStructure!, { ...d.orgStructure![0]!, id: "ORG-3", code: "3000" }]; d.steps[0]!.trigger = "Chakan (company code 1000) receives the order."; });
    expect(repairOrgCodes(clash).warnings).toEqual([]);
    const clean = withOrg(d => { d.steps[0]!.trigger = "Chakan (company code 2000) receives the order."; });
    expect(repairOrgCodes(clean).design).toBe(clean);
  });
});

describe("holdCoverageOnPendingQuestions", () => {
  const held = (rule: string, change: (draft: DetailedDesign, requirementId: string) => void = () => {}) => {
    const draft = structuredClone(rentalDraftV3);
    const row = draft.coverage.find(item => item.disposition === "IMPLEMENTED")!;
    const step = draft.steps.find(item => item.requirementIds.includes(row.requirementId))!;
    step.businessRules[0]!.response = rule;
    draft.openQuestions = [...draft.openQuestions, { id: "IQ-7", question: "Which tolerance applies?", owner: "Process owner", affectedStepIds: [step.id] }];
    change(draft, row.requirementId);
    return { draft, row };
  };
  it("turns an IMPLEMENTED row into CONDITIONAL with the cited questions and a Held pending rationale", () => {
    const { draft, row } = held("Pending IQ-7: the tolerance is confirmed by the business.");
    const out = holdCoverageOnPendingQuestions(draft);
    const next = out.design.coverage.find(item => item.requirementId === row.requirementId)!;
    expect(next.disposition).toBe("CONDITIONAL");
    expect(next.questionIds).toEqual(["IQ-7"]);
    expect(next.rationale).toBe(`Held pending IQ-7: ${row.rationale}`);
    expect(out.warnings).toContainEqual({ code: "COVERAGE_MADE_CONDITIONAL", path: `draft.coverage.${draft.coverage.indexOf(row)}` });
    expect(evaluateDesign(rentalContext, out.design).errors.map(e => e.code)).not.toContain("CONDITIONAL_UNLINKED");
  });
  it("reads a Pending <X>-OQ-n hold and keeps rows that are already conditional or out of scope", () => {
    const { draft, row } = held("Pending TB-OQ-2: approval limit open.", d => { d.openQuestions.push({ id: "TB-OQ-2", question: "Limit?", owner: "CFO", affectedStepIds: [d.steps[0]!.id] }); });
    expect(holdCoverageOnPendingQuestions(draft).design.coverage.find(item => item.requirementId === row.requirementId)!.questionIds).toEqual(["TB-OQ-2"]);
    const done = held("Pending IQ-7: open.", d => d.coverage.forEach(r => { if (r.disposition === "IMPLEMENTED") { r.disposition = "CONDITIONAL"; r.questionIds = ["IQ-7"]; } }));
    expect(holdCoverageOnPendingQuestions(done.draft).design).toBe(done.draft);
  });
  it("does nothing without a hold in a step that realises the requirement", () => {
    const { draft } = held("Reject the order when stock is short.");
    expect(holdCoverageOnPendingQuestions(draft).design).toBe(draft);
  });
});
