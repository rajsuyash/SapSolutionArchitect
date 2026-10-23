import { describe, expect, it } from "vitest";
import { DetailedDesignSchema, evaluateDesign, type DesignContext, type DetailedDesign } from "../src/lib/ai/design-quality";
import { RegisterGroupSchemas } from "../src/lib/ai/design-registers";
import { rentalContext, rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV2, rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";

const reference = { id: "REF-OBJ", targetProduct: "S4HANA_CLOUD_PRIVATE" as const, targetRelease: "TBD", status: "VERIFIED" as const, evidence: "synthetic",
  fitType: "STANDARD" as const, capability: "Quotation handling", objects: ["VA21 create quotation", "Movement type 101"], limitations: [] };
const ctx = (extra: Partial<DesignContext> = {}): DesignContext => ({ ...rentalContext, ...extra });
const design = (change: (draft: DetailedDesign) => void = () => {}) => { const draft = structuredClone(rentalDraftV2); change(draft); return draft; };
const codes = (draft: DetailedDesign, context = ctx()) => evaluateDesign(context, draft).errors.map(error => `${error.code}@${error.path}`);
const answered = (...pairs: [string, string][]) => ({ companyContext: pairs.map(([fieldId, value]) => ({ fieldId, value })) });

describe("schema versions", () => {
  it("accepts the version 2 fixture and a version 1 design with no registers", () => {
    expect(codes(rentalDraftV2)).toEqual([]);
    expect(evaluateDesign(ctx(), rentalDraft)).toMatchObject({ structurallyValid: true, errors: [] });
    expect(DetailedDesignSchema.safeParse(rentalDraft).success).toBe(true);
    expect(rentalDraftV2.schemaVersion).toBe(2);
  });
  it("requires every register in version 2 and none in version 1", () => {
    const missing = design(draft => { delete draft.kpis; delete draft.cutover; });
    expect(codes(missing)).toEqual(expect.arrayContaining(["REGISTER_MISSING@draft.kpis", "REGISTER_MISSING@draft.cutover"]));
    expect(codes({ ...rentalDraft, kpis: [] })).toEqual(["REGISTER_VERSION_MISMATCH@draft.kpis"]);
  });
  it("each register group schema rejects extra keys and a status other than PROPOSED", () => {
    expect(RegisterGroupSchemas.decisions.safeParse(rentalRegisterGroups.decisions).success).toBe(true);
    expect(RegisterGroupSchemas.decisions.safeParse({ ...rentalRegisterGroups.decisions, note: "x" }).success).toBe(false);
    const approved = { keyDesignDecisions: [{ ...rentalRegisterGroups.decisions.keyDesignDecisions[0]!, status: "APPROVED" }] };
    expect(RegisterGroupSchemas.decisions.safeParse(approved).success).toBe(false);
    expect(RegisterGroupSchemas.decisions.safeParse({ keyDesignDecisions: [{ ...rentalRegisterGroups.decisions.keyDesignDecisions[0]!, options: [] }] }).success).toBe(false);
  });
});

describe("fit-gap checks", () => {
  it("requires a row for every critical requirement", () => {
    expect(codes(design(draft => { draft.fitGap = draft.fitGap!.filter(row => row.requirementId !== "R-3"); }))).toEqual(["FIT_GAP_MISSING@draft.fitGap"]);
  });
  it("requires ricefwType exactly when the classification is CLASSIC_RICEFW", () => {
    expect(codes(design(draft => { draft.fitGap![4]!.ricefwType = null; }))).toEqual(["RICEFW_TYPE_MISSING@draft.fitGap.4"]);
    expect(codes(design(draft => { draft.fitGap![0]!.ricefwType = "REPORT"; }))).toEqual(["RICEFW_TYPE_UNEXPECTED@draft.fitGap.0"]);
  });
  it("rejects duplicate, unknown and untraceable rows", () => {
    expect(codes(design(draft => { draft.fitGap![1]!.requirementId = "R-1"; }))).toEqual(expect.arrayContaining(["DUPLICATE_DISPOSITION@draft.fitGap", "FIT_GAP_MISSING@draft.fitGap"]));
    expect(codes(design(draft => { draft.fitGap![0]!.requirementId = "R-99"; }))).toEqual(expect.arrayContaining(["UNKNOWN_REQUIREMENT@draft.fitGap.0"]));
    expect(codes(design(draft => { draft.fitGap![0]!.stepIds = ["NOPE"]; }))).toEqual(["UNKNOWN_STEP@draft.fitGap.0"]);
  });
});

describe("SAP basis on register rows", () => {
  it("needs a catalog reference, or needsValidation with a reason", () => {
    expect(codes(design(draft => { draft.fitGap![0]!.needsValidation = false; }))).toEqual(["SAP_BASIS_MISSING@draft.fitGap.0"]);
    expect(codes(design(draft => { draft.fitGap![0]!.validationReason = null; }))).toEqual(["VALIDATION_REASON_MISSING@draft.fitGap.0"]);
    expect(codes(design(draft => { draft.fitGap![0]!.referenceIds = ["NOPE"]; }))).toEqual(["UNKNOWN_REFERENCE@draft.fitGap.0"]);
    expect(codes(design(draft => { Object.assign(draft.fitGap![0]!, { referenceIds: ["REF-OBJ"], needsValidation: false, validationReason: null }); }), ctx({ references: [reference] }))).toEqual([]);
  });
  it("needs no SAP basis for a manual workaround", () => {
    expect(codes(design(draft => { Object.assign(draft.fitGap![3]!, { classification: "MANUAL_WORKAROUND", needsValidation: false, validationReason: null }); }))).toEqual([]);
  });
});

describe("trace checks", () => {
  it("every row cites a requirement, a company-context field or a step, all of which exist", () => {
    expect(codes(design(draft => { Object.assign(draft.masterDataPrerequisites![0]!, { stepIds: [], requirementIds: [], contextFieldIds: [] }); }))).toEqual(["REGISTER_TRACE_MISSING@draft.masterDataPrerequisites.0"]);
    expect(codes(design(draft => { draft.dataMigration![0]!.requirementIds = ["R-99"]; }))).toEqual(["UNKNOWN_REQUIREMENT@draft.dataMigration.0"]);
    expect(codes(design(draft => { draft.cutover![0]!.stepIds = ["TB-9"]; }))).toEqual(["UNKNOWN_STEP@draft.cutover.0"]);
    expect(codes(design(draft => { draft.orgStructure![0]!.contextFieldIds = ["target_org_units"]; }))).toEqual(["UNKNOWN_CONTEXT_FIELD@draft.orgStructure.0"]);
    expect(codes(design(draft => { draft.orgStructure![0]!.contextFieldIds = ["target_org_units"]; }), ctx(answered(["target_org_units", "Plant 1"])))).toEqual([]);
  });
  it("an organisation unit with no company-context source must state its open point", () => {
    expect(codes(design(draft => { draft.orgStructure![0]!.openPoint = null; }))).toEqual(["ORG_SOURCE_MISSING@draft.orgStructure.0"]);
  });
  it("a decision recommends one of its own options and impacts known steps", () => {
    expect(codes(design(draft => { draft.keyDesignDecisions![0]!.recommendation = "Something else"; }))).toEqual(["RECOMMENDATION_NOT_AN_OPTION@draft.keyDesignDecisions.0"]);
    expect(codes(design(draft => { draft.keyDesignDecisions![0]!.impactedStepIds = ["TB-9"]; }))).toEqual(["UNKNOWN_STEP@draft.keyDesignDecisions.0"]);
  });
  it("register ids are unique across registers and against step, rule, test and question ids", () => {
    expect(codes(design(draft => { draft.cutover![0]!.id = "MIG-1"; }))).toEqual(["DUPLICATE_OUTPUT_ID@draft.cutover.0"]);
    expect(codes(design(draft => { draft.cutover![0]!.id = "BR-1"; }))).toEqual(["DUPLICATE_OUTPUT_ID@draft.cutover.0"]);
  });
});

describe("company-context coverage", () => {
  const iface = (system: string, extra = {}) => ({ id: `IF-${system.slice(0, 3)}`, counterpartSystem: system, direction: "BIDIRECTIONAL" as const, triggerFrequency: "Daily batch",
    payload: "Customer and hire data", errorOwner: "Integration lead", outOfScopeReason: null, referenceIds: [], needsValidation: true, validationReason: "API to be confirmed",
    requirementIds: [], contextFieldIds: ["retained_systems"], stepIds: ["TB-1"], ...extra });
  const retained = ctx(answered(["retained_systems", "Customer portal\nLegacy dispatch system"]));

  it("every retained system appears in the interfaces or is explicitly out of scope", () => {
    expect(codes(design(), retained)).toEqual(["RETAINED_SYSTEM_UNCOVERED@draft.interfaces"]);
    expect(codes(design(draft => { draft.interfaces = [iface("Customer portal")]; }), retained)).toEqual(["RETAINED_SYSTEM_UNCOVERED@draft.interfaces"]);
    expect(codes(design(draft => { draft.interfaces = [iface("Customer portal"), iface("Legacy dispatch system")]; }), retained)).toEqual([]);
    expect(codes(design(draft => { draft.interfaces = [iface("Customer portal"), iface("Legacy dispatch system", { outOfScopeReason: "Retired at go-live", needsValidation: false, validationReason: null })]; }), retained)).toEqual([]);
  });
  it("an interface that cites no retained-system field leaves the answer uncovered", () => {
    expect(codes(design(draft => { draft.interfaces = [iface("Customer portal", { contextFieldIds: [], stepIds: ["TB-1"] })]; }), ctx(answered(["retained_systems", "Customer portal"])))).toEqual(["RETAINED_SYSTEM_UNCOVERED@draft.interfaces"]);
  });
  let counter = 0;
  const kpi = (target: string, baseline = "not provided", contextFieldIds = ["kpi_targets"]) => ({ id: `KPI-${++counter}`, name: "Measure", baseline, target, measuredFrom: "Billing documents",
    referenceIds: [], needsValidation: true, validationReason: "App to be confirmed", requirementIds: [], contextFieldIds, stepIds: ["TB-3"] });
  const targets = ctx(answered(["kpi_targets", "Days sales outstanding 45 days\nOn-time delivery 98%"], ["kpi_baselines", "Days sales outstanding 62 days"]));

  it("every KPI target in the company context has a KPI row", () => {
    expect(codes(design(draft => { draft.kpis = [kpi("Days sales outstanding 45 days")]; }), targets)).toEqual(["KPI_TARGET_UNCOVERED@draft.kpis"]);
    expect(codes(design(draft => { draft.kpis = [kpi("Days sales outstanding 45 days", "Days sales outstanding 62 days"), kpi("On-time delivery 98%")]; }), targets)).toEqual([]);
  });
  it("baselines and targets are verbatim from the answers or 'not provided'", () => {
    expect(codes(design(draft => { draft.kpis = [kpi("DSO of 40 days"), kpi("On-time delivery 98%")]; }), targets)).toContain("KPI_VALUE_NOT_VERBATIM@draft.kpis.0");
    expect(codes(design(draft => { draft.kpis = [kpi("not provided", "Days sales outstanding 62 days", [])]; }))).toEqual(["KPI_VALUE_NOT_VERBATIM@draft.kpis.0"]);
    expect(codes(design(draft => { draft.kpis = [kpi("not provided", "not provided", [])]; }))).toEqual([]);
  });
  it("a heading line and an unquantified line do not have to be covered", () => {
    expect(codes(design(draft => { draft.kpis = [kpi("98% on time")]; }), ctx(answered(["kpi_targets", "Targets we want:\n- 98% on time\n- fewer disputes"])))).toEqual([]);
  });
});

describe("unknown SAP objects", () => {
  it("flags an identifier outside the catalog in a step or a register, at its path, naming the token only", () => {
    const step = evaluateDesign(ctx(), design(draft => { draft.steps[1]!.effects.financial = "Post to the ledger with movement type 777."; }));
    expect(step.errors).toEqual([{ code: "UNKNOWN_SAP_OBJECT", path: "draft.steps.1.effects.financial", detail: "MOVEMENT_TYPE 777" }]);
    const register = evaluateDesign(ctx(), design(draft => { draft.fitGap![0]!.justification = "Use Fiori app F9999 for this."; }));
    expect(register.errors).toEqual([{ code: "UNKNOWN_SAP_OBJECT", path: "draft.fitGap.0.justification", detail: "FIORI_APP F9999" }]);
  });
  it("accepts the same identifiers when the catalog contains them", () => {
    // The rental fixture shares one implementation object across its steps, so the text is set on a copy.
    const text = "Create the quotation in VA21 and post with movement type 101.";
    expect(codes(design(draft => { draft.steps[0]!.implementation = { ...draft.steps[0]!.implementation, detail: text }; }), ctx({ references: [reference] }))).toEqual([]);
    expect(codes(design(draft => { draft.steps[0]!.implementation = { ...draft.steps[0]!.implementation, detail: text }; }))).toEqual(["UNKNOWN_SAP_OBJECT@draft.steps.0.implementation.detail", "UNKNOWN_SAP_OBJECT@draft.steps.0.implementation.detail"]);
  });
});
