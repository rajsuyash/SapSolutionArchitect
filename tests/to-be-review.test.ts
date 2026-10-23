import { describe, expect, it } from "vitest";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3, rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { runDesign, type DesignDeps, type Substage } from "../src/lib/ai/to-be-pipeline";
import { compactDesign, repairNote, reviewBlockers, routeFindings } from "../src/lib/ai/to-be-review";
import { fixture } from "./support/to-be-input";
import { splitDesign } from "./support/to-be-split";
import type { RegisterGroup } from "../src/lib/ai/design-registers";

const split = splitDesign(rentalDraft);
type Call = { substage: Substage; user: Record<string, unknown>; group?: RegisterGroup | "patch" };
type Script = { review?: unknown | (() => never); step?: (id: string, nth: number, user: Record<string, unknown>) => unknown; registers?: (group: RegisterGroup, nth: number) => unknown;
  deps?: Partial<DesignDeps> };
/** A model that answers the rental design as it is, except where the script says otherwise. */
function run(script: Script = {}) {
  const calls: Call[] = [], warnings: { code: string; path: string }[] = [];
  const stepCount: Record<string, number> = {}, groupCount: Record<string, number> = {};
  const deps: DesignDeps = {
    parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: () => {}, warn: issues => { warnings.push(...issues); }, review: true,
    ask: async (substage, user, group) => {
      const request = user as Record<string, unknown>;
      calls.push({ substage, user: request, group });
      if (substage === "to_be_outline") return split.outline;
      if (substage === "to_be_review") { if (typeof script.review === "function") return (script.review as () => never)(); return "review" in script ? script.review : { findings: [] }; }
      if (substage === "to_be_step") {
        const id = (request.step as { id: string }).id; stepCount[id] = (stepCount[id] ?? 0) + 1;
        return script.step?.(id, stepCount[id]!, request) ?? split.details[id];
      }
      const g = group as RegisterGroup; groupCount[g] = (groupCount[g] ?? 0) + 1;
      return script.registers?.(g, groupCount[g]!) ?? rentalRegisterGroups[g];
    },
    ...script.deps,
  };
  const result = runDesign(fixture(), [], deps);
  return { result, calls, warnings, stepCount, groupCount, reviewCalls: () => calls.filter(call => call.substage === "to_be_review") };
}

describe("consistency review pass", () => {
  it("reads the whole design once and, when it finds nothing, returns the design unchanged with an empty finding list", async () => {
    const h = run();
    const out = await h.result;
    expect(h.reviewCalls()).toHaveLength(1);
    expect(out.design).toEqual(rentalDraftV3);
    expect(out.reviewFindings).toEqual([]);
    expect(out.evaluation.blockers.some(item => item.code.startsWith("REVIEW_"))).toBe(false);
    // The request is the compact form: step texts and registers, no acceptance-test bodies or trace arrays.
    const sent = JSON.stringify(h.reviewCalls()[0]!.user);
    expect(sent).toContain(rentalDraftV3.steps[0]!.title);
    expect(sent).not.toContain("requirementIds\":[\"R-1\",\"R-2\"],\"contextFieldIds");
    expect(sent).not.toContain(rentalDraftV3.steps[0]!.acceptanceTests[0]!.given);
  });

  it("finding -> one targeted repair of the step it names, with the finding as the repair note -> resolved, no blocker", async () => {
    const finding = { kind: "CONTRADICTION", paths: ["TB-2", "DSM-1"], explanation: "TB-2 says no goods receipt occurs but DSM-1 moves the order to goods receipt posted." };
    const fixed = { ...split.details["TB-2"]!, addedValue: "Returned assets are recorded per item without closing the whole order." };
    const h = run({ review: { findings: [finding] }, step: (id, nth) => id === "TB-2" && nth === 2 ? fixed : undefined,
      registers: (group, nth) => group === "documents" && nth === 2 ? rentalRegisterGroups.documents : undefined });
    const out = await h.result;
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 2, "TB-3": 1 });
    expect(h.groupCount.documents).toBe(2);
    const repair = h.calls.filter(call => call.substage === "to_be_step" && (call.user.step as { id: string }).id === "TB-2")[1]!.user;
    expect(repair.repairNote).toContain(finding.explanation);
    expect(repair.currentAnswer).toEqual(split.details["TB-2"]);
    expect(out.design.steps[1]!.addedValue).toBe(fixed.addedValue);
    expect(out.reviewFindings).toEqual([expect.objectContaining({ kind: "CONTRADICTION", outcome: "REPAIRED" })]);
    expect(out.evaluation.blockers.some(item => item.code.startsWith("REVIEW_"))).toBe(false);
    expect(h.warnings.map(item => item.code)).toContain("REVIEW_REPAIRED");
    // One repair per affected part, and the review itself ran once.
    expect(h.reviewCalls()).toHaveLength(1);
  });

  it("a finding that names no part stays a review finding: a blocker with the reviewer's sentence, no repair call", async () => {
    const finding = { kind: "COVERAGE_GAP", paths: ["R-99"], explanation: "Nothing covers the quarterly stock count." };
    const h = run({ review: { findings: [finding] } });
    const out = await h.result;
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 1, "TB-3": 1 });
    expect(out.evaluation.blockers).toContainEqual({ code: "REVIEW_COVERAGE_GAP", path: "draft", detail: finding.explanation });
    expect(out.evaluation.reviewStatus).toBe("BLOCKED");
    expect(out.reviewFindings).toEqual([expect.objectContaining({ outcome: "UNRESOLVED" })]);
    // The reviewer's words are a blocker detail, never a warning in the stage metrics.
    expect(JSON.stringify(h.warnings)).not.toContain("quarterly");
  });

  it("a repair that comes back invalid, or breaks the design, is dropped: the original part stays and the finding is a blocker", async () => {
    const finding = { kind: "MISSING_LINK", paths: ["TB-3"], explanation: "TB-3 has no link to the billing run." };
    const broken = run({ review: { findings: [finding] }, step: (id, nth) => id === "TB-3" && nth === 2 ? { not: "a step" } : undefined });
    const first = await broken.result;
    expect(first.design.steps[2]).toEqual(rentalDraftV3.steps[2]);
    expect(first.evaluation.blockers).toContainEqual({ code: "REVIEW_MISSING_LINK", path: "draft.steps.2", detail: finding.explanation });
    // A repair that parses but invents an SAP object the catalog lacks fails the design checks and is rejected, not adopted.
    const invented = run({ review: { findings: [finding] }, step: (id, nth) => id === "TB-3" && nth === 2
      ? { ...split.details["TB-3"]!, addedValue: "Post with movement type 777 and Fiori app F9999." } : undefined });
    const second = await invented.result;
    expect(second.design.steps[2]).toEqual(rentalDraftV3.steps[2]);
    expect(invented.warnings.map(item => item.code)).toContain("REVIEW_REPAIR_REJECTED");
    expect(second.reviewFindings![0]).toMatchObject({ outcome: "UNRESOLVED" });
  });

  it("sends a register group back the same way", async () => {
    const finding = { kind: "MISSING_LINK", paths: ["KDD-1"], explanation: "The decision names no owner role for the item split." };
    const fixed = { keyDesignDecisions: [{ ...rentalRegisterGroups.decisions.keyDesignDecisions[0]!, owner: "Head of rental operations" }] };
    const h = run({ review: { findings: [finding] }, registers: (group, nth) => group === "decisions" && nth === 2 ? fixed : undefined });
    const out = await h.result;
    expect(h.groupCount.decisions).toBe(2);
    expect(out.design.keyDesignDecisions![0]!.owner).toBe("Head of rental operations");
    const repair = h.calls.filter(call => call.group === "decisions")[1]!.user;
    expect(repair.repairNote).toContain(finding.explanation);
    expect(repair.currentAnswer).toEqual(rentalRegisterGroups.decisions);
    expect(out.reviewFindings![0]).toMatchObject({ outcome: "REPAIRED" });
  });

  it("skips the pass, with a warning and no model call, when 25% or less of the stage budget is left", async () => {
    const h = run({ review: { findings: [{ kind: "CONTRADICTION", paths: ["TB-1"], explanation: "x" }] }, deps: { remainingBudget: () => 0.25 } });
    const out = await h.result;
    expect(h.reviewCalls()).toHaveLength(0);
    expect(out.design).toEqual(rentalDraftV3);
    expect(out).not.toHaveProperty("reviewFindings");
    expect(h.warnings).toContainEqual({ code: "REVIEW_SKIPPED_BUDGET", path: "to_be_review" });
  });

  it("runs the review but spends no repair when the budget runs out during it", async () => {
    let budget = 1;
    const h = run({ review: () => { budget = 0.1; return { findings: [{ kind: "CONTRADICTION", paths: ["TB-1"], explanation: "TB-1 contradicts TB-2." }] }; },
      deps: { remainingBudget: () => budget } });
    const out = await h.result;
    expect(h.stepCount).toEqual({ "TB-1": 1, "TB-2": 1, "TB-3": 1 });
    expect(out.evaluation.blockers).toContainEqual({ code: "REVIEW_CONTRADICTION", path: "draft.steps.0", detail: "TB-1 contradicts TB-2." });
  });

  it("is off unless asked for, and a review that fails or answers nonsense never fails the design", async () => {
    const off = run({ deps: { review: false } });
    expect(await off.result).not.toHaveProperty("reviewFindings");
    expect(off.reviewCalls()).toHaveLength(0);
    for (const [review, code] of [[() => { throw new Error("provider down"); }, "REVIEW_FAILED"], [{ findings: "many" }, "REVIEW_INVALID_OUTPUT"], [null, "REVIEW_NO_PAYLOAD"]] as const) {
      const h = run({ review: review as never });
      expect((await h.result).design).toEqual(rentalDraftV3);
      expect(h.warnings.map(item => item.code)).toContain(code);
    }
  });

  it("spends at most six repairs, one per part, and leaves the findings of the rest as blockers", async () => {
    const parts = ["TB-1", "TB-2", "TB-3", "KDD-1", "ORG-1", "MD-1", "REP-1", "DSM-1", "ROLE-1"];
    const h = run({ review: { findings: parts.map(id => ({ kind: "CONTRADICTION", paths: [id], explanation: `Problem with ${id}.` })) } });
    const out = await h.result;
    // 1 outline + 3 steps + 8 groups + 1 review = 13 calls before any repair; 9 parts are named, 6 are repaired.
    expect(h.calls).toHaveLength(13 + 6);
    expect(out.reviewFindings!.filter(item => item.outcome === "REPAIRED")).toHaveLength(6);
    expect(out.evaluation.blockers.filter(item => item.code === "REVIEW_CONTRADICTION")).toHaveLength(3);
  });
});

describe("review pass building blocks", () => {
  it("shortens text, scale by scale, until the design fits the review budget, and never drops an id", () => {
    const long = structuredClone(rentalDraftV3);
    for (const step of long.steps) { step.implementation.detail = "d".repeat(2000); step.businessRules[0]!.response = "r".repeat(2000); }
    const full = JSON.stringify(compactDesign(long, 10_000_000)).length;
    const squeezed = compactDesign(long, full - 1);
    expect(JSON.stringify(squeezed).length).toBeLessThan(full);
    expect(squeezed.steps.map(step => step.id)).toEqual(long.steps.map(step => step.id));
    expect(squeezed.steps[0]!.businessRules[0]!.id).toBe(long.steps[0]!.businessRules[0]!.id);
    expect(JSON.stringify(compactDesign(long)).length).toBeLessThanOrEqual(120_000);
  });
  it("routes steps, their rules and tests, register rows and register names to the part that owns them, and ignores unknown ids and field suffixes", () => {
    const ids = ["TB-2.effects.financial", rentalDraftV3.steps[0]!.businessRules[0]!.id, rentalDraftV3.steps[1]!.acceptanceTests[0]!.id, "DSM-1", "interfaces", "ghost"];
    const routed = routeFindings(rentalDraftV3, ids.map(id => ({ kind: "CONTRADICTION" as const, paths: [id], explanation: "x" })));
    expect(routed.map(item => item.parts)).toEqual([[{ type: "step", stepId: "TB-2" }], [{ type: "step", stepId: "TB-1" }], [{ type: "step", stepId: "TB-2" }],
      [{ type: "group", group: "documents" }], [{ type: "group", group: "integration" }], []]);
    expect(routed[3]!.blockerPath).toBe("draft.documentStatusModels.0");
  });
  it("turns only unresolved findings into blockers, with the kind in the code", () => {
    expect(reviewBlockers([{ kind: "INTERNAL_TERM", blockerPath: "draft.steps.1", explanation: "Uses the word outline.", outcome: "UNRESOLVED" },
      { kind: "CONTRADICTION", blockerPath: "draft", explanation: "fixed", outcome: "REPAIRED" }])).toEqual([{ code: "REVIEW_INTERNAL_TERM", path: "draft.steps.1", detail: "Uses the word outline." }]);
    expect(reviewBlockers(undefined)).toEqual([]);
  });
  it("the repair note carries the finding text and tells the model to keep everything else", () => {
    const note = repairNote({ type: "step", stepId: "TB-2" }, [{ kind: "CONTRADICTION", paths: ["TB-2"], explanation: "Says A while TB-1 says B." }]);
    expect(note).toContain("Says A while TB-1 says B.");
    expect(note).toContain("currentAnswer");
  });
  it("the compact design keeps content and drops trace bookkeeping", () => {
    const compact = JSON.stringify(compactDesign(rentalDraftV3));
    for (const kept of [rentalDraftV3.steps[0]!.trigger, rentalDraftV3.documentStatusModels![0]!.documentType, `${rentalDraftV3.steps[0]!.acceptanceTests[0]!.id} (NORMAL)`]) expect(compact).toContain(kept);
    for (const dropped of ["contextFieldIds", "referenceIds", "needsValidation", rentalDraftV3.steps[0]!.acceptanceTests[0]!.when]) expect(compact).not.toContain(dropped);
  });
});
