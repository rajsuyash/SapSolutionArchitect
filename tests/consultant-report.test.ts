import { describe, expect, it } from "vitest";
import { DetailedDesignSchema } from "../src/lib/ai/design-quality";
import { buildReport, parseStoredToBe, type ReportData } from "../src/lib/consultant-report";
import { renderMarkdown, renderTraceabilityCsv, reportFilename } from "../src/lib/consultant-report-export";

const evidence = { sourceId: "S1", quote: "Returns are logged late." };
const design = DetailedDesignSchema.parse({
  schemaVersion: 1, processName: "Equipment hire returns",
  steps: [{
    id: "TB-1", sequence: 1, title: "Record return", asIsStepIds: ["A1"], requirementIds: ["R1"], actor: "Stores clerk",
    trigger: "Asset returned", inputDocuments: ["Return note"], outputDocuments: ["Return record"],
    actions: [{ actor: "Clerk", system: "SAP", operation: "Post return | with pipe", fields: ["Return date"] }],
    businessRules: [{ id: "BR-1", condition: "Return date missing", response: "Block invoicing" }],
    exceptions: [], exceptionsNotApplicableReason: "No exceptions at this step",
    masterData: [{ object: "Asset", fields: ["Status"], owner: "Stores" }],
    effects: { inventory: "Asset available", financial: "Final invoice", ownership: "Unchanged" },
    implementation: { kind: "CONFIGURATION", detail: "Use standard returns.", referenceIds: ["REF-1", "GONE"] },
    addedValue: "Accurate invoices",
    acceptanceTests: [{ id: "T-1", kind: "NORMAL", given: "A hired asset", when: "It is returned", then: "The date is stored", requirementIds: ["R1"] }],
  }],
  eliminatedAsIsSteps: [{ asIsStepId: "A2", reason: "Paper copy no longer needed" }],
  coverage: [{ requirementId: "R1", disposition: "IMPLEMENTED", stepIds: ["TB-1"], decisionId: null, rationale: "Covered" }],
  conflictDecisions: [{ conflictId: "C1", decisionId: null }],
  openQuestions: [{ id: "Q-1", question: "Who approves credits?", owner: "Finance lead", affectedStepIds: ["TB-1"] }],
});
const data: ReportData = {
  jobId: "00000000-0000-4000-8000-000000000001", project: { name: "Hire returns", clientName: "Synthetic client" },
  variant: { code: "RENTAL", name: "Equipment hire" }, targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: "2023",
  sourceRevision: 7, generatedAt: "2026-10-21T09:30:00.000Z",
  discovery: {
    asIsSteps: [
      { id: "A1", sequence: 1, name: "Log return", actor: "Clerk", system: "Spreadsheet", trigger: "Asset returns", description: "Clerk types the date.", inputs: [], outputs: [], controls: [], exceptions: [], evidence },
      { id: "A2", sequence: 2, name: "File paper copy", actor: "Clerk", system: "Paper", trigger: "After logging", description: "Filed.", inputs: [], outputs: [], controls: [], exceptions: [], evidence }],
    requirements: [{ id: "R1", asIsStepId: "A1", kind: "PAIN_POINT", statement: "Late logging =| wrong invoices", critical: true, evidence }],
    conflicts: [{ id: "C1", question: "Is installation billed monthly?", sourceIds: ["S1"] }],
    openQuestions: [], sources: [{ id: "S1", title: "Interview", locator: "p1", revision: "1" }],
  },
  design,
  blockers: [{ code: "OPEN_QUESTION", path: "draft.openQuestions.0" }, { code: "OPEN_CONFLICT", path: "draft.conflictDecisions.0" },
    { code: "SOMETHING_NEW", path: "draft.steps.0.implementation" }],
  unresolvedInputQuestions: [{ id: "IQ-1", question: "Which plants are in scope?", owner: "Process owner" }],
  catalogReferenceCount: 14,
  references: [{ id: "REF-1", targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: "2023", status: "VERIFIED", evidence: "q", fitType: "CONFIGURATION",
    capability: "Returns processing", objects: ["VA01"], limitations: ["Needs plant setup"], evidenceUrls: ["https://help.sap.com/docs/x", "https://evil.example/x", "http://help.sap.com/y"] }],
};

describe("consultant report model", () => {
  const model = buildReport(data);
  it("never says approved; blocked while blockers remain, review-required otherwise", () => {
    expect(model.status).toBe("BLOCKED");
    expect(buildReport({ ...data, blockers: [] }).status).toBe("HUMAN_REVIEW_REQUIRED");
    const text = renderMarkdown(model);
    expect(text).toContain("It has not been approved");
    expect(text).toMatch(/Review status: Blocked\./);
    expect(text).not.toMatch(/status: approved/i);
  });
  it("shows a visible warning on the page model and in the Markdown only when the catalog is empty", () => {
    expect(model.catalogWarning).toBeNull();
    expect(renderMarkdown(model)).not.toContain("no verified SAP reference catalog");
    const empty = buildReport({ ...data, catalogReferenceCount: 0, targetRelease: "2025" });
    expect(empty.catalogWarning).toContain("no verified SAP reference catalog for SAP S/4HANA Cloud Private Edition 2025");
    expect(renderMarkdown(empty)).toContain("**Warning: there is no verified SAP reference catalog");
  });
  it("maps blocker codes to plain categories and keeps unknown codes labelled", () => {
    expect(model.blockersByCategory.map(group => group.category).sort()).toEqual(["Open decisions", "Other", "Source conflicts"]);
    expect(model.blockers.find(item => item.code === "OPEN_QUESTION")?.subject).toBe("Who approves credits?");
    expect(model.blockers.find(item => item.code === "SOMETHING_NEW")?.label).toMatch(/Review is needed/);
    expect(model.steps[0]!.status).toMatchObject({ code: "BLOCKED", label: "Blocked (1)" });
  });
  it("compares each current step with its To-Be steps or elimination", () => {
    expect(model.comparison.map(item => item.status)).toEqual(["Blocked", "Eliminated by design, needs human review"]);
    expect(model.comparison[0]!.steps[0]!.heading).toBe("Step 1: Record return");
    expect(model.comparison[1]!.eliminatedReason).toBe("Paper copy no longer needed");
  });
  it("renders only official https SAP links and flags a reference missing from the catalog", () => {
    const [found, gone] = model.steps[0]!.implementation.refs;
    expect(found).toMatchObject({ found: true, capability: "Returns processing", urls: ["https://help.sap.com/docs/x"] });
    expect(gone).toMatchObject({ found: false });
    expect(model.registers.sapPoints.map(item => item.text).join("\n")).toContain("missing from the curated catalog");
  });
  it("traces requirements to steps, rules and tests", () => {
    expect(model.traceability[0]).toMatchObject({ id: "R1", label: "Requirement 1", disposition: "Implemented in the To-Be design", steps: ["Step 1: Record return"], tests: ["T-1"] });
    expect(model.traceability[0]!.rules[0]).toContain("BR-1");
    expect(model.summary).toMatchObject({ toBeSteps: 1, rules: 1, tests: 1, eliminated: 1, implemented: 1, openQuestions: 2, conflicts: 1 });
  });
  it("rejects a corrupted stored result instead of rendering part of it", () => {
    expect(() => parseStoredToBe({ design: { steps: [] }, evaluation: { blockers: [] } })).toThrow();
  });
});

describe("consultant report exports", () => {
  const model = buildReport(data);
  const markdown = renderMarkdown(model);
  it("includes the comparison, labelled tests and every register", () => {
    for (const expected of ["## As-Is vs To-Be comparison", "Specified — not executed", "## Traceability matrix", "### Open decisions and questions",
      "### Source conflicts", "### SAP validation points", "Review status: Blocked", "Returns processing [REF-1]", "https://help.sap.com/docs/x"]) {
      expect(markdown).toContain(expected);
    }
    expect(markdown).not.toContain("evil.example");
  });
  it("escapes table cell pipes and newlines", () => {
    expect(markdown).toContain("Post return \\| with pipe");
    expect(markdown).toContain("Late logging =\\| wrong invoices");
  });
  it("builds a spreadsheet-safe traceability CSV and a derived filename", () => {
    const csv = renderTraceabilityCsv(buildReport({ ...data, discovery: { ...data.discovery,
      requirements: [{ ...data.discovery.requirements[0]!, statement: '=HYPERLINK("x"), "quoted"' }] } }));
    expect(csv.split("\r\n")[0]).toBe("Requirement,Type,Critical,Statement,Current step,Disposition,Rationale,To-Be steps,Rules,Tests");
    expect(csv).toContain(`"'=HYPERLINK(""x""), ""quoted"""`);
    expect(reportFilename(model, "md")).toBe("to-be-hire-returns-rental-r7.md");
    expect(reportFilename(model, "csv")).toBe("to-be-hire-returns-rental-r7-traceability.csv");
  });
  it("neutralizes spreadsheet formulas hidden behind a newline or leading spaces", () => {
    const csv = renderTraceabilityCsv(buildReport({ ...data, discovery: { ...data.discovery,
      requirements: [{ ...data.discovery.requirements[0]!, statement: "\n=HYPERLINK(\"x\")" }, { ...data.discovery.requirements[0]!, id: "R9", statement: " =1+1" }] } }));
    expect(csv).toContain(`"'\n=HYPERLINK(""x"")"`);
    expect(csv).toContain("'\u0020=1+1");
  });
  it("escapes raw HTML and link syntax in client-origin text", () => {
    const hostile = buildReport({ ...data, discovery: { ...data.discovery,
      requirements: [{ ...data.discovery.requirements[0]!, statement: "<img src=x onerror=alert(1)> [click](https://evil.example/x)" }] } });
    const text = renderMarkdown(hostile);
    expect(text).not.toContain("<img");
    expect(text).not.toContain("[click]");
    expect(text).toContain("&lt;img src=x onerror=alert(1)&gt; &#91;click](https://evil.example/x)");
    expect(text).toContain("Returns processing [REF-1]");
  });
});

describe("solution-design registers in the report (schemaVersion 2)", () => {
  const trace = { requirementIds: ["R1"], contextFieldIds: ["retained_systems"], stepIds: ["TB-1"] };
  const v2 = DetailedDesignSchema.parse({ ...design, schemaVersion: 2,
    keyDesignDecisions: [{ id: "KDD-1", topic: "Where the return date is enforced", options: [
      { name: "Block in the return step", pros: "Immediate | clear", cons: "Needs a custom check", fitType: "EXTENSION" },
      { name: "Report on late returns", pros: "No build", cons: "Does not prevent wrong invoices", fitType: "MANUAL" }],
    recommendation: "Block in the return step", rationale: "R1 is critical.", impactedStepIds: ["TB-1"], requirementIds: ["R1"], contextFieldIds: ["constraints"],
    owner: "Stores lead", status: "PROPOSED" }],
    fitGap: [{ requirementId: "R1", classification: "CLASSIC_RICEFW", ricefwType: "ENHANCEMENT", justification: "No key-user hook covers it | validated?", stepIds: ["TB-1"],
      referenceIds: ["REF-1"], needsValidation: false, validationReason: null }],
    orgStructure: [{ id: "ORG-1", unitType: "Plant", proposal: "One depot plant", openPoint: null, ...trace }],
    masterDataPrerequisites: [{ id: "MD-1", object: "Asset", owner: "Stores", keyFields: ["status", "plant"], migrationSource: "Asset spreadsheet", ...trace }],
    interfaces: [{ id: "IF-1", counterpartSystem: "Dispatch app", direction: "INBOUND", triggerFrequency: "On each return", payload: "Return date", errorOwner: "Stores lead",
      outOfScopeReason: null, referenceIds: [], needsValidation: true, validationReason: "Confirm the API", ...trace }],
    kpis: [{ id: "KPI-1", name: "Invoices corrected after return", baseline: "not provided", target: "under 2%", measuredFrom: "Billing document",
      referenceIds: [], needsValidation: true, validationReason: "Pick the app", ...trace }],
    dataMigration: [{ id: "MIG-1", object: "Assets", source: "Spreadsheet", approach: "Load and reconcile", sequence: 1, risk: "Duplicates", ...trace }],
    cutover: [{ id: "CUT-1", activity: "Freeze returns, load, release", sequence: 1, owner: "Project lead", risk: "Late returns", ...trace }] });
  const model = buildReport({ ...data, design: v2 });
  const markdown = renderMarkdown(model);

  it("renders every register as a table with labels, not internal codes", () => {
    for (const expected of ["## Solution design registers", "### Key design decisions", "### Fit-gap (clean core)", "### Organisation structure", "### Master-data prerequisites",
      "### Interfaces", "### KPIs", "### Data migration", "### Cutover", "Proposed, not approved", "Classic custom development (RICEFW)", "ENHANCEMENT",
      "Returns processing [REF-1]", "Into SAP", "Needs SAP validation: Confirm the API", "Requirement 1", "Retained and non-SAP systems and integrations",
      "Block in the return step (Extension). Pros: Immediate \\| clear Cons: Needs a custom check"]) expect(markdown).toContain(expected);
    expect(markdown).not.toContain("CLASSIC_RICEFW");
    expect(markdown).not.toMatch(/\bPROPOSED\b/);
  });
  it("adds fit-gap and register rows to the traceability CSV in the same columns", () => {
    const lines = renderTraceabilityCsv(model).trimEnd().split("\r\n");
    expect(lines).toHaveLength(1 + 1 + 1 + 7); // header, requirement, fit-gap, then the seven registers that cite R1
    expect(lines[2]).toContain("Fit-gap: Classic custom development (RICEFW) (ENHANCEMENT)");
    expect(lines.slice(3).map(line => line.split(",")[1])).toEqual(["Key design decision", "Organisation structure", "Master data", "Interface", "KPI", "Data migration", "Cutover"]);
  });
  it("lists register rows that need SAP validation among the SAP validation points", () => {
    expect(model.registers.sapPoints.map(item => item.text)).toEqual(expect.arrayContaining(["Confirm the API", "Pick the app"]));
  });
  it("a version 1 design renders exactly as before: no registers, no extra CSV rows", () => {
    const v1 = buildReport(data);
    expect(v1.solution).toBeNull();
    expect(renderMarkdown(v1)).not.toContain("Solution design registers");
    expect(renderTraceabilityCsv(v1).trimEnd().split("\r\n")).toHaveLength(2);
  });
  it("stored results of either version re-parse", () => {
    const stored = (value: unknown) => ({ design: value, evaluation: { blockers: [] }, unresolvedInputQuestions: [], sourceRevision: 1, snapshotId: "s" });
    expect(parseStoredToBe(stored(design)).design.schemaVersion).toBe(1);
    expect(parseStoredToBe(stored(v2)).design.schemaVersion).toBe(2);
  });
});
