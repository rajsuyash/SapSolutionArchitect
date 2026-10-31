import { describe, expect, it } from "vitest";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3, rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { runDesign, type DesignDeps, type Substage } from "../src/lib/ai/to-be-pipeline";
import { FIXABLE_BLOCKERS, collectTargets, explainBlocker } from "../src/lib/ai/to-be-fix";
import { fixture, withCompanyContext } from "./support/to-be-input";
import { splitDesign } from "./support/to-be-split";
import type { RegisterGroup } from "../src/lib/ai/design-registers";
import type { ToBeInput } from "../src/lib/ai/to-be";
import type { ReviewOutcome } from "../src/lib/ai/to-be-review";

const split = splitDesign(rentalDraft);
const groups = rentalRegisterGroups;
type Call = { substage: Substage; user: Record<string, unknown>; group?: RegisterGroup | "patch" };
type Script = {
  /** First answers (the design before the fix pass). */
  registers?: Partial<Record<RegisterGroup, unknown>>; step?: (id: string, nth: number) => unknown; review?: unknown | (() => unknown);
  /** Answers to the fix pass: per group / per step id (default: the part's currentAnswer, i.e. a repair that changes nothing), and to an outline patch. */
  fixGroup?: (group: RegisterGroup, user: Record<string, unknown>) => unknown; fixStep?: (id: string, user: Record<string, unknown>) => unknown; patch?: (user: Record<string, unknown>) => unknown;
  deps?: Partial<DesignDeps>; input?: ToBeInput;
};
function run(script: Script = {}) {
  const calls: Call[] = [], warnings: { code: string; path: string }[] = [], stepCount: Record<string, number> = {};
  const deps: DesignDeps = {
    parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: () => {}, warn: issues => { warnings.push(...issues); }, review: "review" in script, maxFixParts: 8,
    ask: async (substage, user, group) => {
      const request = user as Record<string, unknown>;
      calls.push({ substage, user: request, group });
      if (substage === "to_be_outline") return split.outline;
      // A verify call (it carries verifyFindings) confirms every claimed repair; to-be-verify.test.ts covers the verifier answering otherwise.
      if (substage === "to_be_review" && request.verifyFindings) return { findings: [] };
      if (substage === "to_be_review") return typeof script.review === "function" ? (script.review as () => unknown)() : script.review;
      if (substage === "to_be_step") {
        const id = (request.step as { id: string }).id; stepCount[id] = (stepCount[id] ?? 0) + 1;
        return script.step?.(id, stepCount[id]!) ?? split.details[id];
      }
      if (substage === "to_be_registers") return script.registers?.[group as RegisterGroup] ?? groups[group as RegisterGroup];
      // to_be_fix: a patch, a step or a register group
      if (group === "patch") return script.patch ? script.patch(request) : (() => { throw new Error("unexpected outline patch"); })();
      if (!group) return script.fixStep?.((request.step as { id: string }).id, request) ?? request.currentAnswer;
      return script.fixGroup?.(group, request) ?? request.currentAnswer;
    },
    ...script.deps,
  };
  const result = runDesign(script.input ?? fixture(), [], deps);
  const fixCalls = () => calls.filter(call => call.substage === "to_be_fix");
  return { result, calls, warnings, fixCalls, codes: () => warnings.map(item => item.code) };
}
const blockerCodes = (out: Awaited<ReturnType<typeof run>["result"]>) => out.evaluation.blockers.map(item => item.code);

/** TB-3 is served by no objective: OBJECTIVE_STEP_UNMAPPED @ draft.objectives (the scope group). */
const unmapped = { ...groups.scope, objectives: groups.scope.objectives.map(row => row.id === "OBJ-2" ? { ...row, stepIds: ["TB-2"] } : row) };

describe("fix pass: a heuristic blocker sends its part back once", () => {
  it("is quiet when there is nothing fixable: no call, the design as it was", async () => {
    const h = run();
    const out = await h.result;
    expect(h.fixCalls()).toHaveLength(0);
    expect(out.design).toEqual(rentalDraftV3);
  });

  it("OBJECTIVE_STEP_UNMAPPED -> one call to the scope group naming the unserved step -> repaired answer kept, blocker gone", async () => {
    const h = run({ registers: { scope: unmapped }, fixGroup: () => groups.scope });
    const out = await h.result;
    expect(blockerCodes(out)).not.toContain("OBJECTIVE_STEP_UNMAPPED");
    expect(out.design.objectives).toEqual(groups.scope.objectives);
    expect(h.fixCalls()).toHaveLength(1);
    const call = h.fixCalls()[0]!;
    expect(call).toMatchObject({ substage: "to_be_fix", group: "scope" });
    expect(String(call.user.repairNote)).toContain("Steps TB-3 are not served by any objective");
    expect(call.user.currentAnswer).toEqual(unmapped);
    expect(h.warnings).toContainEqual({ code: "FIX_APPLIED", path: "draft.scope" });
    // Warnings carry code and path only.
    expect(h.warnings.every(item => Object.keys(item).sort().join() === "code,path")).toBe(true);
  });

  it("a blocker that points at a step goes to that step (INTERNAL_TERM in step text) and the original text is replaced", async () => {
    const dirty = { ...split.details["TB-2"]!, addedValue: "The register call fills this field." };
    const clean = split.details["TB-2"]!;
    const h = run({ step: id => id === "TB-2" ? dirty : undefined, fixStep: id => id === "TB-2" ? clean : undefined });
    const out = await h.result;
    expect(h.fixCalls().map(call => (call.user.step as { id: string }).id)).toEqual(["TB-2"]);
    expect(String(h.fixCalls()[0]!.user.repairNote)).toContain('working term "register call"');
    expect(out.design.steps[1]!.addedValue).toBe(clean.addedValue);
    expect(blockerCodes(out)).not.toContain("INTERNAL_TERM");
  });

  it("ROLE_STEP_UNCOVERED points at a step but is cleared in the roles: it goes to the governance group", async () => {
    const roles = groups.governance.roles.map(role => role.id === "ROLE-3" ? { ...role, stepIds: ["TB-2"] } : role);
    const h = run({ registers: { governance: { ...groups.governance, roles } }, fixGroup: () => groups.governance });
    const out = await h.result;
    expect(h.fixCalls().map(call => call.group)).toEqual(["governance"]);
    expect(String(h.fixCalls()[0]!.user.repairNote)).toContain("No role is assigned to step TB-3");
    expect(blockerCodes(out)).not.toContain("ROLE_STEP_UNCOVERED");
  });

  it("all blockers of one part go in ONE call, and several parts are repaired in their own calls", async () => {
    const input = withCompanyContext(fixture(), { desired_outcome: "Track each hire item to its return." });
    const noContext = { ...unmapped, objectives: unmapped.objectives.map(row => ({ ...row, contextFieldIds: [] })) };
    const withContext = { ...groups.scope, objectives: groups.scope.objectives.map((row, i) => i === 0 ? { ...row, contextFieldIds: ["desired_outcome"] } : row) };
    const roles = groups.governance.roles.map(role => role.id === "ROLE-3" ? { ...role, stepIds: ["TB-2"] } : role);
    const h = run({ input, registers: { scope: noContext, governance: { ...groups.governance, roles } },
      fixGroup: group => group === "scope" ? withContext : groups.governance });
    const out = await h.result;
    expect(h.fixCalls().map(call => call.group).sort()).toEqual(["governance", "scope"]);
    const note = String(h.fixCalls().find(call => call.group === "scope")!.user.repairNote);
    expect(note).toContain("not served by any objective");
    expect(note).toContain("desired outcome, KPI target or constraint");
    expect(blockerCodes(out)).not.toEqual(expect.arrayContaining(["OBJECTIVE_STEP_UNMAPPED"]));
    expect(blockerCodes(out)).not.toContain("OBJECTIVE_CONTEXT_UNCOVERED");
  });
});

describe("fix pass: a repair is kept only when it helps", () => {
  const original = { registers: { scope: unmapped } };
  it("an answer that does not parse leaves the original part and its blocker", async () => {
    const h = run({ ...original, fixGroup: () => ({ not: "a group" }) });
    const out = await h.result;
    expect(out.design.objectives).toEqual(unmapped.objectives);
    expect(blockerCodes(out)).toContain("OBJECTIVE_STEP_UNMAPPED");
    expect(h.codes()).toContain("FIX_NO_PROPOSAL");
  });
  it("an answer that breaks the design (no objective left) is dropped", async () => {
    const broken = { ...groups.scope, objectives: [] };
    const h = run({ ...original, fixGroup: () => broken });
    const out = await h.result;
    expect(out.design.objectives).toEqual(unmapped.objectives);
    expect(blockerCodes(out)).toContain("OBJECTIVE_STEP_UNMAPPED");
    expect(h.codes()).toContain("FIX_REJECTED");
  });
  it("an answer that is valid but leaves the finding firing is dropped", async () => {
    const h = run({ ...original, fixGroup: () => unmapped });
    const out = await h.result;
    expect(blockerCodes(out)).toContain("OBJECTIVE_STEP_UNMAPPED");
    expect(h.codes()).toContain("FIX_REJECTED");
  });
  it("an answer that clears one finding but adds another is dropped (the blockers must not grow)", async () => {
    const worse = { ...groups.scope, scopeStatements: groups.scope.scopeStatements.map(row => ({ ...row, statement: "Handled by the register call." })) };
    const h = run({ ...original, fixGroup: () => worse });
    const out = await h.result;
    expect(out.design.objectives).toEqual(unmapped.objectives);
    expect(h.codes()).toContain("FIX_REJECTED");
  });
  it("a failing call is a rejected fix, never a failed stage", async () => {
    const h = run({ ...original, fixGroup: () => { throw new Error("provider down"); } });
    const out = await h.result;
    expect(blockerCodes(out)).toContain("OBJECTIVE_STEP_UNMAPPED");
  });
});

describe("fix pass: budget and cap", () => {
  it("does nothing, with a warning and no call, when 25% or less of the budget is left", async () => {
    const h = run({ registers: { scope: unmapped }, deps: { remainingBudget: () => 0.25 } });
    const out = await h.result;
    expect(h.fixCalls()).toHaveLength(0);
    expect(blockerCodes(out)).toContain("OBJECTIVE_STEP_UNMAPPED");
    expect(h.warnings).toContainEqual({ code: "FIX_SKIPPED_BUDGET", path: "to_be_fix" });
  });
  it("is off when maxFixParts is 0 or unset", async () => {
    for (const maxFixParts of [0, undefined]) {
      const h = run({ registers: { scope: unmapped }, deps: { maxFixParts } });
      await h.result;
      expect(h.fixCalls()).toHaveLength(0);
    }
  });
  it("repairs at most maxFixParts parts, the busiest first", async () => {
    const roles = groups.governance.roles.map(role => role.id === "ROLE-3" ? { ...role, stepIds: ["TB-2"] } : role);
    const h = run({ registers: { scope: unmapped, governance: { ...groups.governance, roles } }, deps: { maxFixParts: 1 } });
    await h.result;
    expect(h.fixCalls()).toHaveLength(1);
  });
});

describe("fix pass: unresolved review findings", () => {
  const finding = (id: string) => ({ kind: "CONTRADICTION", paths: [id], explanation: `Problem with ${id}.` });
  it("a part the consistency pass already tried is not sent the same finding again", async () => {
    // The review's repair of TB-3 does not parse, so the finding stays open; the fix pass leaves it as a finding instead of asking again.
    const h = run({ review: { findings: [finding("TB-3")] }, step: (id, nth) => id === "TB-3" && nth === 2 ? { not: "a step" } : undefined });
    const out = await h.result;
    expect(h.calls.filter(call => call.substage === "to_be_step" && (call.user.step as { id: string }).id === "TB-3")).toHaveLength(2);
    expect(h.fixCalls()).toHaveLength(0);
    expect(out.reviewFindings).toEqual([expect.objectContaining({ outcome: "UNRESOLVED" })]);
    expect(blockerCodes(out)).toContain("REVIEW_CONTRADICTION");
  });
  it("a finding beyond the consistency pass's six repairs gets its part fixed here, and is marked repaired when the fix is kept", async () => {
    const parts = ["TB-1", "TB-2", "TB-3", "KDD-1", "ORG-1", "MD-1", "REP-1", "DSM-1", "ROLE-1"];
    const h = run({ review: { findings: parts.map(finding) } });
    const out = await h.result;
    // 13 calls to build, 6 review repairs and 1 verify call for them, then the 3 parts the review had no room for and 1 verify call for those.
    expect(h.calls).toHaveLength(13 + 6 + 1 + 3 + 1);
    expect(h.fixCalls()).toHaveLength(3);
    expect(out.reviewFindings!.every(item => item.outcome === "REPAIRED")).toBe(true);
    expect(out.evaluation.blockers.some(item => item.code.startsWith("REVIEW_"))).toBe(false);
  });
});

describe("fix pass: a finding that needs a new step takes one outline patch", () => {
  const gap = { findings: [{ kind: "COVERAGE_GAP", paths: ["R-99"], explanation: "No step owns the goods receipt." }] };
  const newStep = { id: "TB-4", sequence: 4, title: "Receive returned goods", purpose: "Book the physical receipt of returned items.", asIsStepIds: [], requirementIds: [], enablesStepIds: ["TB-2"],
    implementation: { kind: "MANUAL", referenceIds: [] } };
  const patch = { steps: [newStep] };
  const tb4 = () => { const base = split.details["TB-3"]!;
    return { ...base, businessRules: base.businessRules.map(rule => ({ ...rule, id: `${rule.id}-RECEIPT`, condition: "Returned goods arrive at the receiving store without a return note.", response: "Hold the receipt until the note is matched to the open return." })), outputDocuments: ["Goods receipt note"], inputDocuments: ["Return note"],
      acceptanceTests: base.acceptanceTests.map(test => ({ ...test, id: `${test.id}-RECEIPT`, requirementIds: [] })) }; };
  const covered = {
    scope: { ...groups.scope, objectives: groups.scope.objectives.map(row => row.id === "OBJ-2" ? { ...row, stepIds: ["TB-3", "TB-4"] } : row) },
    reporting: { ...groups.reporting, endToEndTests: groups.reporting.endToEndTests.map(row => ({ ...row, stepIds: [...row.stepIds, "TB-4"] })) },
    governance: { ...groups.governance, roles: groups.governance.roles.map(role => role.id === "ROLE-3" ? { ...role, stepIds: ["TB-3", "TB-4"] } : role) },
  } as Partial<Record<RegisterGroup, unknown>>;
  const script = (over: Script = {}): Script => ({ review: gap, patch: () => patch, fixStep: id => id === "TB-4" ? tb4() : undefined, fixGroup: group => covered[group], ...over });

  it("adds the step, expands only it, repairs the blockers the new step brings, and marks the finding repaired", async () => {
    const h = run(script());
    const out = await h.result;
    expect(out.design.steps.map(step => step.id)).toEqual(["TB-1", "TB-2", "TB-3", "TB-4"]);
    expect(h.calls.filter(call => call.group === "patch")).toHaveLength(1);
    // Only the new step was expanded; the three old steps were not asked again.
    expect(h.calls.filter(call => call.substage === "to_be_fix" && call.user.step).map(call => (call.user.step as { id: string }).id)).toEqual(["TB-4"]);
    expect(h.calls.filter(call => call.substage === "to_be_step")).toHaveLength(3);
    expect(String(h.fixCalls().find(call => call.group === "patch")!.user.repairNote)).toContain("No step owns the goods receipt.");
    expect(out.reviewFindings).toEqual([expect.objectContaining({ kind: "COVERAGE_GAP", outcome: "REPAIRED" })]);
    expect(blockerCodes(out)).not.toContain("REVIEW_COVERAGE_GAP");
    expect(blockerCodes(out)).not.toContain("OBJECTIVE_STEP_UNMAPPED");
    expect(blockerCodes(out)).not.toContain("E2E_STEP_UNCOVERED");
    expect(blockerCodes(out)).not.toContain("ROLE_STEP_UNCOVERED");
    expect(h.codes()).toContain("FIX_PATCH_APPLIED");
  });
  it("is skipped, with a warning and no call, when 40% or less of the budget is left", async () => {
    const h = run(script({ deps: { remainingBudget: () => 0.4 } }));
    const out = await h.result;
    expect(h.calls.filter(call => call.group === "patch")).toHaveLength(0);
    expect(out.design.steps).toHaveLength(3);
    expect(blockerCodes(out)).toContain("REVIEW_COVERAGE_GAP");
    expect(h.codes()).toContain("FIX_PATCH_SKIPPED_BUDGET");
  });
  it("is dropped, original design and blocker kept, when the patch does not parse, the step call fails or the new design is invalid", async () => {
    const variants: [string, Script][] = [["patch does not parse", { patch: () => ({ steps: "many" }) }], ["no patch payload", { patch: () => null }],
      ["step call does not parse", { fixStep: () => ({ not: "a step" }) }], ["whole design invalid", { fixStep: id => id === "TB-4" ? { ...tb4(), acceptanceTests: tb4().acceptanceTests.map(test => ({ ...test, kind: "EXCEPTION" })) } : undefined }]];
    for (const [label, over] of variants) {
      const h = run(script(over));
      const out = await h.result;
      expect(h.codes(), label).toContain("FIX_PATCH_REJECTED");
      expect(out.design).toEqual(rentalDraftV3);
      expect(blockerCodes(out)).toContain("REVIEW_COVERAGE_GAP");
      expect(h.codes()).toContain("FIX_PATCH_REJECTED");
    }
  });
  it("is rolled back when the blockers its new step brings cannot be cleared: the outline, steps and registers are as before", async () => {
    const h = run(script({ fixGroup: () => undefined }));
    const out = await h.result;
    expect(out.design).toEqual(rentalDraftV3);
    expect(out.reviewFindings).toEqual([expect.objectContaining({ outcome: "UNRESOLVED" })]);
    expect(blockerCodes(out)).toContain("REVIEW_COVERAGE_GAP");
    expect(h.codes()).toContain("FIX_PATCH_REJECTED");
    expect(h.codes()).not.toContain("FIX_PATCH_APPLIED");
  });
  it("a finding about no part and of another kind (an internal term, a contradiction) is not sent for a new step", async () => {
    const h = run(script({ review: { findings: [{ kind: "CONTRADICTION", paths: ["R-99"], explanation: "Two statements disagree." }] } }));
    await h.result;
    expect(h.calls.filter(call => call.group === "patch")).toHaveLength(0);
  });
});

describe("fix pass: text that cites an open question the outline lacks gets the question added by an outline patch", () => {
  const citing = (id: string, token: string) => id === "TB-2" ? { ...split.details["TB-2"]!, effects: { ...split.details["TB-2"]!.effects, financial: `The proration policy is held under ${token}.` } } : undefined;
  const question = { id: "Q-2", question: "Who may approve a partial final day?", owner: "Billing policy owner", affectedStepIds: ["TB-2"] };
  const dangling = (out: Awaited<ReturnType<typeof run>["result"]>) => out.evaluation.blockers.filter(item => item.code === "DANGLING_ID_REFERENCE");

  it("one patch adds the question with its citing steps in the note; the citing step is not rewritten; the blocker is gone", async () => {
    const h = run({ step: id => citing(id, "Q-2"), patch: () => ({ openQuestions: [question] }) });
    const out = await h.result;
    expect(dangling(out)).toEqual([]);
    expect(out.design.openQuestions.map(item => item.id)).toEqual(["Q-1", "Q-2"]);
    const patches = h.fixCalls().filter(call => call.group === "patch");
    expect(patches).toHaveLength(1);
    expect(String(patches[0]!.user.repairNote)).toContain('"Q-2" (cited in steps TB-2)');
    expect(h.fixCalls().filter(call => call.user.step)).toHaveLength(0);
    expect(h.codes()).toContain("FIX_PATCH_APPLIED");
    // The question it adds is itself an open item for the business, not a blocker the pass hides.
    expect(blockerCodes(out)).toContain("OPEN_QUESTION");
  });
  it("keeps the original design and its blocker when the patch does not add the question or is not usable", async () => {
    for (const patch of [() => ({ openQuestions: [] }), () => null, () => ({ openQuestions: [{ ...question, affectedStepIds: ["TB-99"] }] })]) {
      const h = run({ step: id => citing(id, "Q-2"), patch });
      const out = await h.result;
      expect(dangling(out)).toHaveLength(1);
      expect(out.design.openQuestions.map(item => item.id)).toEqual(["Q-1"]);
      expect(h.codes()).toContain("FIX_PATCH_REJECTED");
    }
  });
  it("a dangling id outside the open-question pattern (a step id) still goes back to the citing step, with no patch", async () => {
    const h = run({ step: id => citing(id, "TB-9"), fixStep: (id, user) => id === "TB-2" ? { ...(user.currentAnswer as object), effects: split.details["TB-2"]!.effects } : undefined });
    const out = await h.result;
    expect(h.fixCalls().filter(call => call.group === "patch")).toHaveLength(0);
    expect(h.fixCalls().filter(call => call.user.step)).toHaveLength(1);
    expect(dangling(out)).toEqual([]);
  });
  it("a repair carries the part's current answer in full: long text is never the shortened form the consistency review reads", async () => {
    const long = `${"A long statement about proration that runs well past every limit of the review's compact view. ".repeat(8)}Ends here. See TB-9.`;
    const h = run({ step: id => id === "TB-2" ? { ...split.details["TB-2"]!, effects: { ...split.details["TB-2"]!.effects, financial: long } } : undefined });
    await h.result;
    const sent = h.fixCalls().find(call => call.user.step)!.user.currentAnswer as { effects: { financial: string } };
    expect(sent.effects.financial).toBe(long);
    expect(JSON.stringify(sent)).not.toContain("…");
  });
  it("is skipped, with a warning and no call, when 40% or less of the budget is left", async () => {
    const h = run({ step: id => citing(id, "Q-2"), patch: () => ({ openQuestions: [question] }), deps: { remainingBudget: () => 0.4 } });
    const out = await h.result;
    expect(h.fixCalls()).toHaveLength(0);
    expect(dangling(out)).toHaveLength(1);
    expect(h.codes()).toContain("FIX_PATCH_SKIPPED_BUDGET");
  });
  it("collectTargets names the missing question and the steps that cite it, and leaves it out of the part targets", () => {
    const draft = structuredClone(rentalDraftV3);
    draft.steps[1]!.effects.financial = "Held under Q-7 and also TB-9.";
    const blockers = [{ code: "DANGLING_ID_REFERENCE", path: "draft.steps.1", detail: "Q-7 does not exist in this design" }, { code: "DANGLING_ID_REFERENCE", path: "draft.steps.1", detail: "TB-9 does not exist in this design" },
      { code: "DANGLING_ID_REFERENCE", path: "draft.openQuestions.0", detail: "Q-7 does not exist in this design" }];
    const { targets, newQuestions } = collectTargets(draft, blockers);
    expect(newQuestions).toEqual([{ token: "Q-7", stepIds: ["TB-2"] }]);
    expect(targets.map(target => [target.part, target.blockers.map(blocker => blocker.detail)])).toEqual([[{ type: "step", stepId: "TB-2" }, ["TB-9 does not exist in this design"]]]);
  });
});

describe("helpers", () => {
  it("only the blockers a rewrite of one part can clear are fixable", () => {
    for (const open of ["OPEN_QUESTION", "IMPLEMENTATION_UNVERIFIED", "TARGET_RELEASE_MISSING", "LICENSE_ENTITLEMENT_UNCONFIRMED", "INPUT_QUESTION_UNRESOLVED", "COVERAGE_CONDITIONAL"]) {
      expect(FIXABLE_BLOCKERS.has(open), open).toBe(false);
    }
    for (const code of ["OBJECTIVE_STEP_UNMAPPED", "STATUS_TRANSITION_MISSING", "REPORT_PAIN_POINT_UNCOVERED", "CONTROL_UNMAPPED", "UNRESOLVED_CODE", "INTERFACE_STEP_UNCOVERED",
      "CONFIG_CONFIRMATION_UNSUPPORTED", "KPI_VALUE_IGNORED", "TRUNCATED_TEXT", "LANGUAGE_FRAGMENT"]) expect(FIXABLE_BLOCKERS.has(code), code).toBe(true);
  });
  it("collectTargets groups by part and orders the busiest first; unattributable blockers and resolved findings are left out", () => {
    const blockers = [{ code: "OBJECTIVE_STEP_UNMAPPED", path: "draft.objectives" }, { code: "INTERNAL_TERM", path: "draft.steps.1", detail: "outline" }, { code: "OPEN_QUESTION", path: "draft.openQuestions.0" },
      { code: "E2E_STEP_UNCOVERED", path: "draft.endToEndTests" }, { code: "OBJECTIVE_CONTEXT_UNCOVERED", path: "draft.objectives" }];
    const findings: ReviewOutcome[] = [{ kind: "CONTRADICTION", paths: ["TB-2"], explanation: "x", outcome: "UNRESOLVED" as const, blockerPath: "draft.steps.1" },
      { kind: "CONTRADICTION", paths: ["TB-1"], explanation: "y", outcome: "REPAIRED" as const, blockerPath: "draft.steps.0" }];
    const { targets, newStep } = collectTargets(rentalDraftV3, blockers, findings);
    expect(targets.map(target => [target.part, target.blockers.length, target.findingIndexes])).toEqual([
      [{ type: "group", group: "scope" }, 2, []], [{ type: "step", stepId: "TB-2" }, 1, [0]], [{ type: "group", group: "reporting" }, 1, []]]);
    expect(newStep).toEqual([]);
    expect(collectTargets(rentalDraftV3, [], findings, new Set(["step:TB-2"])).targets).toEqual([]);
  });
  it("explains a blocker with the ids it concerns", () => {
    const note = explainBlocker({ code: "CONTROL_UNMAPPED", path: "draft.controlMappings" }, rentalDraftV3, withCompanyContext(fixture(), {}));
    expect(note).toContain("have no control mapping");
    expect(explainBlocker({ code: "TRUNCATED_TEXT", path: "draft.steps.0", detail: "ends with an ellipsis in field accountingEntry" }, rentalDraftV3, fixture())).toContain("ends with an ellipsis in field accountingEntry");
    expect(explainBlocker({ code: "LANGUAGE_FRAGMENT", path: "draft.steps.0", detail: "German text in field event" }, rentalDraftV3, fixture())).toContain("German text in field event");
    expect(explainBlocker({ code: "SOMETHING_NEW", path: "draft" }, rentalDraftV3, fixture())).toBe("SOMETHING_NEW");
  });
});
