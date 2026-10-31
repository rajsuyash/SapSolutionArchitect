import { describe, expect, it } from "vitest";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3, rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { REVIEW_MIN_REMAINING, reviewRequest, runDesign, type DesignDeps, type Substage } from "../src/lib/ai/to-be-pipeline";
import { MAX_REVIEW_DESIGN_CHARS, compactDesign } from "../src/lib/ai/to-be-review";
import { fixture } from "./support/to-be-input";
import { splitDesign } from "./support/to-be-split";
import type { RegisterGroup } from "../src/lib/ai/design-registers";

const split = splitDesign(rentalDraft);
type Finding = { kind: string; paths: string[]; explanation: string };
type Req = Record<string, unknown> & { verifyFindings?: Finding[] };
type Call = { substage: Substage; user: Req; group?: RegisterGroup | "patch" };
type Script = {
  /** Answer to a review call; `verifying` is true for a call that carries verifyFindings. */
  review: (request: Req, verifying: boolean) => unknown;
  step?: (id: string, nth: number) => unknown; deps?: Partial<DesignDeps>;
};
/** A model that answers the rental design as it is; a fix-pass repair answers the part's current answer (changes nothing). */
function run(script: Script) {
  const calls: Call[] = [], warnings: { code: string; path: string; detail?: string }[] = [], stepCount: Record<string, number> = {};
  const deps: DesignDeps = {
    parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: () => {}, warn: issues => { warnings.push(...issues); }, review: true, maxFixParts: 8,
    ask: async (substage, user, group) => {
      const request = user as Req;
      calls.push({ substage, user: request, group });
      if (substage === "to_be_outline") return split.outline;
      if (substage === "to_be_review") return script.review(request, !!request.verifyFindings);
      if (substage === "to_be_step") {
        const id = (request.step as { id: string }).id; stepCount[id] = (stepCount[id] ?? 0) + 1;
        return script.step?.(id, stepCount[id]!) ?? split.details[id];
      }
      if (substage === "to_be_registers") return rentalRegisterGroups[group as RegisterGroup];
      if (group === "patch") throw new Error("unexpected outline patch");
      return request.currentAnswer; // to_be_fix
    },
    ...script.deps,
  };
  const result = runDesign(fixture(), [], deps);
  return { result, calls, warnings, codes: () => warnings.map(item => item.code),
    reviewCalls: () => calls.filter(call => call.substage === "to_be_review"), verifyCalls: () => calls.filter(call => call.substage === "to_be_review" && call.user.verifyFindings),
    fixCalls: () => calls.filter(call => call.substage === "to_be_fix") };
}
const finding: Finding = { kind: "CONTRADICTION", paths: ["TB-2", "DSM-1"], explanation: "TB-2 says no goods receipt occurs but DSM-1 moves the order to goods receipt posted." };
const repaired = { ...split.details["TB-2"]!, addedValue: "Returned assets are recorded per item without closing the whole order." };
const repair = (id: string, nth: number) => id === "TB-2" && nth === 2 ? repaired : undefined;
const blockerCodes = (out: Awaited<ReturnType<typeof run>["result"]>) => out.evaluation.blockers.map(item => item.code);

describe("verifying claimed repairs", () => {
  it("a structurally valid rewrite that keeps the contradiction stays UNRESOLVED with the verifier's explanation, and its part is released to the fix pass", async () => {
    const still = "TB-2 still says no goods receipt occurs.";
    const h = run({ step: repair, review: (request, verifying) => ({ findings: verifying ? request.verifyFindings!.map(item => ({ ...item, explanation: still })) : [finding] }) });
    const out = await h.result;
    expect(out.reviewFindings).toEqual([expect.objectContaining({ kind: "CONTRADICTION", outcome: "UNRESOLVED", explanation: still })]);
    expect(out.evaluation.blockers).toContainEqual(expect.objectContaining({ code: "REVIEW_CONTRADICTION", detail: still }));
    // Released from reviewTried: the fix pass sent TB-2 back (the review pass alone would have excluded it).
    // (the finding names TB-2 and DSM-1, so both its step and the documents group were released)
    expect(h.fixCalls().map(call => (call.user.step as { id: string } | undefined)?.id ?? call.group).sort()).toEqual(["TB-2", "documents"]);
    expect(h.codes()).toContain("REVIEW_VERIFIED_HOLDS");
    // The verify call is a review call carrying exactly the claimed findings and an instruction.
    expect(h.verifyCalls()[0]!.user.verifyFindings).toEqual([finding]);
    expect(String(h.verifyCalls()[0]!.user.verifyInstruction)).toMatch(/still hold/i);
  });

  it("when the verifier returns nothing, the repair stands: REPAIRED, no blocker, REVIEW_VERIFIED says 1 of 1", async () => {
    const h = run({ step: repair, review: (_request, verifying) => ({ findings: verifying ? [] : [finding] }) });
    const out = await h.result;
    expect(out.reviewFindings).toEqual([expect.objectContaining({ outcome: "REPAIRED", explanation: finding.explanation })]);
    expect(blockerCodes(out).some(code => code.startsWith("REVIEW_"))).toBe(false);
    expect(h.warnings).toContainEqual({ code: "REVIEW_VERIFIED", path: "to_be_review", detail: "1 of 1 claimed repairs confirmed" });
    expect(h.fixCalls()).toHaveLength(0);
    expect(h.verifyCalls()).toHaveLength(1);
  });

  it("matches by kind and path ids, ignoring a verifier finding that matches none of the claimed ones", async () => {
    const other = { kind: "MISSING_LINK", paths: ["TB-3"], explanation: "Unrelated." };
    const h = run({ step: repair, review: (_request, verifying) => ({ findings: verifying ? [other] : [finding] }) });
    const out = await h.result;
    expect(out.reviewFindings).toEqual([expect.objectContaining({ outcome: "REPAIRED" })]);
    expect(h.warnings).toContainEqual(expect.objectContaining({ code: "REVIEW_VERIFIED", detail: "1 of 1 claimed repairs confirmed" }));
  });

  it("a verify call that throws or returns nothing keeps the outcomes and never fails the stage", async () => {
    for (const verify of [() => { throw new Error("provider down"); }, () => null, () => ({ findings: "many" })]) {
      const h = run({ step: repair, review: (_request, verifying) => verifying ? verify() : { findings: [finding] } });
      const out = await h.result;
      expect(out.reviewFindings).toEqual([expect.objectContaining({ outcome: "REPAIRED" })]);
      expect(h.codes()).toContain("REVIEW_VERIFY_FAILED");
      expect(blockerCodes(out).some(code => code.startsWith("REVIEW_"))).toBe(false);
    }
  });

  it("skips the verify call, with a warning, when the budget is at or below the review minimum by then", async () => {
    let budget = 1;
    const h = run({ review: () => ({ findings: [finding] }), deps: { remainingBudget: () => budget },
      step: (id, nth) => { if (id === "TB-2" && nth === 2) { budget = REVIEW_MIN_REMAINING; return repaired; } return undefined; } });
    const out = await h.result;
    expect(h.verifyCalls()).toHaveLength(0);
    expect(h.warnings).toContainEqual({ code: "REVIEW_VERIFY_SKIPPED_BUDGET", path: "to_be_review" });
    expect(out.reviewFindings).toEqual([expect.objectContaining({ outcome: "REPAIRED" })]);
  });

  it("a review finding cleared only by a kept fix is verified too, and one that still holds stays UNRESOLVED with its blocker", async () => {
    const parts = ["TB-1", "TB-2", "TB-3", "KDD-1", "ORG-1", "MD-1", "REP-1", "DSM-1", "ROLE-1"];
    const all = parts.map(id => ({ kind: "CONTRADICTION", paths: [id], explanation: `Problem with ${id}.` }));
    // The review pass verifies its six repairs and confirms them all; the fix pass repairs the other three and the verifier says only ROLE-1 still holds.
    const h = run({ review: (request, verifying) => ({ findings: !verifying ? all : request.verifyFindings!.filter(item => item.paths[0] === "ROLE-1") }) });
    const out = await h.result;
    expect(h.fixCalls()).toHaveLength(3);
    expect(h.verifyCalls()).toHaveLength(2);
    const byPath = (id: string) => out.reviewFindings!.find(item => item.paths[0] === id)!;
    expect(byPath("ROLE-1").outcome).toBe("UNRESOLVED");
    expect(byPath("DSM-1").outcome).toBe("REPAIRED");
    expect(byPath("TB-1").outcome).toBe("REPAIRED");
    expect(out.evaluation.blockers.filter(item => item.code === "REVIEW_CONTRADICTION")).toHaveLength(1);
    // No further retry: ROLE-1 was fixed once, so there are exactly three fix calls.
    expect(h.fixCalls()).toHaveLength(3);
  });
});

describe("what the reviewer reads", () => {
  it("shows test bodies, coverage links and rationale, and question decisions and scope", () => {
    const design = structuredClone(rentalDraftV3);
    design.coverage[0] = { ...design.coverage[0]!, questionIds: ["Q-1"], decisionIds: ["KDD-1"], rationale: "Held while the proration convention is open." };
    design.openQuestions[0] = { ...design.openQuestions[0]!, decisionIds: ["KDD-1"], scopeOfRequirementIds: ["R-1"] };
    const compact = compactDesign(design);
    const test = design.steps[0]!.acceptanceTests[0]!;
    expect(compact.steps[0]!.acceptanceTests[0]).toEqual({ id: test.id, kind: test.kind, given: test.given, when: test.when, then: test.then });
    expect(compact.coverage[0]).toMatchObject({ questionIds: ["Q-1"], decisionIds: ["KDD-1"], rationale: "Held while the proration convention is open." });
    expect(compact.openQuestions[0]).toMatchObject({ decisionIds: ["KDD-1"], scopeOfRequirementIds: ["R-1"] });
    expect(reviewRequest(fixture(), design).design.openQuestions[0]).toMatchObject({ scopeOfRequirementIds: ["R-1"] });
  });
  it("a large design still fits MAX_REVIEW_DESIGN_CHARS", () => {
    const big = structuredClone(rentalDraftV3);
    const bulk = "x".repeat(3000);
    for (const step of big.steps) {
      step.acceptanceTests = Array.from({ length: 60 }, (_, i) => ({ ...step.acceptanceTests[0]!, id: `${step.id}-T-${i}`, given: bulk, when: bulk, then: bulk }));
      step.implementation.detail = bulk; step.trigger = bulk;
    }
    big.coverage = Array.from({ length: 400 }, (_, i) => ({ ...big.coverage[0]!, requirementId: `R-${i}`, rationale: bulk }));
    expect(JSON.stringify(compactDesign(big, 10_000_000)).length).toBeGreaterThan(MAX_REVIEW_DESIGN_CHARS);
    expect(JSON.stringify(compactDesign(big)).length).toBeLessThanOrEqual(MAX_REVIEW_DESIGN_CHARS);
  });
});
