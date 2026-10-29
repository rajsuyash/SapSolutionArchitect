import { describe, expect, it } from "vitest";
import type { DetailedDesign } from "../src/lib/ai/design-quality";
import { buildReport, type ReportData } from "../src/lib/consultant-report";
import { renderMarkdown, renderTraceabilityCsv } from "../src/lib/consultant-report-export";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV2, rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";
import { fixture } from "./support/to-be-input";

const { discovery } = fixture();
const data = (design: DetailedDesign): ReportData => ({
  jobId: "00000000-0000-4000-8000-000000000001", project: { name: "Hire returns", clientName: "Synthetic client" },
  variant: { code: "RENTAL", name: "Equipment hire" }, targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: "2023", sourceRevision: 7,
  snapshotId: "22222222-2222-4222-8222-222222222222", generatedAt: "2026-10-21T09:30:00.000Z",
  discovery: { asIsSteps: discovery.asIsSteps, requirements: discovery.requirements, conflicts: discovery.conflicts, openQuestions: discovery.openQuestions,
    sources: discovery.sources.map(({ id, title, locator, revision }) => ({ id, title, locator, revision, digest: `digest-of-${id}` })) },
  design, blockers: [], unresolvedInputQuestions: [], references: [], catalogReferenceCount: 14,
});
const markdown = renderMarkdown(buildReport(data(rentalDraftV3)));
const section = (title: string, text = markdown) => {
  const start = text.indexOf(`\n## ${title}`);
  expect(start, title).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n## ", start + 4);
  return text.slice(start, next < 0 ? undefined : next);
};

describe("version 3 report: deterministic sections", () => {
  it("opens with document control built from the frozen revision, with placeholder reviewers and a review-required sign-off", () => {
    const control = section("Document control");
    expect(markdown.indexOf("## Document control")).toBeLessThan(markdown.indexOf("## Executive summary"));
    for (const expected of ["0.1 draft", "2026-10-21", "22222222-2222-4222-8222-222222222222", "digest-of-SRC-1", "to be assigned", "HUMAN_REVIEW_REQUIRED", "Process owner"]) expect(control).toContain(expected);
    expect(control).not.toMatch(/\bapproved by\b|status: approved/i);
  });
  it("gives the As-Is narrative of each step apart from the To-Be, before the To-Be steps, in the client's words", () => {
    const narrative = section("As-Is narratives");
    expect(markdown.indexOf("## As-Is narratives")).toBeLessThan(markdown.indexOf("## To-Be steps"));
    expect(narrative).toContain(discovery.asIsSteps[0]!.description);
    expect(narrative).toContain("Before: Create individually traceable hire items (TB-1)");
    expect(narrative).not.toContain(rentalDraftV3.steps[0]!.addedValue);
    expect(section("To-Be steps")).not.toContain(discovery.asIsSteps[0]!.description);
  });
  it("lists the RICEFW items with type, linked steps and rationale", () => {
    const list = section("Solution design registers");
    const ricefw = list.slice(list.indexOf("### RICEFW list"));
    expect(ricefw).toContain("RICEFW-4");
    expect(ricefw).toContain("ENHANCEMENT");
    expect(ricefw).toContain("TB-3: Prepare recurring hire billing with one-time charges separated");
    expect(ricefw).not.toContain("RICEFW-5");
  });
  it("neutralises client text in the narrative", () => {
    const hostile = structuredClone(data(rentalDraftV3));
    hostile.discovery.asIsSteps[0] = { ...hostile.discovery.asIsSteps[0]!, description: "<script>alert(1)</script> see [link](http://evil.example)" };
    const text = renderMarkdown(buildReport(hostile));
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("[link]");
  });
});

describe("version 3 report: model-generated sections", () => {
  const registers = section("Solution design registers");
  it("shows step type, phase and interim process on each step", () => {
    expect(section("To-Be steps")).toContain("**Step type:** In system, manual. **Phase:** Phase 1.");
    const later: DetailedDesign = { ...rentalDraftV3, steps: rentalDraftV3.steps.map((step, i) => i === 0 ? { ...step, phase: "Phase 2", interimProcess: "Spreadsheet until Phase 2." } : step) };
    expect(renderMarkdown(buildReport(data(later)))).toContain("**Phase:** Phase 2. **Interim process until it goes live:** Spreadsheet until Phase 2.");
  });
  it("renders every new register and extended column", () => {
    for (const heading of ["Fit-gap (clean core)", "Reports", "Document status models", "Configuration catalogue", "Role catalogue", "Actors and roles", "Segregation of duties",
      "Control mappings", "End-to-end scenarios", "Organisation structure", "Master-data prerequisites", "Interfaces", "KPIs"]) expect(registers, heading).toContain(`### ${heading}`);
    for (const expected of ["Open hire items by return date", "Hire order", "Partly returned", "Business to provide", "Rental coordinator", "Assessed: no conflict",
      "Hire from order to billing", "Key-user extension", "Rental coordinator", "Created by the master-data steward", "ROLE-3"]) expect(registers, expected).toContain(expected);
    const objectives = section("Objectives and scope");
    expect(objectives).toContain("Track every hire unit as its own item");
    expect(objectives).toContain("Out of scope");
  });
  it("traceability CSV carries a row for each traced new register", () => {
    const csv = renderTraceabilityCsv(buildReport(data(rentalDraftV3)));
    for (const kind of ["Objective", "In scope", "Document status model", "Report", "End-to-end test"]) expect(csv, kind).toContain(kind);
    expect(csv).toContain("Fit-gap: Key-user extension");
  });
  it("a control mapping appears in the CSV against its requirement", () => {
    const withControl: DetailedDesign = { ...rentalDraftV3, controlMappings: [{ id: "CTL-1", requirementId: "R-4", mechanism: "BUSINESS_RULE", realization: "A missing date blocks completion.", stepIds: ["TB-2"], ruleId: "BR-3" }] };
    const csv = renderTraceabilityCsv(buildReport(data(withControl)));
    expect(csv).toContain("Control mapping");
    expect(csv).toContain("A missing date blocks completion.");
  });
});

describe("version 3 report: review findings", () => {
  const found = renderMarkdown(buildReport({ ...data(rentalDraftV3), blockers: [
    { code: "CONFIG_DOCUMENT_TYPE_MISSING", path: "draft.documentStatusModels.0" }, { code: "ROLE_ACTOR_UNMATCHED", path: "draft.steps.1" },
    { code: "OPEN_QUESTION", path: "draft.openQuestions.0" }] }));
  it("lists each heuristic finding with its code, path and a plain explanation, apart from the blockers", () => {
    const findings = section("Review findings", found);
    expect(findings).toContain("CONFIG_DOCUMENT_TYPE_MISSING, at draft.documentStatusModels.0");
    expect(findings).toContain("no matching document-type entry in the configuration catalogue");
    expect(findings).toContain("ROLE_ACTOR_UNMATCHED, at draft.steps.1");
    expect(findings).not.toContain("OPEN_QUESTION");
    expect(section("Blockers", found)).toContain("OPEN_QUESTION");
    expect(section("Blockers", found)).not.toContain("ROLE_ACTOR_UNMATCHED");
  });
  it("has no section when there are no findings", () => {
    expect(markdown).not.toContain("## Review findings");
  });
});

describe("older designs still render", () => {
  it("a version 2 design shows its registers without the version 3 sections", () => {
    const text = renderMarkdown(buildReport(data(rentalDraftV2)));
    expect(text).toContain("### Fit-gap (clean core)");
    expect(text).not.toContain("### Reports");
    expect(text).not.toContain("## Objectives and scope");
    expect(text).toContain("## Document control");
    expect(text).toContain("## As-Is narratives");
    expect(buildReport(data(rentalDraftV2)).steps[0]).toMatchObject({ typeLabel: "In system, manual" });
  });
  it("a version 1 design has no registers, no RICEFW list and no step-type line without a type", () => {
    const bare = (step: DetailedDesign["steps"][number]) => { const copy: Record<string, unknown> = { ...step }; for (const key of ["stepType", "phase", "interimProcess"]) delete copy[key]; return copy as DetailedDesign["steps"][number]; };
    const v1: DetailedDesign = { ...rentalDraft, steps: rentalDraft.steps.map(bare) };
    const model = buildReport(data(v1));
    const text = renderMarkdown(model);
    expect(model.solution).toBeNull();
    expect(model.derived.ricefwList).toEqual([]);
    expect(text).not.toContain("**Step type:**");
    expect(text).toContain("## Document control");
  });
});

describe("report: sections added with the consistency work", () => {
  const rich = structuredClone(rentalDraftV3);
  rich.orgStructure![0] = { ...rich.orgStructure![0]!, codeStatus: "CODE_CONFIRMED", code: "4100", owner: "Finance controller" };
  rich.interfaces = [{ id: "IF-1", counterpartSystem: "Customer portal", direction: "INBOUND", triggerFrequency: "Daily", payload: "Proof of delivery", errorOwner: "Integration lead",
    outOfScopeReason: null, referenceIds: [], needsValidation: true, validationReason: "API to be confirmed", requirementIds: [], contextFieldIds: [], stepIds: ["TB-2"],
    failureHandling: { detection: "Error list", alerting: "Mail", rerun: "Resend", idempotency: "Key stored" }, systemOfRecord: "SAP for the posting, the portal for the plan" }];
  const text = renderMarkdown(buildReport({ ...data(rich), blockers: [{ code: "REVIEW_CONTRADICTION", path: "draft.steps.1", detail: "TB-2 says A while DSM-1 says B." },
    { code: "UNRESOLVED_CODE", path: "draft.steps.0", detail: "movement type 321" }] }));
  it("shows the accounting entry on each step, the org code and owner, the interface's system of record and the period-end list", () => {
    expect(text).toContain("**Accounting entry:** None: reserving hire items posts nothing to accounting.");
    expect(section("Solution design registers", text)).toContain("System of record");
    expect(text).toContain("SAP for the posting, the portal for the plan");
    expect(text).toMatch(/\| ORG-1 \| Company code \| 4100 \| Finance controller \|/);
    expect(markdown).toMatch(/\| ORG-1 \| Company code \| Business to provide \| Billing clerk \|/);
    expect(section("Solution design registers", text)).toContain("### Period-end activities");
    expect(text).toContain(rentalDraftV3.periodEndActivities![0]!.activity);
  });
  it("lists review-pass and code findings under Review findings with the reviewer's sentence and the code", () => {
    const findings = section("Review findings", text);
    expect(findings).toContain("TB-2 says A while DSM-1 says B.");
    expect(findings).toContain("movement type 321");
    expect(findings).toContain("code REVIEW_CONTRADICTION");
    expect(text).not.toContain("## Blockers");
  });
});
