import { describe, expect, it } from "vitest";
import { BLOCKER_DETAIL_MAX, evaluateDesign, type DesignContext, type DetailedDesign } from "../src/lib/ai/design-quality";
import { buildTypeOf } from "../src/lib/ai/design-registers-v3";
import { FIXABLE_BLOCKERS, explainBlocker } from "../src/lib/ai/to-be-fix";
import { REVIEW_FINDINGS, parseStoredToBe } from "../src/lib/consultant-report";
import { ricefwList } from "../src/lib/to-be-derived";
import { rentalContext } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";

// Generic weaknesses an independent judge found in a real To-Be; each check is a review finding (block) unless it is always repairable.
const design = (change: (draft: DetailedDesign) => void = () => {}) => { const draft = structuredClone(rentalDraftV3); change(draft); return draft; };
const key = (item: { code: string; path: string }) => `${item.code}@${item.path}`;
const baseline = (context: DesignContext = rentalContext) => new Set(evaluateDesign(context, rentalDraftV3).blockers.map(key));
const withContext = (...pairs: [string, string][]): DesignContext => ({ ...rentalContext, companyContext: pairs.map(([fieldId, value]) => ({ fieldId, value })) });
/** The blockers a change adds over the unchanged fixture, for the same context. */
const added = (draft: DetailedDesign, context: DesignContext = rentalContext) => {
  const before = baseline(context);
  return evaluateDesign(context, draft).blockers.filter(item => !before.has(key(item))).map(key);
};
const all = (draft: DetailedDesign, context: DesignContext = rentalContext) => evaluateDesign(context, draft).blockers.map(key);
const errors = (draft: DetailedDesign, context: DesignContext = rentalContext) => evaluateDesign(context, draft).errors.map(key);
const iface = (extra: object = {}) => ({ id: "IF-1", counterpartSystem: "Customer portal", direction: "INBOUND" as const, triggerFrequency: "Daily", payload: "Orders",
  errorOwner: "Billing clerk", outOfScopeReason: null, referenceIds: [], needsValidation: true, validationReason: "API to be confirmed", requirementIds: [], contextFieldIds: [],
  stepIds: ["TB-1"], failureHandling: { detection: "Error list", alerting: "Mail", rerun: "Resend after correction", idempotency: "Message key stored" }, systemOfRecord: "SAP", ...extra });

describe("CL19: every built realization carries a RICEFW type and reaches the list", () => {
  it("a key-user extension or side-by-side row must state its RICEFW type", () => {
    expect(errors(design())).toEqual([]);
    expect(errors(design(draft => { draft.fitGap![0]!.ricefwType = null; }))).toEqual(["RICEFW_TYPE_MISSING@draft.fitGap.0"]);
  });
  it("a step whose realization names a build that no built fit-gap row lists is a finding; a negated mention is not", () => {
    const standard = (draft: DetailedDesign) => { Object.assign(draft.fitGap![2]!, { classification: "CONFIGURATION", ricefwType: null, mitigationType: "CONFIGURE" }); };
    expect(added(design(standard))).toEqual([]);
    const build = (detail: string) => design(draft => { standard(draft); draft.steps[1]!.implementation = { ...draft.steps[1]!.implementation, detail }; });
    expect(added(build("Record the return with a key-user custom field for the condition grade.")).filter(item => item.startsWith("BUILD_REALIZATION_UNLISTED"))).toEqual(["BUILD_REALIZATION_UNLISTED@draft.steps.1"]);
    expect(added(build("Standard return handling, no custom code and no key-user extension needed."))).toEqual([]);
  });
  it("the derived list collects builds from steps, interfaces and migration programs that no fit-gap row carries", () => {
    const standard = design(draft => {
      draft.fitGap = draft.fitGap!.map(row => ({ ...row, classification: "CONFIGURATION" as const, ricefwType: null, mitigationType: "CONFIGURE" as const }));
      draft.steps[1]!.implementation = { ...draft.steps[1]!.implementation, detail: "Add a key-user custom field for the condition grade." };
      draft.interfaces = [iface({ stepIds: ["TB-1"] })];
      draft.dataMigration![0]!.approach = "Load with a custom load program, then reconcile.";
    });
    const list = ricefwList({ design: standard });
    expect(list.map(item => `${item.source}:${item.type}`).sort()).toEqual(["INTERFACE:INTERFACE", "MIGRATION:CONVERSION", "STEP:ENHANCEMENT"]);
    expect(ricefwList({ design: design(draft => { draft.interfaces = [iface({ outOfScopeReason: "Retired at go-live", failureHandling: null })]; }) }).some(item => item.source === "INTERFACE")).toBe(false);
  });
  it("classifies build text by what is built", () => {
    expect(buildTypeOf("A custom CDS view for margin")?.type).toBe("REPORT");
    expect(buildTypeOf("Adobe form for the challan")?.type).toBe("FORM");
    expect(buildTypeOf("A custom workflow for approval")?.type).toBe("WORKFLOW");
    expect(buildTypeOf("Key-user extension adds a field")?.type).toBe("ENHANCEMENT");
    expect(buildTypeOf("Standard app, no custom logic")).toBeNull();
  });
});

describe("CL10: document status models cover every lifecycle document and attribute transitions to the step that performs them", () => {
  it("a lifecycle document a step outputs with no status model is a finding on the model list", () => {
    const draft = design(draft => { draft.steps[2]!.outputDocuments = [...draft.steps[2]!.outputDocuments, "Advance shipping notice to the customer"]; });
    expect(added(draft)).toEqual(["STATUS_MODEL_UNCOVERED@draft.documentStatusModels"]);
    expect(added(design(d => { d.steps[2]!.outputDocuments = [...d.steps[2]!.outputDocuments, "Packing list"]; }))).toEqual([]);
    const covered = design(d => {
      d.steps[2]!.outputDocuments = [...d.steps[2]!.outputDocuments, "Advance shipping notice to the customer"];
      d.documentStatusModels!.push({ ...d.documentStatusModels![0]!, id: "DSM-2", documentType: "Advance shipping notice", transitions: [{ from: null, to: "Open", stepId: "TB-3", event: "Sent" }] });
    });
    expect(added(covered).filter(item => item.startsWith("STATUS_MODEL_UNCOVERED"))).toEqual([]);
  });
  it("a transition attributed to a step that neither outputs nor handles the document is a finding", () => {
    const model = (stepId: string) => design(d => {
      d.steps[2]!.outputDocuments = [...d.steps[2]!.outputDocuments, "Advance shipping notice to the customer"];
      d.documentStatusModels!.push({ ...d.documentStatusModels![0]!, id: "DSM-2", documentType: "Advance shipping notice", transitions: [{ from: null, to: "Open", stepId, event: "Sent" }] });
    });
    expect(added(model("TB-1"))).toContain("STATUS_TRANSITION_STEP_MISMATCH@draft.documentStatusModels.1");
    expect(added(model("TB-3"))).not.toContain("STATUS_TRANSITION_STEP_MISMATCH@draft.documentStatusModels.1");
  });
});

describe("CL24: owners are catalogue roles, one exact name each", () => {
  it("owners named in registers and step exceptions that are not role catalogue entries are findings, by id or exact name they pass", () => {
    expect(all(design()).filter(item => item.startsWith("ROLE_OWNER"))).toEqual([]);
    const found = all(design(d => { d.fitGap![0]!.owner = "Accounts payable lead"; d.masterDataPrerequisites![0]!.owner = "CFO"; d.steps[1]!.exceptions[0]!.owner = "Dispatch supervisor"; }));
    expect(found).toEqual(expect.arrayContaining(["ROLE_OWNER_UNCATALOGUED@draft.fitGap", "ROLE_OWNER_UNCATALOGUED@draft.masterDataPrerequisites", "ROLE_OWNER_UNCATALOGUED@draft.steps.1"]));
    const clean = design(d => {
      for (const row of [...d.fitGap!, ...d.keyDesignDecisions!, ...d.orgStructure!, ...d.masterDataPrerequisites!, ...d.cutover!, ...d.periodEndActivities!, ...d.configurationCatalogue!]) row.owner = "Rental coordinator";
      for (const step of d.steps) { step.exceptions.forEach(item => { item.owner = "ROLE-1"; }); step.masterData.forEach(item => { item.owner = "rental  coordinator."; }); }
    });
    expect(evaluateDesign(rentalContext, clean).blockers.filter(item => item.code === "ROLE_OWNER_UNCATALOGUED")).toEqual([]);
  });
  it("role names that differ only in punctuation or case are one role", () => {
    const twin = design(d => { d.roles!.push({ ...d.roles![0]!, id: "ROLE-9", name: "Rental  Coordinator." }); });
    expect(errors(twin)).toEqual(["DUPLICATE_ROLE@draft.roles"]);
    const comma = design(d => { d.roles![0]!.name = "Plant head, Chakan"; d.roles!.push({ ...d.roles![0]!, id: "ROLE-9", name: "Plant Head Chakan" }); });
    expect(errors(comma)).toContain("DUPLICATE_ROLE@draft.roles");
  });
});

describe("CL32: an interface needs a cutover item for its initial load or connection set-up", () => {
  it("is a finding on the cutover plan until a cutover or migration row names the counterpart or the interface", () => {
    const withInterface = design(d => { d.interfaces = [iface({ stepIds: ["TB-2"] })]; });
    expect(added(withInterface)).toContain("CUTOVER_INTERFACE_UNCOVERED@draft.cutover");
    const byName = design(d => { d.interfaces = [iface({ stepIds: ["TB-2"] })]; d.cutover!.push({ ...d.cutover![0]!, id: "CUT-2", sequence: 2, activity: "Set up the customer portal connection and load its open items.", stepIds: [] }); });
    expect(added(byName)).not.toContain("CUTOVER_INTERFACE_UNCOVERED@draft.cutover");
    const byId = design(d => { d.interfaces = [iface({ stepIds: ["TB-2"] })]; d.cutover![0]!.risk = "IF-1 credentials are not ready before the freeze."; });
    expect(added(byId)).not.toContain("CUTOVER_INTERFACE_UNCOVERED@draft.cutover");
    const outOfScope = design(d => { d.interfaces = [iface({ stepIds: ["TB-2"], outOfScopeReason: "Retired at go-live", failureHandling: null })]; });
    expect(added(outOfScope)).not.toContain("CUTOVER_INTERFACE_UNCOVERED@draft.cutover");
  });
});

describe("CL22: every required output and pain point has a report or KPI, or is out of scope", () => {
  const outputs = withContext(["required_outputs", "Delivery challan; part-wise margin statement"]);
  it("a required output no report or KPI names is a finding on the reports", () => {
    expect(all(design(), outputs)).toContain("REQUIRED_OUTPUT_UNCOVERED@draft.reports");
    const covered = design(d => { d.reports!.push({ ...d.reports![0]!, id: "REP-2", name: "Part-wise margin statement", purpose: "Margin by part for pricing review." }); });
    expect(all(covered, outputs)).toContain("REQUIRED_OUTPUT_UNCOVERED@draft.reports");
    const both = design(d => { d.reports!.push({ ...d.reports![0]!, id: "REP-2", name: "Part-wise margin statement" }, { ...d.reports![0]!, id: "REP-3", name: "Delivery challan print", purpose: "The challan travelling with the load." }); });
    expect(all(both, outputs)).not.toContain("REQUIRED_OUTPUT_UNCOVERED@draft.reports");
    expect(all(design(d => { d.scopeStatements!.push({ ...d.scopeStatements![1]!, id: "SCP-3", statement: "Part-wise margin statement and delivery challan are out of scope." }); }), outputs)).not.toContain("REQUIRED_OUTPUT_UNCOVERED@draft.reports");
  });
  it("a pain point covered by an out-of-scope statement that cites it is accounted for", () => {
    const pain: DesignContext = { ...rentalContext, requirements: rentalContext.requirements.map(item => ({ ...item, kind: item.id === "R-2" ? "PAIN_POINT" as const : "TO_BE_REQUIREMENT" as const })) };
    const open = design(d => { d.reports![0]!.requirementIds = ["R-3"]; });
    expect(evaluateDesign(pain, open).blockers.map(key)).toContain("REPORT_PAIN_POINT_UNCOVERED@draft.reports");
    const declared = design(d => { d.reports![0]!.requirementIds = ["R-3"]; d.scopeStatements![1]!.requirementIds = ["R-2"]; });
    expect(evaluateDesign(pain, declared).blockers.map(key)).not.toContain("REPORT_PAIN_POINT_UNCOVERED@draft.reports");
  });
});

describe("CL36: a business rule restated across steps is a finding on the later step", () => {
  it("flags a near-identical rule, not a rule that merely references the other", () => {
    const rule = { condition: "The returned asset is received at a plant other than the issuing plant and the customer has not confirmed the return.", response: "Hold the return and ask the dispatch supervisor to confirm the receiving plant before posting." };
    const twin = design(d => { d.steps[0]!.businessRules[0] = { id: "BR-1", ...rule }; d.steps[1]!.businessRules[0] = { id: "BR-3", ...rule, response: rule.response.replace("Hold", "Hold and keep") }; });
    expect(added(twin)).toContain("RULE_RESTATED@draft.steps.1");
    const reference = design(d => { d.steps[0]!.businessRules[0] = { id: "BR-1", ...rule }; d.steps[1]!.businessRules[0] = { id: "BR-3", condition: "As BR-1, with the return going directly to the second plant.", response: "Post the return to that plant." }; });
    expect(added(reference)).not.toContain("RULE_RESTATED@draft.steps.1");
  });
});

describe("the new findings reach the fix pass and the report", () => {
  const codes = ["STATUS_MODEL_UNCOVERED", "STATUS_TRANSITION_STEP_MISMATCH", "ROLE_OWNER_UNCATALOGUED", "CUTOVER_INTERFACE_UNCOVERED", "REQUIRED_OUTPUT_UNCOVERED", "RULE_RESTATED", "BUILD_REALIZATION_UNLISTED"];
  it("each is fixable, explained to the part that fixes it and described in the report", () => {
    for (const code of codes) {
      expect(FIXABLE_BLOCKERS.has(code), code).toBe(true);
      expect(REVIEW_FINDINGS[code], code).toBeTruthy();
      expect(explainBlocker({ code, path: "draft.steps.0", detail: "x" }, rentalDraftV3, { discovery: { requirements: [] } } as never), code).not.toBe(code);
    }
  });
});

describe("blocker detail is bounded where it is written", () => {
  it("a STATUS_MODEL_UNCOVERED joining many long outputs stays within BLOCKER_DETAIL_MAX and the stored shape parses", () => {
    const long = (n: number) => `Advance shipping notice number ${n} to the customer ${"with a long free-text description ".repeat(6)}`;
    const draft = design(d => { d.steps[2]!.outputDocuments = [...d.steps[2]!.outputDocuments, ...[1, 2, 3, 4, 5, 6].map(long)]; });
    const { blockers } = evaluateDesign(rentalContext, draft);
    const joined = blockers.find(item => item.code === "STATUS_MODEL_UNCOVERED");
    expect(joined?.detail?.length).toBeGreaterThan(0);
    expect(blockers.length).toBeGreaterThan(0);
    for (const item of blockers) expect((item.detail ?? "").length).toBeLessThanOrEqual(BLOCKER_DETAIL_MAX);
    expect(() => parseStoredToBe({ design: draft, evaluation: { blockers }, unresolvedInputQuestions: [], sourceRevision: 1, snapshotId: "s" })).not.toThrow();
  });
});
