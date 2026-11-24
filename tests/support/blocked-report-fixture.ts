import { DetailedDesignSchema } from "../../src/lib/ai/design-quality";
import type { ReportData } from "../../src/lib/consultant-report";

// A fixture shaped like the live report (test-results/live-report-audit/46-report.md): 8 unvalidated steps, 11 conditional requirements,
// open questions, input questions, review findings and one code the report does not know.
const evidence = { sourceId: "S1", quote: "Returns are logged late." };
export const STEPS = 8, REQUIREMENTS = 11;
export const ids = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
const step = (n: number) => ({
  id: `TB-${n}`, sequence: n, title: `Handle stage ${n}`, asIsStepIds: ["A1"], requirementIds: [], actor: "Clerk", trigger: "Asset returned",
  inputDocuments: ["Note"], outputDocuments: ["Record"], actions: [{ actor: "Clerk", system: "SAP", operation: "Post", fields: ["Date"] }],
  businessRules: [{ id: `BR-${n}`, condition: "Date missing", response: "Block" }], exceptions: [], exceptionsNotApplicableReason: "None",
  masterData: [{ object: "Asset", fields: ["Status"], owner: "Stores" }], effects: { inventory: "Same", financial: "None", ownership: "Same" },
  implementation: { kind: "NEEDS_VALIDATION", detail: "To validate.", referenceIds: [] }, addedValue: "Accuracy",
  acceptanceTests: [{ id: `T-${n}`, kind: "NORMAL", given: "g", when: "w", then: "t", requirementIds: [] }],
});
const design = DetailedDesignSchema.parse({
  schemaVersion: 1, processName: "Stock transfers", steps: ids(STEPS).map(step), eliminatedAsIsSteps: [],
  coverage: ids(REQUIREMENTS).map(n => ({ requirementId: `R${n}`, disposition: "CONDITIONAL", stepIds: [], decisionId: null, questionIds: ["Q-1"], rationale: "Held on Q-1." })),
  conflictDecisions: [],
  openQuestions: [{ id: "Q-1", question: "Who approves credits?", owner: "Finance lead", affectedStepIds: ["TB-1"] },
    { id: "Q-2", question: "Which plants are in scope?", owner: "Process owner", affectedStepIds: ["TB-2"] }],
});
const blockers = [
  ...ids(STEPS).map(n => ({ code: "IMPLEMENTATION_UNVERIFIED", path: `draft.steps.${n - 1}.implementation` })),
  ...ids(REQUIREMENTS).map(n => ({ code: "COVERAGE_CONDITIONAL", path: `draft.coverage.${n - 1}` })),
  { code: "OPEN_QUESTION", path: "draft.openQuestions.0" }, { code: "OPEN_QUESTION", path: "draft.openQuestions.1" },
  ...ids(6).map(n => ({ code: "INPUT_QUESTION_UNRESOLVED", path: `input.openQuestions.${n - 1}` })),
  { code: "RETAINED_SYSTEM_UNCOVERED", path: "draft.interfaces" },
  { code: "ROLE_STEP_UNCOVERED", path: "draft.steps.2" }, { code: "REVIEW_CONTRADICTION", path: "draft.steps.3", detail: "TB-4 says A while TB-5 says B." },
  ...ids(12).map(n => ({ code: "E2E_STEP_UNCOVERED", path: `draft.steps.${n % STEPS}` })),
  { code: "BRAND_NEW_CODE", path: "draft.steps.0" },
];
export const blockedReportData: ReportData = {
  jobId: "00000000-0000-4000-8000-000000000002", project: { name: "Transfers", clientName: "Synthetic client" },
  variant: { code: "STO", name: "Stock transfer" }, targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: "2023", sourceRevision: 3, generatedAt: "2026-11-01T09:30:00.000Z",
  discovery: {
    asIsSteps: [{ id: "A1", sequence: 1, name: "Log return", actor: "Clerk", system: "Sheet", trigger: "Return", description: "Typed.", inputs: [], outputs: [], controls: [], exceptions: [], evidence }],
    requirements: ids(REQUIREMENTS).map(n => ({ id: `R${n}`, asIsStepId: "A1", kind: "TO_BE_REQUIREMENT" as const, statement: `Requirement statement number ${n}`, critical: false, evidence })),
    conflicts: [], openQuestions: [], sources: [{ id: "S1", title: "Interview", locator: "p1", revision: "1" }],
  },
  design, blockers,
  unresolvedInputQuestions: ids(6).map(n => ({ id: `IQ-${n}`, question: `Input question ${n}?`, owner: "Process owner" })),
  catalogReferenceCount: 0, references: [],
};
