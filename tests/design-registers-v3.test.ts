import { describe, expect, it } from "vitest";
import { DetailedDesignSchema, evaluateDesign, type DesignContext, type DetailedDesign } from "../src/lib/ai/design-quality";
import { LATE_GROUPS, REGISTER_GROUPS, RegisterGroupSchemas, VERSION_2_KEYS } from "../src/lib/ai/design-registers";
import { StepDetailSchema } from "../src/lib/ai/to-be-pipeline";
import { rentalContext, rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { splitDesign } from "./support/to-be-split";
import { rentalDraftV2, rentalDraftV3, rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";

const reference = { id: "REF-OBJ", targetProduct: "S4HANA_CLOUD_PRIVATE" as const, targetRelease: "TBD", status: "VERIFIED" as const, evidence: "synthetic",
  fitType: "STANDARD" as const, capability: "Hire order handling", objects: [], limitations: [] };
const withKinds = (kinds: Record<string, "PAIN_POINT" | "TO_BE_REQUIREMENT" | "CONTROL">): DesignContext => ({ ...rentalContext,
  requirements: rentalContext.requirements.map(item => ({ ...item, kind: kinds[item.id] ?? "TO_BE_REQUIREMENT" })) });
const design = (change: (draft: DetailedDesign) => void = () => {}) => { const draft = structuredClone(rentalDraftV3); change(draft); return draft; };
const codes = (draft: DetailedDesign, context: DesignContext = rentalContext) => evaluateDesign(context, draft).errors.map(error => `${error.code}@${error.path}`);
/** Blockers the change adds: the rental fixture already carries the ordinary ones (open question, unverified implementation). */
const blocked = (draft: DetailedDesign, context: DesignContext = rentalContext) => {
  const key = (item: { code: string; path: string }) => `${item.code}@${item.path}`;
  const baseline = new Set(evaluateDesign(rentalContext, rentalDraftV3).blockers.map(key));
  return evaluateDesign(context, draft).blockers.map(key).filter(item => !baseline.has(item));
};
const answered = (...pairs: [string, string][]): Partial<DesignContext> => ({ companyContext: pairs.map(([fieldId, value]) => ({ fieldId, value })) });
/** A heuristic finding: no error, the design is structurally valid, and the finding is the only blocker the check adds. */
const expectFinding = (draft: DetailedDesign, finding: string, context: DesignContext = rentalContext) => {
  const result = evaluateDesign(context, draft);
  expect(result.errors).toEqual([]);
  expect(result.structurallyValid).toBe(true);
  expect(result.reviewStatus).toBe("BLOCKED");
  expect(blocked(draft, context)).toEqual([finding]);
};
// Each helper below is non-null by construction of the rental fixture.
const at = <T,>(list: T[] | undefined, i = 0) => list![i]!;

describe("schema versions 1, 2 and 3", () => {
  it("the version 3 fixture is valid and carries every register", () => {
    expect(codes(rentalDraftV3)).toEqual([]);
    expect(rentalDraftV3.schemaVersion).toBe(3);
  });
  it("a version 2 design stored before version 3 still parses and validates, without the new fields", () => {
    expect(rentalDraftV2.schemaVersion).toBe(2);
    expect(DetailedDesignSchema.safeParse(rentalDraftV2).success).toBe(true);
    expect(codes(rentalDraftV2)).toEqual([]);
    expect(at(rentalDraftV2.fitGap)).not.toHaveProperty("mitigationType");
  });
  it("a version 2 design may not carry a version 3 register, and a version 3 design needs all of them", () => {
    expect(codes({ ...rentalDraftV2, roles: [] })).toEqual(["REGISTER_VERSION_MISMATCH@draft.roles"]);
    const missing = design(draft => { delete draft.roles; delete draft.reports; });
    expect(codes(missing)).toEqual(expect.arrayContaining(["REGISTER_MISSING@draft.roles", "REGISTER_MISSING@draft.reports"]));
  });
  it("a version 3 design needs the version 3 fields of the older registers (stored rows may omit them only in version 2)", () => {
    const stripped = design(draft => { delete draft.fitGap![0]!.mitigationType; delete draft.orgStructure![0]!.parentId; delete draft.masterDataPrerequisites![0]!.creationChannel; });
    expect(codes(stripped)).toEqual(expect.arrayContaining(["REGISTER_FIELD_MISSING@draft.fitGap.0", "REGISTER_FIELD_MISSING@draft.orgStructure.0",
      "REGISTER_FIELD_MISSING@draft.masterDataPrerequisites.0"]));
  });
  it("every register key belongs to exactly one group, and only documents and governance wait for the steps", () => {
    const keys = Object.values(REGISTER_GROUPS).flat();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(VERSION_2_KEYS.length + 10);
    expect([...LATE_GROUPS]).toEqual(["documents", "governance"]);
  });
  it("model answers require the version 3 fields that stored version 2 rows lack", () => {
    const old = { fitGap: [{ ...at(rentalRegisterGroups.fitgap.fitGap), mitigationType: undefined }] };
    expect(RegisterGroupSchemas.fitgap.safeParse(old).success).toBe(false);
    expect(RegisterGroupSchemas.fitgap.safeParse({ fitGap: [{ ...at(rentalRegisterGroups.fitgap.fitGap), status: "CLOSED" }] }).success).toBe(false);
    for (const group of Object.keys(REGISTER_GROUPS) as (keyof typeof REGISTER_GROUPS)[]) {
      expect(RegisterGroupSchemas[group].safeParse(rentalRegisterGroups[group]).success, group).toBe(true);
      expect(RegisterGroupSchemas[group].safeParse({ ...rentalRegisterGroups[group], extra: [] }).success, group).toBe(false);
    }
  });
});

describe("step type and phase (checklists 7 and 14)", () => {
  const detail = () => {
    const rest: Record<string, unknown> = structuredClone(rentalDraftV3.steps[0]!);
    for (const key of ["id", "sequence", "title", "asIsStepIds", "requirementIds"]) delete rest[key];
    return { ...rest, implementation: { detail: rentalDraftV3.steps[0]!.implementation.detail } };
  };
  it("a step answer must carry stepType, a well-formed phase and interimProcess", () => {
    expect(StepDetailSchema.safeParse(detail()).success).toBe(true);
    for (const key of ["stepType", "phase", "interimProcess"]) expect(StepDetailSchema.safeParse({ ...detail(), [key]: undefined }).success, key).toBe(false);
    expect(StepDetailSchema.safeParse({ ...detail(), stepType: "MANUAL" }).success).toBe(false);
    expect(StepDetailSchema.safeParse({ ...detail(), phase: "Later" }).success).toBe(false);
    for (const phase of ["Phase 2", "Phase 12", "Deferred"]) expect(StepDetailSchema.safeParse({ ...detail(), phase }).success, phase).toBe(true);
  });
  it("a version 3 step without type or phase is rejected at the step", () => {
    expect(codes(design(draft => { delete draft.steps[1]!.stepType; }))).toEqual(["STEP_TYPE_MISSING@draft.steps.1"]);
    expect(codes(design(draft => { delete draft.steps[2]!.phase; }))).toEqual(["STEP_PHASE_MISSING@draft.steps.2"]);
  });
  it("a step in a later phase or deferred needs its interim process; Phase 1 does not", () => {
    expect(codes(design(draft => { draft.steps[0]!.phase = "Deferred"; }))).toEqual(["STEP_INTERIM_MISSING@draft.steps.0"]);
    expect(codes(design(draft => { Object.assign(draft.steps[0]!, { phase: "Phase 2", interimProcess: "The coordinator keeps the hire list in a spreadsheet until Phase 2." }); }))).toEqual([]);
  });
});

describe("extended registers (checklists 15, 17, 21, 23, 27)", () => {
  it("an organisation unit's parent must be another unit, with no cycle", () => {
    const two = (change: (draft: DetailedDesign) => void) => design(draft => {
      draft.orgStructure!.push({ ...at(draft.orgStructure), id: "ORG-2", unitType: "Plant", parentId: "ORG-1" }); change(draft); });
    expect(codes(two(() => {}))).toEqual([]);
    expect(codes(two(draft => { draft.orgStructure![1]!.parentId = "ORG-9"; }))).toEqual(["ORG_PARENT_UNKNOWN@draft.orgStructure.1"]);
    expect(codes(two(draft => { draft.orgStructure![1]!.parentId = "ORG-2"; }))).toEqual(expect.arrayContaining(["ORG_PARENT_UNKNOWN@draft.orgStructure.1"]));
    expect(codes(two(draft => { draft.orgStructure![0]!.parentId = "ORG-2"; }))).toEqual(["ORG_PARENT_CYCLE@draft.orgStructure.0", "ORG_PARENT_CYCLE@draft.orgStructure.1"]);
  });
  it("master data states its creation channel and governance (text required by the schema)", () => {
    const row = at(rentalRegisterGroups.foundation.masterDataPrerequisites);
    expect(RegisterGroupSchemas.foundation.safeParse({ ...rentalRegisterGroups.foundation, masterDataPrerequisites: [{ ...row, governance: "" }] }).success).toBe(false);
    expect(RegisterGroupSchemas.foundation.safeParse({ ...rentalRegisterGroups.foundation, masterDataPrerequisites: [{ ...row, creationChannel: undefined }] }).success).toBe(false);
  });
  const iface = (extra: object = {}) => ({ id: "IF-1", counterpartSystem: "Customer portal", direction: "INBOUND" as const, triggerFrequency: "Daily", payload: "Orders",
    errorOwner: "Integration lead", outOfScopeReason: null, referenceIds: [], needsValidation: true, validationReason: "API to be confirmed", requirementIds: [], contextFieldIds: [],
    stepIds: ["TB-1"], failureHandling: { detection: "Error list", alerting: "Mail", rerun: "Resend after correction", idempotency: "Message key stored" }, systemOfRecord: "SAP", ...extra });
  it("an interface in scope must say how a failed message is seen, alerted, rerun and kept idempotent", () => {
    expect(codes(design(draft => { draft.interfaces = [iface()]; }))).toEqual([]);
    expect(codes(design(draft => { draft.interfaces = [iface({ failureHandling: null })]; }))).toEqual(["INTERFACE_FAILURE_HANDLING_MISSING@draft.interfaces.0"]);
    expect(codes(design(draft => { draft.interfaces = [iface({ failureHandling: null, outOfScopeReason: "Retired at go-live", needsValidation: false, validationReason: null })]; }))).toEqual([]);
    expect(RegisterGroupSchemas.integration.safeParse({ interfaces: [iface({ failureHandling: { detection: "x", alerting: "y", rerun: "z" } })], kpis: [] }).success).toBe(false);
  });
  const kpi = (extra: object = {}) => ({ id: "KPI-1", name: "Share of items returned on time", baseline: "not provided", target: "not provided", measuredFrom: "Return records", referenceIds: [],
    needsValidation: true, validationReason: "App to be confirmed", requirementIds: [], contextFieldIds: [], stepIds: ["TB-2"], owner: "Rental operations lead", producingStepId: "TB-2", ...extra });
  it("a KPI has an owner and the step that produces its data, which exists", () => {
    expect(codes(design(draft => { draft.kpis = [kpi()]; }))).toEqual([]);
    expect(codes(design(draft => { draft.kpis = [kpi({ producingStepId: "TB-9" })]; }))).toEqual(["UNKNOWN_STEP@draft.kpis.0"]);
    expect(codes(design(draft => { draft.kpis = [{ ...kpi(), owner: undefined } as never]; }))).toEqual(["REGISTER_FIELD_MISSING@draft.kpis.0"]);
  });
  it("a gap's mitigation must agree with its classification, and its status is OPEN", () => {
    expect(codes(design(draft => { draft.fitGap![0]!.mitigationType = "DEVELOP_CUSTOM"; }))).toEqual(["MITIGATION_CLASS_MISMATCH@draft.fitGap.0"]);
    expect(codes(design(draft => { draft.fitGap![3]!.mitigationType = "EXTEND_KEY_USER"; }))).toEqual(["MITIGATION_CLASS_MISMATCH@draft.fitGap.3"]);
    expect(codes(design(draft => { Object.assign(draft.fitGap![3]!, { classification: "STANDARD_INTEGRATION", mitigationType: "CONFIGURE" }); }))).toEqual([]);
  });
});

describe("objectives and scope (checklist 2)", () => {
  it("needs an objective, and every step must serve one", () => {
    expect(codes(design(draft => { draft.objectives = []; }))).toEqual(["OBJECTIVE_MISSING@draft.objectives"]);
    expect(codes(design(draft => { draft.objectives![1]!.stepIds = []; }))).toEqual(["OBJECTIVE_NO_STEPS@draft.objectives.1"]);
    // A step no objective serves is a review finding: the design stays valid.
    expectFinding(design(draft => { draft.objectives![1]!.stepIds = ["TB-2"]; }), "OBJECTIVE_STEP_UNMAPPED@draft.objectives");
  });
  it("an objective must cite a requirement or a context answer, and every answered outcome, target or constraint must be cited", () => {
    expect(codes(design(draft => { Object.assign(draft.objectives![0]!, { requirementIds: [], contextFieldIds: [] }); }))).toEqual(["REGISTER_TRACE_MISSING@draft.objectives.0"]);
    const context = { ...rentalContext, ...answered(["desired_outcome", "Every hire unit tracked on its own"], ["constraints", "No custom code in the core"]) };
    expectFinding(design(), "OBJECTIVE_CONTEXT_UNCOVERED@draft.objectives", context);
    expect(blocked(design(draft => { draft.objectives![0]!.contextFieldIds = ["desired_outcome", "constraints"]; }), context)).toEqual([]);
  });
  it("needs both an in-scope and an out-of-scope statement", () => {
    expect(codes(design(draft => { draft.scopeStatements = draft.scopeStatements!.filter(row => row.kind === "IN_SCOPE"); }))).toEqual(["SCOPE_STATEMENT_MISSING@draft.scopeStatements.OUT_OF_SCOPE"]);
    expect(codes(design(draft => { draft.scopeStatements = []; }))).toEqual(["SCOPE_STATEMENT_MISSING@draft.scopeStatements.IN_SCOPE", "SCOPE_STATEMENT_MISSING@draft.scopeStatements.OUT_OF_SCOPE"]);
    expect(codes(design(draft => { draft.scopeStatements![1]!.requirementIds = ["R-99"]; }))).toEqual(["UNKNOWN_REQUIREMENT@draft.scopeStatements.1"]);
  });
});

describe("document status models and configuration catalogue (checklists 10, 11, 16)", () => {
  it("needs a model; statuses in transitions must be declared; transitions sit on real steps", () => {
    expect(codes(design(draft => { draft.documentStatusModels = []; draft.configurationCatalogue![0]!.category = "OTHER"; }))).toEqual(["STATUS_MODEL_MISSING@draft.documentStatusModels"]);
    expect(codes(design(draft => { draft.documentStatusModels![0]!.transitions[1]!.to = "Lost"; }))).toEqual(["STATUS_UNKNOWN@draft.documentStatusModels.0"]);
    expect(codes(design(draft => { draft.documentStatusModels![0]!.transitions[1]!.from = "Closed"; }))).toEqual(["STATUS_UNKNOWN@draft.documentStatusModels.0"]);
    expect(codes(design(draft => { draft.documentStatusModels![0]!.transitions[1]!.stepId = "TB-9"; }))).toEqual(["UNKNOWN_STEP@draft.documentStatusModels.0"]);
    expect(codes(design(draft => { draft.documentStatusModels![0]!.statuses.push("open"); }))).toEqual(["DUPLICATE_STATUS@draft.documentStatusModels.0"]);
  });
  it("needs edit and lock rules (schema), and a transition at each step whose output names the document type", () => {
    const model = at(rentalRegisterGroups.documents.documentStatusModels);
    expect(RegisterGroupSchemas.documents.safeParse({ ...rentalRegisterGroups.documents, documentStatusModels: [{ ...model, editLockRules: [] }] }).success).toBe(false);
    expectFinding(design(draft => { draft.documentStatusModels![0]!.transitions = draft.documentStatusModels![0]!.transitions.filter(item => item.stepId !== "TB-1"); }), "STATUS_TRANSITION_MISSING@draft.documentStatusModels.0");
  });
  it("every modelled document type is in the catalogue as a document type", () => {
    expectFinding(design(draft => { draft.configurationCatalogue![0]!.name = "Return voucher"; }), "CONFIG_DOCUMENT_TYPE_MISSING@draft.documentStatusModels.0");
    const empty = design(draft => { draft.configurationCatalogue = []; });
    expect(codes(empty)).toEqual(["CONFIG_CATALOGUE_MISSING@draft.configurationCatalogue"]);
    expect(blocked(empty)).toEqual(["CONFIG_DOCUMENT_TYPE_MISSING@draft.documentStatusModels.0"]);
  });
  it("a catalogue item is confirmed only with a catalog reference, and otherwise says what is missing", () => {
    const item = (draft: DetailedDesign) => draft.configurationCatalogue![0]!;
    expect(codes(design(draft => { item(draft).status = "CONFIRMED_IN_CATALOG"; }))).toEqual(["CONFIG_CONFIRMATION_MISSING@draft.configurationCatalogue.0"]);
    expect(codes(design(draft => { Object.assign(item(draft), { status: "CONFIRMED_IN_CATALOG", referenceIds: ["NOPE"], note: null }); }), rentalContext)).toEqual(expect.arrayContaining(["UNKNOWN_REFERENCE@draft.configurationCatalogue.0"]));
    expect(codes(design(draft => { Object.assign(item(draft), { status: "CONFIRMED_IN_CATALOG", referenceIds: ["REF-OBJ"], note: null }); }), { ...rentalContext, references: [reference] })).toEqual([]);
    expect(codes(design(draft => { item(draft).note = null; }))).toEqual(["VALIDATION_REASON_MISSING@draft.configurationCatalogue.0"]);
  });
  it("a confirmation counts only when a cited reference mentions the item: otherwise CONFIG_CONFIRMATION_UNSUPPORTED (a blocker, not an error)", () => {
    const found = (name: string, references: unknown[] = [reference]) => {
      const draft = design(d => { Object.assign(d.configurationCatalogue![0]!, { name, status: "CONFIRMED_IN_CATALOG", referenceIds: ["REF-OBJ"], note: null }); });
      const result = evaluateDesign({ ...rentalContext, references: references as DesignContext["references"] }, draft);
      return { errors: result.errors, unsupported: result.blockers.some(item => item.code === "CONFIG_CONFIRMATION_UNSUPPORTED" && item.path === "draft.configurationCatalogue.0") };
    };
    expect(found("Hire order")).toEqual({ errors: [], unsupported: false });                // the capability "Hire order handling" names it
    expect(found("Hire orders document type")).toEqual({ errors: [], unsupported: false }); // a plural and generic words still meet the capability
    expect(found("Credit memo reason")).toEqual({ errors: [], unsupported: true });         // the reference is about hire orders, not credit memos
    expect(found("Hire order", [{ ...reference, capability: "Invoice handling", objects: ["VF01"] }])).toEqual({ errors: [], unsupported: true });
    expect(found("Hire order", [{ ...reference, capability: undefined as never, objects: ["Hire order type ZHO"] }])).toEqual({ errors: [], unsupported: false }); // an object name counts
    expect(found("Type")).toEqual({ errors: [], unsupported: false });                      // a name of generic words proves nothing either way
    // Items that do not claim a confirmation are not judged.
    expect(evaluateDesign(rentalContext, rentalDraftV3).blockers.some(item => item.code === "CONFIG_CONFIRMATION_UNSUPPORTED")).toBe(false);
  });
  it("an SAP object named in the catalogue must be in the curated catalog", () => {
    expect(evaluateDesign(rentalContext, design(draft => { draft.configurationCatalogue![0]!.purpose = "Use Fiori app F9999 to create it."; })).errors)
      .toEqual([{ code: "UNKNOWN_SAP_OBJECT", path: "draft.configurationCatalogue.0.purpose", detail: "FIORI_APP F9999" }]);
  });
});

describe("roles, segregation of duties and control mappings (checklists 24 to 26)", () => {
  it("every step is covered by a role named like the step's actor", () => {
    const short = design(draft => { draft.roles = draft.roles!.slice(0, 2); });
    expect(codes(short)).toEqual(["UNKNOWN_ROLE@draft.sodAssessments.0"]);
    expect(blocked(short)).toEqual(["ROLE_STEP_UNCOVERED@draft.steps.2"]);
    expectFinding(design(draft => { draft.roles![2]!.name = "Accounts clerk"; }), "ROLE_ACTOR_UNMATCHED@draft.steps.2");
    const none = design(draft => { draft.roles = []; });
    expect(codes(none)).toEqual(expect.arrayContaining(["ROLE_MISSING@draft.roles"]));
    expect(blocked(none)).toEqual(["ROLE_STEP_UNCOVERED@draft.steps.0", "ROLE_STEP_UNCOVERED@draft.steps.1", "ROLE_STEP_UNCOVERED@draft.steps.2"]);
    expect(blocked(design(draft => { draft.roles![2]!.name = "billing CLERK"; }))).toEqual([]); // case does not matter
    const twin = design(draft => { draft.roles![1]!.name = "Billing clerk"; });
    expect(codes(twin)).toEqual(["DUPLICATE_ROLE@draft.roles"]);
    expect(blocked(twin)).toEqual(["ROLE_ACTOR_UNMATCHED@draft.steps.1"]);
  });
  it("segregation of duties is assessed: a row exists, uses known roles, and a conflict spans two steps", () => {
    expect(codes(design(draft => { draft.sodAssessments = []; }))).toEqual(["SOD_ASSESSMENT_MISSING@draft.sodAssessments"]);
    expect(codes(design(draft => { draft.sodAssessments![0]!.roleIds = ["ROLE-9"]; }))).toEqual(["UNKNOWN_ROLE@draft.sodAssessments.0"]);
    // A conflict that names fewer than two steps is incomplete, not wrong: a review finding, never a structural error.
    expectFinding(design(draft => { Object.assign(draft.sodAssessments![0]!, { assessment: "CONFLICT_IDENTIFIED", stepIds: ["TB-2"] }); }), "SOD_CONFLICT_STEPS@draft.sodAssessments.0");
    expect(codes(design(draft => { draft.sodAssessments![0]!.assessment = "CONFLICT_IDENTIFIED"; }))).toEqual([]);
  });
  const control = withKinds({ "R-4": "CONTROL" });
  const mapping = (extra: object = {}) => ({ id: "CTL-1", requirementId: "R-4", mechanism: "BUSINESS_RULE" as const, realization: "A missing return date blocks completion.", stepIds: ["TB-2"], ruleId: "BR-3", ...extra });
  it("every control requirement from discovery has a mapping", () => {
    expectFinding(design(), "CONTROL_UNMAPPED@draft.controlMappings", control);
    expect(evaluateDesign(control, design(draft => { draft.controlMappings = [mapping()]; })).blockers.map(item => item.code)).not.toContain("CONTROL_UNMAPPED");
    expect(blocked(design(draft => { draft.controlMappings = [mapping({ mechanism: "WORKFLOW", ruleId: null })]; }), control)).not.toContain("CONTROL_UNMAPPED@draft.controlMappings");
  });
  it("a mapping to a business rule names a rule that belongs to its steps", () => {
    expect(codes(design(draft => { draft.controlMappings = [mapping({ ruleId: null })]; }), control)).toEqual(["CONTROL_RULE_MISSING@draft.controlMappings.0"]);
    expect(codes(design(draft => { draft.controlMappings = [mapping({ ruleId: "BR-1" })]; }), control)).toEqual(["CONTROL_RULE_UNKNOWN@draft.controlMappings.0"]);
    expect(codes(design(draft => { draft.controlMappings = [mapping({ requirementId: "R-99" })]; }), control)).toEqual(expect.arrayContaining(["UNKNOWN_REQUIREMENT@draft.controlMappings.0"]));
  });
});

describe("reports and end-to-end tests (checklists 22, 33)", () => {
  const pain = withKinds({ "R-4": "PAIN_POINT" });
  it("needs a report with a purpose and SAP basis; every pain point is cited by a report or KPI", () => {
    expect(codes(design(draft => { draft.reports = []; }))).toEqual(["REPORT_MISSING@draft.reports"]);
    expect(codes(design(draft => { draft.reports![0]!.needsValidation = false; }))).toEqual(["SAP_BASIS_MISSING@draft.reports.0"]);
    expectFinding(design(), "REPORT_PAIN_POINT_UNCOVERED@draft.reports", pain);
    expect(blocked(design(draft => { draft.reports![0]!.requirementIds = ["R-3", "R-4"]; }), pain)).not.toContain("REPORT_PAIN_POINT_UNCOVERED@draft.reports");
  });
  it("end-to-end scenarios span at least two steps, cite a requirement, and together walk every step", () => {
    const noTests = design(draft => { draft.endToEndTests = []; });
    expect(codes(noTests)).toEqual(["E2E_TEST_MISSING@draft.endToEndTests"]);
    expect(blocked(noTests)).toEqual(["E2E_STEP_UNCOVERED@draft.endToEndTests"]);
    expectFinding(design(draft => { draft.endToEndTests![0]!.stepIds = ["TB-1", "TB-2"]; }), "E2E_STEP_UNCOVERED@draft.endToEndTests");
    const row = at(rentalRegisterGroups.reporting.endToEndTests);
    expect(RegisterGroupSchemas.reporting.safeParse({ ...rentalRegisterGroups.reporting, endToEndTests: [{ ...row, stepIds: ["TB-1"] }] }).success).toBe(false);
    expect(RegisterGroupSchemas.reporting.safeParse({ ...rentalRegisterGroups.reporting, endToEndTests: [{ ...row, requirementIds: [] }] }).success).toBe(false);
  });
});

describe("register ids stay unique across all registers", () => {
  it("a new register row may not reuse a step, rule or other register id", () => {
    expect(codes(design(draft => { draft.roles![0]!.id = "TB-1"; }))).toEqual(["DUPLICATE_OUTPUT_ID@draft.roles.0"]);
    expect(codes(design(draft => { draft.reports![0]!.id = "KDD-1"; }))).toEqual(["DUPLICATE_OUTPUT_ID@draft.reports.0"]);
  });
});

describe("version 3 additions: codes, organisation codes, system of record, period end, internal wording", () => {
  const withText = (change: (draft: DetailedDesign) => void) => design(draft => change(draft));
  it("a code a step uses that no register defines is a review finding on that step, naming the code; defining it in the catalogue or organisation clears it", () => {
    const used = withText(draft => { draft.steps[1]!.actions[0]!.operation += " Post with document type ZHO for plant 4100."; });
    const result = evaluateDesign(rentalContext, used);
    expect(result.errors).toEqual([]);
    expect(result.blockers).toContainEqual({ code: "UNRESOLVED_CODE", path: "draft.steps.1", detail: "document type ZHO, org code 4100" });
    const defined = withText(draft => {
      draft.steps[1]!.actions[0]!.operation += " Post with document type ZHO for plant 4100.";
      draft.configurationCatalogue!.push({ ...at(draft.configurationCatalogue), id: "CFG-2", category: "DOCUMENT_TYPE", name: "Document type ZHO", purpose: "Hire order", stepIds: ["TB-2"] });
      draft.orgStructure![0]!.proposal = "Plant 4100 for the hire business";
    });
    expect(evaluateDesign(rentalContext, defined).blockers.some(item => item.code === "UNRESOLVED_CODE")).toBe(false);
    // Negative control: the same design without the definitions does flag, so the clean result above means something.
    expect(evaluateDesign(rentalContext, used).blockers.some(item => item.code === "UNRESOLVED_CODE")).toBe(true);
  });
  it("a plant number in step text that no organisation unit holds is unresolved even when a configuration item merely discusses that number", () => {
    const text = (draft: DetailedDesign) => { draft.steps[1]!.masterData[0]!.fields.push("plant 2000 (Sheffield)"); };
    const mentioned = withText(draft => {
      text(draft);
      draft.configurationCatalogue!.push({ ...at(draft.configurationCatalogue), id: "CFG-3", category: "OTHER", name: "Planning segments behind org code 2000", purpose: "To be confirmed", stepIds: ["TB-2"] });
    });
    expect(evaluateDesign(rentalContext, mentioned).blockers).toContainEqual({ code: "UNRESOLVED_CODE", path: "draft.steps.1", detail: "org code 2000" });
    // Negative control: an organisation unit that holds 2000 clears it.
    const held = withText(draft => { text(draft); draft.orgStructure![0]!.proposal = "Plant 2000 for the hire business"; });
    expect(evaluateDesign(rentalContext, held).blockers.some(item => item.code === "UNRESOLVED_CODE")).toBe(false);
  });
  it("an organisational unit has a code status and an owner; a unit without a code is BUSINESS_TO_PROVIDE with an owner", () => {
    expect(codes(design(draft => { delete (draft.orgStructure![0] as Record<string, unknown>).owner; }))).toContain("REGISTER_FIELD_MISSING@draft.orgStructure.0");
    expect(codes(design(draft => { draft.orgStructure![0]!.codeStatus = "CODE_CONFIRMED"; }))).toContain("ORG_CODE_INCONSISTENT@draft.orgStructure.0");
    expect(codes(design(draft => { draft.orgStructure![0]!.code = "4100"; }))).toContain("ORG_CODE_INCONSISTENT@draft.orgStructure.0");
    const row = at(rentalRegisterGroups.scope.orgStructure);
    expect(RegisterGroupSchemas.scope.safeParse({ ...rentalRegisterGroups.scope, orgStructure: [{ ...row, owner: undefined }] }).success).toBe(false);
    expect(RegisterGroupSchemas.scope.safeParse({ ...rentalRegisterGroups.scope, orgStructure: [{ ...row, codeStatus: "OPEN_POINT" }] }).success).toBe(false);
    // A confirmed code must come from the answers; one that does not appear there is a finding, not an error.
    const confirmed = design(draft => { draft.orgStructure![0]!.codeStatus = "CODE_CONFIRMED"; draft.orgStructure![0]!.code = "4100"; });
    expect(evaluateDesign(rentalContext, confirmed).errors).toEqual([]);
    expect(evaluateDesign(rentalContext, confirmed).blockers).toContainEqual({ code: "ORG_CODE_NOT_IN_CONTEXT", path: "draft.orgStructure.0" });
    const answeredCode = { ...rentalContext, companyContext: [{ fieldId: "target_org_units", value: "One plant, plant code 4100" }] };
    expect(evaluateDesign(answeredCode, confirmed).blockers.some(item => item.code === "ORG_CODE_NOT_IN_CONTEXT")).toBe(false);
  });
  it("an interface names its system of record, and an integration step must be listed by some interface", () => {
    const row = { id: "IF-1", counterpartSystem: "Customer portal", direction: "INBOUND" as const, triggerFrequency: "Daily", payload: "Proof of delivery", errorOwner: "Integration lead",
      outOfScopeReason: null, referenceIds: [], needsValidation: true, validationReason: "API to be confirmed", requirementIds: [], contextFieldIds: [], stepIds: ["TB-1"],
      failureHandling: { detection: "Error list", alerting: "Mail", rerun: "Resend", idempotency: "Key stored" }, systemOfRecord: "SAP" };
    expect(codes(design(draft => { draft.interfaces = [{ ...row, systemOfRecord: undefined } as never]; }))).toContain("REGISTER_FIELD_MISSING@draft.interfaces.0");
    expect(RegisterGroupSchemas.integration.safeParse({ interfaces: [{ ...row, systemOfRecord: undefined }], kpis: [] }).success).toBe(false);
    const integrationStep = (listed: boolean) => design(draft => { draft.steps[0]!.stepType = "INTEGRATION"; draft.interfaces = [{ ...row, stepIds: listed ? ["TB-1"] : ["TB-2"] }]; });
    expect(evaluateDesign(rentalContext, integrationStep(false)).blockers).toContainEqual({ code: "INTERFACE_STEP_UNCOVERED", path: "draft.steps.0" });
    expect(evaluateDesign(rentalContext, integrationStep(true)).blockers.some(item => item.code === "INTERFACE_STEP_UNCOVERED")).toBe(false);
  });
  it("period-end activities are a version 3 register in the foundation group: traced, sequenced, owned; none at all is a finding", () => {
    expect(rentalDraftV3.periodEndActivities!.length).toBeGreaterThan(0);
    expect(REGISTER_GROUPS.foundation).toContain("periodEndActivities");
    expect(codes(design(draft => { delete draft.periodEndActivities; }))).toContain("REGISTER_MISSING@draft.periodEndActivities");
    expect(codes({ ...rentalDraftV2, periodEndActivities: [] })).toEqual(["REGISTER_VERSION_MISMATCH@draft.periodEndActivities"]);
    expect(codes(design(draft => { draft.periodEndActivities![0]!.stepIds = ["TB-9"]; }))).toContain("UNKNOWN_STEP@draft.periodEndActivities.0");
    expectFinding(design(draft => { draft.periodEndActivities = []; }), "PERIOD_END_MISSING@draft.periodEndActivities");
    const row = at(rentalRegisterGroups.foundation.periodEndActivities);
    expect(RegisterGroupSchemas.foundation.safeParse({ ...rentalRegisterGroups.foundation, periodEndActivities: [{ ...row, owner: undefined }] }).success).toBe(false);
    expect(RegisterGroupSchemas.foundation.safeParse({ ...rentalRegisterGroups.foundation, periodEndActivities: [{ ...row, sequence: 0 }] }).success).toBe(false);
  });
  it("the pipeline's working words in client text are a review finding naming the term, never an error", () => {
    const text = design(draft => { draft.steps[2]!.implementation.detail += " The outline fixes the kind."; });
    const result = evaluateDesign(rentalContext, text);
    expect(result.errors).toEqual([]);
    expect(result.blockers).toContainEqual({ code: "INTERNAL_TERM", path: "draft.steps.2", detail: "outline" });
  });
  it("a step answer states its accounting entry and keeps implementation.detail within the cap; a stored step may omit the entry", () => {
    const step = splitDetails()["TB-1"]!;
    expect(StepDetailSchema.safeParse(step).success).toBe(true);
    expect(StepDetailSchema.safeParse({ ...step, effects: { ...step.effects, accountingEntry: undefined } }).success).toBe(false);
    expect(StepDetailSchema.safeParse({ ...step, implementation: { detail: "x".repeat(901) } }).success).toBe(false);
    expect(StepDetailSchema.safeParse({ ...step, implementation: { detail: "x".repeat(900) } }).success).toBe(true);
    const stored = structuredClone(rentalDraftV3); delete stored.steps[0]!.effects.accountingEntry;
    expect(DetailedDesignSchema.safeParse(stored).success).toBe(true);
  });
});

const splitDetails = () => splitDesign(rentalDraft).details;
