import { describe, expect, it } from "vitest";
import { DetailedDesignSchema, evaluateDesign, type DesignContext, type DetailedDesign } from "../src/lib/ai/design-quality";
import { FIXABLE_BLOCKERS, blockerPart, collectTargets } from "../src/lib/ai/to-be-fix";
import { roleKey } from "../src/lib/ai/design-registers-v3";
import { personNamesIn, registerInputQuestions, removePersonNames, rewriteQuestionIds, RegisterGroupSchemas, inferRicefwTypes, mergeDuplicateRoles, normaliseKpiRows, renameRoleRefs } from "../src/lib/ai/design-registers";
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
  it("requires ricefwType when the classification is CLASSIC_RICEFW, and rejects it where nothing is built", () => {
    expect(codes(design(draft => { draft.fitGap![4]!.ricefwType = null; }))).toEqual(["RICEFW_TYPE_MISSING@draft.fitGap.4"]);
    expect(codes(design(draft => { draft.fitGap![0]!.ricefwType = "REPORT"; draft.fitGap![0]!.classification = "CONFIGURATION"; }))).toEqual(["RICEFW_TYPE_UNEXPECTED@draft.fitGap.0"]);
  });
  it("lets a key-user extension or a side-by-side build state its RICEFW type, but does not require it", () => {
    for (const classification of ["KEY_USER_EXTENSION", "SIDE_BY_SIDE_BTP"] as const) {
      expect(codes(design(draft => { draft.fitGap![0]!.classification = classification; draft.fitGap![0]!.ricefwType = "REPORT"; }))).toEqual([]);
      expect(codes(design(draft => { draft.fitGap![0]!.classification = classification; draft.fitGap![0]!.ricefwType = null; }))).toEqual([]);
    }
  });
  it("accepts STANDARD_INTEGRATION without a ricefwType, and rejects one that carries it", () => {
    expect(codes(design(draft => { draft.fitGap![0]!.classification = "STANDARD_INTEGRATION" as never; }))).toEqual([]);
    expect(codes(design(draft => { draft.fitGap![0]!.classification = "STANDARD_INTEGRATION" as never; draft.fitGap![0]!.ricefwType = "INTERFACE"; })))
      .toEqual(["RICEFW_TYPE_UNEXPECTED@draft.fitGap.0"]);
    expect(codes(design(draft => { draft.fitGap![0]!.classification = "INTEGRATION" as never; }))).not.toEqual([]); // the live failure value is still rejected
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
  const services = "TimeTrack stays as the timesheet system and must be integrated with SAP. The four local accounting packages and the Excel workbooks are replaced.";
  const pump = "Salesforce stays as the quoting tool and must be integrated with SAP. Tally Prime is retired, replaced by SAP.";
  const issues = (system: string[], answer: string) => evaluateDesign(ctx(answered(["retained_systems", answer])), design(draft => { draft.interfaces = system.map(name => iface(name)); })).errors
    .filter(error => error.code === "RETAINED_SYSTEM_UNCOVERED");
  it("a retained system in a one-sentence answer is covered by a descriptive counterpart that shares its name word", () => {
    expect(issues(["TimeTrack timesheet system"], services)).toEqual([]);
    expect(issues(["TimeTrack (timesheets)"], services)).toEqual([]);
    expect(issues(["Salesforce CRM (quoting)"], pump)).toEqual([]);
  });
  it("an unrelated counterpart leaves a one-sentence answer uncovered, and says a system has no row naming it", () => {
    expect(issues(["Bank SFTP"], services)).toEqual([{ code: "RETAINED_SYSTEM_UNCOVERED", path: "draft.interfaces", detail: "a retained system has no interface row naming it" }]);
  });
  it("no row citing retained_systems is reported with its own detail", () => {
    const uncited = evaluateDesign(ctx(answered(["retained_systems", services])), design(draft => { draft.interfaces = [iface("TimeTrack", { contextFieldIds: [] })]; })).errors
      .filter(error => error.code === "RETAINED_SYSTEM_UNCOVERED");
    expect(uncited).toEqual([{ code: "RETAINED_SYSTEM_UNCOVERED", path: "draft.interfaces", detail: "no interface row cites retained_systems" }]);
  });
  it("a two-line answer still needs a row for each line", () => {
    const answer = "TimeTrack timesheet system\nSalesforce quoting tool";
    expect(issues(["TimeTrack timesheet system"], answer)).toHaveLength(1);
    expect(issues(["TimeTrack timesheet system", "Salesforce CRM"], answer)).toEqual([]);
  });
  let counter = 0;
  const kpi = (target: string, baseline = "not provided", contextFieldIds = ["kpi_targets"], measure = "Days sales outstanding and on-time delivery rate") => ({ id: `KPI-${++counter}`, name: measure, baseline, target, measuredFrom: "Billing documents",
    referenceIds: [], needsValidation: true, validationReason: "App to be confirmed", requirementIds: [], contextFieldIds, stepIds: ["TB-3"] });
  const targets = ctx(answered(["kpi_targets", "Days sales outstanding 45 days\nOn-time delivery 98%"], ["kpi_baselines", "Days sales outstanding 62 days"]));

  it("every KPI target in the company context has a KPI row", () => {
    const found = (draft: DetailedDesign) => evaluateDesign(targets, draft).blockers.map(item => `${item.code}@${item.path}`);
    expect(found(design(draft => { draft.kpis = [kpi("Days sales outstanding 45 days")]; }))).toContain("KPI_TARGET_UNCOVERED@draft.kpis");
    expect(codes(design(draft => { draft.kpis = [kpi("Days sales outstanding 45 days")]; }), targets)).toEqual([]); // a blocker, never a fatal error
    expect(codes(design(draft => { draft.kpis = [kpi("Days sales outstanding 45 days", "Days sales outstanding 62 days"), kpi("On-time delivery 98%")]; }), targets)).toEqual([]);
  });
  it("baselines and targets are verbatim from the answers or 'not provided'", () => {
    expect(codes(design(draft => { draft.kpis = [kpi("DSO of 40 days"), kpi("On-time delivery 98%")]; }), targets)).toContain("KPI_VALUE_NOT_VERBATIM@draft.kpis.0");
    expect(codes(design(draft => { draft.kpis = [kpi("not provided", "Days sales outstanding 62 days", [])]; }))).toEqual(["KPI_VALUE_NOT_VERBATIM@draft.kpis.0"]);
    expect(codes(design(draft => { draft.kpis = [kpi("not provided", "not provided", [])]; }))).toEqual([]);
  });
  it("a heading line and an unquantified line do not have to be covered", () => {
    expect(codes(design(draft => { draft.kpis = [kpi("98% on-time delivery")]; }), ctx(answered(["kpi_targets", "Targets we want:\n- 98% on-time delivery\n- fewer disputes"])))).toEqual([]);
  });
});

describe("a KPI value is about its own measure (KPI_VALUE_NOT_FOR_MEASURE)", () => {
  // The real company-context answers of a production To-Be: the whole answer was copied onto every KPI.
  const BASELINES = "(6) Customers pay 60-90 days; finance matches receipts in Tally; quarterly steel-price revisions are billed later as supplementary invoices/debit notes, often 2-3 months late.";
  const TARGETS = "KPI targets: zero unreconciled job-work stock, close in 5 days, MSME paid within 45 days, 100% heat traceability.";
  const answers = ctx(answered(["kpi_baselines", BASELINES], ["kpi_targets", TARGETS]));
  let counter = 0;
  const MEASURES = ["Unreconciled job-work stock", "Month-end close duration", "MSME vendor payment days", "Heat traceability coverage"];
  const rowFor = (measure: string, baseline: string, target: string) => ({ ...kpiRow(measure), baseline, target });
  const kpiRow = (measure: string) => ({ id: `KPI-N${++counter}`, name: measure, baseline: "not provided", target: "not provided", measuredFrom: "Stock reconciliation report",
    referenceIds: [], needsValidation: true, validationReason: "App to be confirmed", requirementIds: [], contextFieldIds: ["kpi_targets"], stepIds: ["TB-3"] });
  const run = (rowsOf: ReturnType<typeof rowFor>[]) => codes(design(draft => { draft.kpis = rowsOf; }), answers);
  const perMeasure = ["zero unreconciled job-work stock", "close in 5 days", "msme paid within 45 days", "100% heat traceability"];

  it("rejects the whole answer copied onto every KPI as baseline or target", () => {
    const blobs = run(MEASURES.map(measure => rowFor(measure, BASELINES, TARGETS)));
    expect([...new Set(blobs.filter(code => code.startsWith("KPI_VALUE_NOT_FOR_MEASURE")))]).toHaveLength(MEASURES.length); // one per KPI row (baseline and target both flagged)
    expect(run([rowFor(MEASURES[0]!, "not provided", TARGETS), ...MEASURES.slice(1).map((m, i) => rowFor(m, "not provided", perMeasure[i + 1]!))])).toEqual(["KPI_VALUE_NOT_FOR_MEASURE@draft.kpis.0"]);
  });
  it("rejects a single segment that is about another measure", () => {
    expect(run([rowFor(MEASURES[0]!, "finance matches receipts in tally", "not provided")])).toContain("KPI_VALUE_NOT_FOR_MEASURE@draft.kpis.0");
  });
  it("accepts one part of the answer per measure, and 'not provided' where the answer has none", () => {
    expect(run(MEASURES.map((measure, i) => rowFor(measure, "not provided", perMeasure[i]!)))).toEqual([]);
    expect(run([rowFor("Days sales outstanding (customer payment)", "Customers pay 60-90 days", "not provided"), ...MEASURES.map((m, i) => rowFor(m, "not provided", perMeasure[i]!))])).toEqual([]);
  });
  it("does not demand the 'KPI targets:' label as a target to cover", () => {
    expect(run(MEASURES.map((measure, i) => rowFor(measure, "not provided", perMeasure[i]!))).filter(code => code.includes("UNCOVERED"))).toEqual([]);
    expect(run([rowFor(MEASURES[1]!, "not provided", "close in 5 days")])).toEqual([]);
  });
});

describe("KPI baseline relevance needs a distinctive word shared with the KPI name", () => {
  const SOURCE = "(6) Customers pay 60-90 days; finance matches receipts in Tally; quarterly steel-price revisions are billed later as supplementary invoices/debit notes, often 2-3 months late.";
  const TARGET = "zero unreconciled job-work stock; MSME paid within 45 days; 100% heat traceability; close in 5 days";
  const context = [{ fieldId: "kpi_baselines", value: SOURCE }, { fieldId: "kpi_targets", value: TARGET }];
  const kpi = (name: string, target: string) => ({ name, measuredFrom: "x", baseline: SOURCE, target });
  const rows = [
    kpi("Challans older than 150 days at the job-worker (count of open challans)", "zero unreconciled job-work stock"),
    kpi("MSME job-work invoices paid within 45 days", "MSME paid within 45 days"),
    kpi("Receipts carrying a heat number", "100% heat traceability"),
    kpi("Job-work flow close (working days from period end)", "close in 5 days"),
  ];
  it("sets every baseline of the four measured rows to not provided and keeps their targets", () => {
    const out = normaliseKpiRows(rows, context).rows;
    expect(out.map(item => item.baseline)).toEqual(["not provided", "not provided", "not provided", "not provided"]);
    expect(out.slice(1).map(item => item.target)).toEqual(["MSME paid within 45 days", "100% heat traceability", "close in 5 days"]);
  });
  it("keeps a customer-payment line for a customer-payment KPI, without the (6) enumerator", () => {
    const out = normaliseKpiRows([kpi("Days sales outstanding (customer payment)", "x")], context).rows[0]!;
    expect(out.baseline).toBe("Customers pay 60-90 days");
  });
  it("the check agrees: the same four baselines are KPI_VALUE_NOT_FOR_MEASURE", () => {
    const answers = ctx(answered(["kpi_baselines", SOURCE], ["kpi_targets", TARGET]));
    const kpis = rows.map((row, i) => ({ id: `KPI-${i + 1}`, ...row, baseline: "Customers pay 60-90 days", target: "not provided", referenceIds: [], needsValidation: true, validationReason: "App to be confirmed", requirementIds: [], contextFieldIds: ["kpi_targets"], stepIds: ["TB-3"] }));
    expect(codes(design(draft => { draft.kpis = kpis; }), answers).filter(code => code.startsWith("KPI_VALUE_NOT_FOR_MEASURE"))).toHaveLength(4);
  });
});

describe("a KPI value the answers hold but the row calls 'not provided' (KPI_VALUE_IGNORED)", () => {
  const answers = ctx(answered(["kpi_baselines", "Days sales outstanding 62 days\nOn-time delivery 91%"], ["kpi_targets", "Days sales outstanding 45 days"]));
  const row = (over: Record<string, unknown>) => ({ id: "KPI-9", name: "Days sales outstanding", baseline: "not provided", target: "Days sales outstanding 45 days", measuredFrom: "Billing documents",
    referenceIds: [], needsValidation: true, validationReason: "App to be confirmed", requirementIds: [], contextFieldIds: ["kpi_targets"], stepIds: ["TB-3"], ...over });
  const blockers = (over: Record<string, unknown>, context = answers) => evaluateDesign(context, design(draft => { draft.kpis = [row(over)]; })).blockers.map(item => `${item.code}@${item.path}`);
  it("is a blocker (not an error) when the answer has a valued line about this measure", () => {
    expect(blockers({})).toContain("KPI_VALUE_IGNORED@draft.kpis.0");
    expect(evaluateDesign(answers, design(draft => { draft.kpis = [row({})]; })).errors).toEqual([]);
    expect(blockers({ baseline: "not provided", target: "not provided" })).toContain("KPI_VALUE_IGNORED@draft.kpis.0");
  });
  it("is silent when the value is copied, when no line is about this measure, when the line has no figure, or when the question was not answered", () => {
    expect(blockers({ baseline: "Days sales outstanding 62 days" })).not.toContain("KPI_VALUE_IGNORED@draft.kpis.0");
    expect(blockers({ name: "Dispute turnaround", measuredFrom: "Dispute log" })).not.toContain("KPI_VALUE_IGNORED@draft.kpis.0");
    expect(blockers({}, ctx(answered(["kpi_baselines", "Days sales outstanding tracked monthly"], ["kpi_targets", "Days sales outstanding 45 days"])))).not.toContain("KPI_VALUE_IGNORED@draft.kpis.0"); // the baseline line has no figure
    expect(blockers({}, ctx())).not.toContain("KPI_VALUE_IGNORED@draft.kpis.0");
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

describe("normaliseKpiRows", () => {
  const context = [{ fieldId: "kpi_baselines", value: "Days sales outstanding 62 days\nOn-time delivery 91%" }, { fieldId: "kpi_targets", value: "Targets: Days sales outstanding 45 days; On-time delivery 98%" }];
  const row = (baseline: string, target: string, name = "Days sales outstanding") => ({ name, measuredFrom: "Billing", baseline, target });
  const run = (rows: ReturnType<typeof row>[]) => normaliseKpiRows(rows, context);
  it("keeps not-provided and already valid values untouched (same row objects)", () => {
    const rows = [row("not provided", "Days sales outstanding 45 days"), row("Days sales outstanding 62 days", "Not provided.")];
    const out = run(rows);
    expect(out.rows[0]).toBe(rows[0]); expect(out.rows[1]).toBe(rows[1]); expect(out.warnings).toEqual([]);
  });
  it("replaces a blob or paraphrase with the source line about this measure, else not provided, and warns per value", () => {
    const out = run([row("Days sales outstanding 62 days, On-time delivery 91%", "DSO to 45 days"), row("62 days", "98 percent on time", "Inventory accuracy")]);
    expect(out.rows.map(item => [item.baseline, item.target])).toEqual([["Days sales outstanding 62 days", "Days sales outstanding 45 days"], ["not provided", "not provided"]]);
    expect(out.warnings).toEqual([{ code: "KPI_VALUE_NORMALISED", path: "draft.kpis.0.baseline" }, { code: "KPI_VALUE_NORMALISED", path: "draft.kpis.0.target" }, { code: "KPI_VALUE_NORMALISED", path: "draft.kpis.1.baseline" }, { code: "KPI_VALUE_NORMALISED", path: "draft.kpis.1.target" }]);
  });
  it("never invents text: no source answer means not provided, and the result passes the real checks", () => {
    expect(normaliseKpiRows([row("62 days", "45 days")], []).rows[0]).toMatchObject({ baseline: "not provided", target: "not provided" });
  });
});

describe("mergeDuplicateRoles", () => {
  const role = (id: string, name: string, responsibilities: string, stepIds: string[]) => ({ id, name, responsibilities, stepIds });
  const group = () => ({ roles: [role("ROLE-1", "Plant Head Chakan", "Approves releases.", ["TB-1"]), role("ROLE-2", "Billing clerk", "Releases billing.", ["TB-3"]), role("ROLE-3", "Plant head, Chakan", "Signs off cutover.", ["TB-2", "TB-1"])],
    sodAssessments: [{ roleIds: ["ROLE-3", "ROLE-2"] }, { roleIds: ["ROLE-1", "ROLE-3"] }, { roleIds: ["ROLE-2"] }] });
  it("merges rows whose names differ only in case or punctuation into the first, rewrites dropped ids and warns once per merge", () => {
    const input = group(), out = mergeDuplicateRoles(input);
    expect(out.value.roles).toEqual([role("ROLE-1", "Plant Head Chakan", "Approves releases. Signs off cutover.", ["TB-1", "TB-2"]), role("ROLE-2", "Billing clerk", "Releases billing.", ["TB-3"])]);
    expect(out.value.sodAssessments.map(row => row.roleIds)).toEqual([["ROLE-1", "ROLE-2"], ["ROLE-1"], ["ROLE-2"]]);
    expect(out.warnings).toEqual([{ code: "ROLE_MERGED", path: "draft.roles.2" }]);
    expect([...out.renames]).toEqual([["Plant head, Chakan", "Plant Head Chakan"]]);
    expect(input).toEqual(group()); // the input is not mutated
  });
  it("leaves distinct roles untouched (same object)", () => {
    const input = { roles: [role("ROLE-1", "A clerk", "x", ["S"]), role("ROLE-2", "B clerk", "y", ["S"])], sodAssessments: [] };
    expect(mergeDuplicateRoles(input).value).toBe(input);
  });
  it("renames the dropped variant by exact string at actor and owner keys only", () => {
    const renames = new Map([["Plant head, Chakan", "Plant Head Chakan"]]);
    const out = renameRoleRefs({ actor: "Plant head, Chakan", note: "Plant head, Chakan", owner: "plant head, chakan", exceptions: [{ owner: "Plant head, Chakan" }], owners: ["Plant head, Chakan", "Other"] }, renames);
    expect(out).toEqual({ actor: "Plant Head Chakan", note: "Plant head, Chakan", owner: "plant head, chakan", exceptions: [{ owner: "Plant Head Chakan" }], owners: ["Plant Head Chakan", "Other"] });
  });
});

describe("inferRicefwTypes", () => {
  const row = (classification: string, justification: string, ricefwType: string | null = null) => ({ classification, ricefwType, justification });
  it("fills a built row's missing type from its own justification, with a warning; leaves the rest", () => {
    const rows = [row("CLASSIC_RICEFW", "A custom report of open hire items is needed."), row("KEY_USER_EXTENSION", "Nothing in the text names a build."), row("STANDARD", "A custom report here."),
      row("SIDE_BY_SIDE_BTP", "A custom form is printed.", "WORKFLOW"), row("CLASSIC_RICEFW", "There will be no custom report.")];
    const out = inferRicefwTypes(rows);
    expect(out.rows.map(item => item.ricefwType)).toEqual(["REPORT", null, null, "WORKFLOW", null]);
    expect(out.warnings).toEqual([{ code: "RICEFW_TYPE_INFERRED", path: "draft.fitGap.0" }]);
  });
});

describe("removePersonNames", () => {
  const run = (value: unknown) => removePersonNames(value);
  it("keeps the role and drops the honorific and name, with surrounding parentheses or dashes", () => {
    const out = run({ roles: [{ name: "CFO (Mr. Rajesh Kulkarni)" }, { name: "Plant head - Ms. Anita Deshpande" }, { name: "Dr Sharma Rao, Finance controller" }], text: "Mrs. Meera Iyer approves; SAP S/4HANA Finance stays." });
    expect(out.design).toEqual({ roles: [{ name: "CFO" }, { name: "Plant head" }, { name: "Finance controller" }], text: "approves; SAP S/4HANA Finance stays." });
    expect(out.warnings.map(w => `${w.code}@${w.path}`)).toEqual(["PERSON_NAME_REMOVED@draft.roles.0.name", "PERSON_NAME_REMOVED@draft.roles.1.name", "PERSON_NAME_REMOVED@draft.roles.2.name", "PERSON_NAME_REMOVED@draft.text"]);
  });
  it("uses the title of the object a field that was only a name sits in, and leaves other capitalised words and KPI source copies alone", () => {
    expect(run({ title: "Approve credit", owner: "Mr. Rajesh Kulkarni" }).design).toEqual({ title: "Approve credit", owner: "Approve credit" });
    const untouched = { note: "Tally Prime posts to Mumbai plant", kpis: [{ name: "x", measuredFrom: "y", baseline: "Mr. Rao says 5 days", target: "t" }] };
    const out = run(untouched);
    expect(out.design).toEqual(untouched); expect(out.warnings).toEqual([]);
  });
});

describe("rewriteQuestionIds", () => {
  it("rewrites every raw occurrence, longest id first, never inside a longer identifier", () => {
    const labels = new Map([["q_st_aaaa_1", "IQ-1"], ["q_st_aaaa_12", "IQ-2"]]);
    const out = rewriteQuestionIds({ rule: "Pending q_st_aaaa_12 and q_st_aaaa_1; not xq_st_aaaa_1", steps: [{ id: "q_st_aaaa_1" }] }, labels);
    expect(out.design).toEqual({ rule: "Pending IQ-2 and IQ-1; not xq_st_aaaa_1", steps: [{ id: "q_st_aaaa_1" }] });
    expect(out.warnings).toEqual([{ code: "INPUT_QUESTION_ID_REWRITTEN", path: "draft.rule" }]);
  });
});

describe("input open questions in the register (IQ-n)", () => {
  const input = [{ id: "IQ-2", question: "Which plants are in scope?", owner: "Plant head" }, { id: "IQ-7", question: "Who pays freight?", owner: "" }, { id: "IQ-9", question: "Unused?", owner: "X" }];
  const base = () => structuredClone(rentalDraftV2) as DetailedDesign;
  it("adds an entry (text, owner, citing steps) for each IQ id the design cites, once, and leaves held ids alone", () => {
    const draft = base();
    draft.steps[0]!.addedValue = "Pending IQ-2 before release.";
    draft.steps[2]!.addedValue = "Pending IQ-2 and IQ-7.";
    const out = registerInputQuestions(draft, input);
    const added = out.design.openQuestions.filter(item => item.id.startsWith("IQ-"));
    expect(added).toEqual([
      { id: "IQ-2", question: "Which plants are in scope?", owner: "Plant head", affectedStepIds: [draft.steps[0]!.id, draft.steps[2]!.id] },
      { id: "IQ-7", question: "Who pays freight?", owner: "Process owner", affectedStepIds: [draft.steps[2]!.id] }]);
    expect(out.warnings.map(item => item.code)).toEqual(["INPUT_QUESTION_REGISTERED", "INPUT_QUESTION_REGISTERED"]);
    expect(registerInputQuestions(out.design, input).warnings).toEqual([]); // no duplicate on a second run
    expect(codes(out.design).filter(code => code.startsWith("UNKNOWN_"))).toEqual([]);
  });
  it("attaches a question cited in a row to the steps the row links via impactedStepIds, affectedStepIds or producingStepId, not to the first step", () => {
    const draft = base(); const [, second, third] = draft.steps.map(step => step.id);
    Object.assign(draft, { keyDesignDecisions: [{ id: "KDD-1", decision: "Pending IQ-2.", impactedStepIds: [second] }],
      kpis: [{ id: "KPI-1", measuredFrom: "Pending IQ-7.", producingStepId: third }] });
    const added = registerInputQuestions(draft, input).design.openQuestions.filter(item => item.id.startsWith("IQ-"));
    expect(added.map(item => [item.id, item.affectedStepIds])).toEqual([["IQ-2", [second]], ["IQ-7", [third]]]);
  });
  it("does not invent an entry for an IQ id the input lacks", () => {
    const draft = base(); draft.steps[0]!.addedValue = "Pending IQ-99.";
    expect(registerInputQuestions(draft, input).design.openQuestions).toEqual(draft.openQuestions);
  });
});

describe("UNKNOWN_QUESTION_REFERENCE", () => {
  const withText = (text: string) => evaluateDesign(ctx(), design(draft => { draft.steps[1]!.businessRules[0]!.response = text; }));
  it("blocks a step that cites a question id no register holds, naming it and the valid ids, and is not an error", () => {
    const out = withText("Hold the release until JWK-OQ-23 is answered.");
    const hit = out.blockers.find(item => item.code === "UNKNOWN_QUESTION_REFERENCE");
    expect(hit).toMatchObject({ path: "draft.steps.1" });
    expect(hit!.detail).toContain("JWK-OQ-23");
    expect(hit!.detail).toContain("valid question ids");
    expect(out.errors.filter(item => item.code === "UNKNOWN_QUESTION_REFERENCE")).toEqual([]);
  });
  it("is silent for a question the design holds", () => {
    const out = evaluateDesign(ctx(), design(draft => {
      draft.openQuestions.push({ id: "JWK-OQ-1", question: "Who signs?", owner: "Plant head", affectedStepIds: [draft.steps[0]!.id] });
      draft.steps[1]!.businessRules[0]!.response = "Hold the release until JWK-OQ-1 is answered.";
    }));
    expect(out.blockers.some(item => item.code === "UNKNOWN_QUESTION_REFERENCE")).toBe(false);
  });
  it("is a fixable blocker routed to the citing step", () => {
    expect(FIXABLE_BLOCKERS.has("UNKNOWN_QUESTION_REFERENCE")).toBe(true);
    const draft = design();
    expect(blockerPart({ code: "UNKNOWN_QUESTION_REFERENCE", path: "draft.steps.1" }, draft)).toEqual({ type: "step", stepId: draft.steps[1]!.id });
    const { targets, newQuestions } = collectTargets(draft, [{ code: "DANGLING_ID_REFERENCE", path: "draft.steps.1", detail: "JWK-OQ-23 does not exist in this design" }]);
    expect(newQuestions).toEqual([]);
    expect(targets).toHaveLength(1);
  });
});

describe("person names known from the discovery text", () => {
  const SOURCE = "Mr. Rajesh Kulkarni (CFO) signs off. Ms. Anita Deshpande runs the plant.";
  const names = personNamesIn([SOURCE]);
  it("learns full names after an honorific (and their two-word forms)", () => {
    expect(names).toEqual(expect.arrayContaining(["Rajesh Kulkarni", "Anita Deshpande"]));
    expect(personNamesIn(["No names here, Mr. Sharma only."])).toEqual([]);
  });
  it("removes a known name written without its honorific, with the usual brackets and dashes", () => {
    const out = removePersonNames({ steps: [{ actor: "Finance head Rajesh Kulkarni", note: "Approved by CFO (Rajesh Kulkarni); Anita Deshpande checks.", title: "Rajesh Kulkarni" }] }, names);
    expect(out.design.steps[0]).toEqual({ actor: "Finance head", note: "Approved by CFO; checks.", title: "Role to be confirmed" });
    expect(out.warnings.length).toBe(3);
    expect(JSON.stringify(removePersonNames({ x: "Kulkarni Engineering approves" }, names).design)).toContain("Kulkarni Engineering");
  });
  it("without the known names the bare name stays (the honorific rule alone)", () => {
    expect(removePersonNames({ text: "Rajesh Kulkarni approves" }).design).toEqual({ text: "Rajesh Kulkarni approves" });
  });
});

describe("roleKey ignores word order", () => {
  it("merges 'Chakan store keeper' and 'Store keeper, Chakan' and keeps distinct roles apart", () => {
    expect(roleKey("Chakan store keeper")).toBe(roleKey("Store keeper, Chakan"));
    expect(roleKey("Head of the Plant at Chakan")).toBe(roleKey("Chakan plant head"));
    expect(roleKey("Store keeper Chakan")).not.toBe(roleKey("Store keeper Pune"));
    const role = (id: string, name: string, stepIds: string[]) => ({ id, name, responsibilities: "Issues stock.", stepIds });
    const out = mergeDuplicateRoles({ roles: [role("ROLE-1", "Chakan store keeper", ["TB-1"]), role("ROLE-2", "Store keeper, Chakan", ["TB-2"])], sodAssessments: [{ roleIds: ["ROLE-2"] }] });
    expect(out.value.roles.map(item => item.id)).toEqual(["ROLE-1"]);
    expect(out.value.sodAssessments[0]!.roleIds).toEqual(["ROLE-1"]);
    expect([...out.renames]).toEqual([["Store keeper, Chakan", "Chakan store keeper"]]);
  });
});

describe("KPI targets that are verbatim segments", () => {
  const TARGETS = "zero unreconciled job-work stock; MSME paid within 45 days; close in 5 days";
  const context = [{ fieldId: "kpi_baselines", value: "" }, { fieldId: "kpi_targets", value: TARGETS }];
  const row = (name: string, target: string) => ({ name, measuredFrom: "x", baseline: "not provided", target });
  it("keeps 'close in 5 days' on a KPI whose name shares no distinctive word, without a warning", () => {
    const out = normaliseKpiRows([row("Job-work flow close (working days from period end)", "close in 5 days")], context);
    expect(out.rows[0]!.target).toBe("close in 5 days");
    expect(out.warnings).toEqual([]);
  });
  it("normalises a target another KPI already uses, and fills a not-provided target from an unused segment about its measure", () => {
    const out = normaliseKpiRows([row("MSME payment days", "MSME paid within 45 days"), row("MSME payment lag", "MSME paid within 45 days"), row("Unreconciled job-work stock count", "not provided")], context);
    expect(out.rows.map(item => item.target)).toEqual(["MSME paid within 45 days", "not provided", "zero unreconciled job-work stock"]);
    expect(out.warnings).toEqual([{ code: "KPI_VALUE_NORMALISED", path: "draft.kpis.1.target" }, { code: "KPI_VALUE_NORMALISED", path: "draft.kpis.2.target" }]);
  });
  it("the check agrees: the same target is not a KPI_VALUE_NOT_FOR_MEASURE error", () => {
    const answers = ctx(answered(["kpi_baselines", "Customers pay 60-90 days"], ["kpi_targets", TARGETS]));
    const kpis = [{ id: "KPI-N1", name: "Job-work flow close (working days from period end)", baseline: "not provided", target: "close in 5 days", measuredFrom: "Stock report", referenceIds: [], needsValidation: true, validationReason: "App to be confirmed", requirementIds: [], contextFieldIds: ["kpi_targets"], stepIds: ["TB-3"] }];
    expect(codes(design(draft => { draft.kpis = kpis; }), answers).filter(code => code.startsWith("KPI_VALUE"))).toEqual([]);
  });
});
