import { describe, expect, it } from "vitest";
import { DetailedDesignSchema, evaluateDesign, type DesignContext, type DetailedDesign } from "../src/lib/ai/design-quality";
import { LATE_GROUPS, REGISTER_GROUPS, RegisterGroupSchemas, VERSION_2_KEYS } from "../src/lib/ai/design-registers";
import { StepDetailSchema } from "../src/lib/ai/to-be-pipeline";
import { rentalContext } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV2, rentalDraftV3, rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";

const reference = { id: "REF-OBJ", targetProduct: "S4HANA_CLOUD_PRIVATE" as const, targetRelease: "TBD", status: "VERIFIED" as const, evidence: "synthetic",
  fitType: "STANDARD" as const, capability: "Hire order handling", objects: [], limitations: [] };
const withKinds = (kinds: Record<string, "PAIN_POINT" | "TO_BE_REQUIREMENT" | "CONTROL">): DesignContext => ({ ...rentalContext,
  requirements: rentalContext.requirements.map(item => ({ ...item, kind: kinds[item.id] ?? "TO_BE_REQUIREMENT" })) });
const design = (change: (draft: DetailedDesign) => void = () => {}) => { const draft = structuredClone(rentalDraftV3); change(draft); return draft; };
const codes = (draft: DetailedDesign, context: DesignContext = rentalContext) => evaluateDesign(context, draft).errors.map(error => `${error.code}@${error.path}`);
const answered = (...pairs: [string, string][]): Partial<DesignContext> => ({ companyContext: pairs.map(([fieldId, value]) => ({ fieldId, value })) });
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
    expect(keys.length).toBe(VERSION_2_KEYS.length + 9);
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
    stepIds: ["TB-1"], failureHandling: { detection: "Error list", alerting: "Mail", rerun: "Resend after correction", idempotency: "Message key stored" }, ...extra });
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
    expect(codes(design(draft => { draft.objectives = []; }))).toEqual(["OBJECTIVE_MISSING@draft.objectives", "OBJECTIVE_STEP_UNMAPPED@draft.objectives"]);
    expect(codes(design(draft => { draft.objectives![1]!.stepIds = []; }))).toEqual(["OBJECTIVE_NO_STEPS@draft.objectives.1", "OBJECTIVE_STEP_UNMAPPED@draft.objectives"]);
    expect(codes(design(draft => { draft.objectives![1]!.stepIds = ["TB-2"]; }))).toEqual(["OBJECTIVE_STEP_UNMAPPED@draft.objectives"]);
  });
  it("an objective must cite a requirement or a context answer, and every answered outcome, target or constraint must be cited", () => {
    expect(codes(design(draft => { Object.assign(draft.objectives![0]!, { requirementIds: [], contextFieldIds: [] }); }))).toEqual(["REGISTER_TRACE_MISSING@draft.objectives.0"]);
    const context = { ...rentalContext, ...answered(["desired_outcome", "Every hire unit tracked on its own"], ["constraints", "No custom code in the core"]) };
    expect(codes(design(), context)).toEqual(["OBJECTIVE_CONTEXT_UNCOVERED@draft.objectives"]);
    expect(codes(design(draft => { draft.objectives![0]!.contextFieldIds = ["desired_outcome", "constraints"]; }), context)).toEqual([]);
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
    expect(codes(design(draft => { draft.documentStatusModels![0]!.transitions = draft.documentStatusModels![0]!.transitions.filter(item => item.stepId !== "TB-1"); }))).toEqual(["STATUS_TRANSITION_MISSING@draft.documentStatusModels.0"]);
  });
  it("every modelled document type is in the catalogue as a document type", () => {
    expect(codes(design(draft => { draft.configurationCatalogue![0]!.name = "Return voucher"; }))).toEqual(["CONFIG_DOCUMENT_TYPE_MISSING@draft.documentStatusModels.0"]);
    expect(codes(design(draft => { draft.configurationCatalogue = []; }))).toEqual(["CONFIG_CATALOGUE_MISSING@draft.configurationCatalogue", "CONFIG_DOCUMENT_TYPE_MISSING@draft.documentStatusModels.0"]);
  });
  it("a catalogue item is confirmed only with a catalog reference, and otherwise says what is missing", () => {
    const item = (draft: DetailedDesign) => draft.configurationCatalogue![0]!;
    expect(codes(design(draft => { item(draft).status = "CONFIRMED_IN_CATALOG"; }))).toEqual(["CONFIG_CONFIRMATION_MISSING@draft.configurationCatalogue.0"]);
    expect(codes(design(draft => { Object.assign(item(draft), { status: "CONFIRMED_IN_CATALOG", referenceIds: ["NOPE"], note: null }); }), rentalContext)).toEqual(expect.arrayContaining(["UNKNOWN_REFERENCE@draft.configurationCatalogue.0"]));
    expect(codes(design(draft => { Object.assign(item(draft), { status: "CONFIRMED_IN_CATALOG", referenceIds: ["REF-OBJ"], note: null }); }), { ...rentalContext, references: [reference] })).toEqual([]);
    expect(codes(design(draft => { item(draft).note = null; }))).toEqual(["VALIDATION_REASON_MISSING@draft.configurationCatalogue.0"]);
  });
  it("an SAP object named in the catalogue must be in the curated catalog", () => {
    expect(evaluateDesign(rentalContext, design(draft => { draft.configurationCatalogue![0]!.purpose = "Use Fiori app F9999 to create it."; })).errors)
      .toEqual([{ code: "UNKNOWN_SAP_OBJECT", path: "draft.configurationCatalogue.0.purpose", detail: "FIORI_APP F9999" }]);
  });
});

describe("roles, segregation of duties and control mappings (checklists 24 to 26)", () => {
  it("every step is covered by a role named like the step's actor", () => {
    expect(codes(design(draft => { draft.roles = draft.roles!.slice(0, 2); }))).toEqual(["ROLE_STEP_UNCOVERED@draft.roles", "UNKNOWN_ROLE@draft.sodAssessments.0"]);
    expect(codes(design(draft => { draft.roles![2]!.name = "Accounts clerk"; }))).toEqual(["ROLE_ACTOR_UNMATCHED@draft.roles"]);
    expect(codes(design(draft => { draft.roles = []; }))).toEqual(expect.arrayContaining(["ROLE_MISSING@draft.roles", "ROLE_STEP_UNCOVERED@draft.roles"]));
    expect(codes(design(draft => { draft.roles![2]!.name = "billing CLERK"; }))).toEqual([]); // case does not matter
    expect(codes(design(draft => { draft.roles![1]!.name = "Billing clerk"; }))).toEqual(["DUPLICATE_ROLE@draft.roles", "ROLE_ACTOR_UNMATCHED@draft.roles"]);
  });
  it("segregation of duties is assessed: a row exists, uses known roles, and a conflict spans two steps", () => {
    expect(codes(design(draft => { draft.sodAssessments = []; }))).toEqual(["SOD_ASSESSMENT_MISSING@draft.sodAssessments"]);
    expect(codes(design(draft => { draft.sodAssessments![0]!.roleIds = ["ROLE-9"]; }))).toEqual(["UNKNOWN_ROLE@draft.sodAssessments.0"]);
    expect(codes(design(draft => { Object.assign(draft.sodAssessments![0]!, { assessment: "CONFLICT_IDENTIFIED", stepIds: ["TB-2"] }); }))).toEqual(["SOD_CONFLICT_STEPS@draft.sodAssessments.0"]);
    expect(codes(design(draft => { draft.sodAssessments![0]!.assessment = "CONFLICT_IDENTIFIED"; }))).toEqual([]);
  });
  const control = withKinds({ "R-4": "CONTROL" });
  const mapping = (extra: object = {}) => ({ id: "CTL-1", requirementId: "R-4", mechanism: "BUSINESS_RULE" as const, realization: "A missing return date blocks completion.", stepIds: ["TB-2"], ruleId: "BR-3", ...extra });
  it("every control requirement from discovery has a mapping", () => {
    expect(codes(design(), control)).toEqual(["CONTROL_UNMAPPED@draft.controlMappings"]);
    expect(codes(design(draft => { draft.controlMappings = [mapping()]; }), control)).toEqual([]);
    expect(codes(design(draft => { draft.controlMappings = [mapping({ mechanism: "WORKFLOW", ruleId: null })]; }), control)).toEqual([]);
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
    expect(codes(design(), pain)).toEqual(["REPORT_PAIN_POINT_UNCOVERED@draft.reports"]);
    expect(codes(design(draft => { draft.reports![0]!.requirementIds = ["R-3", "R-4"]; }), pain)).toEqual([]);
  });
  it("end-to-end scenarios span at least two steps, cite a requirement, and together walk every step", () => {
    expect(codes(design(draft => { draft.endToEndTests = []; }))).toEqual(["E2E_TEST_MISSING@draft.endToEndTests", "E2E_STEP_UNCOVERED@draft.endToEndTests"]);
    expect(codes(design(draft => { draft.endToEndTests![0]!.stepIds = ["TB-1", "TB-2"]; }))).toEqual(["E2E_STEP_UNCOVERED@draft.endToEndTests"]);
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
