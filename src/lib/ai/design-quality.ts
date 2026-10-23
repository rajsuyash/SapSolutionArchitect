import { z } from "zod";

export const text = z.string().trim().min(1).max(8000);
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const ids = z.array(id).max(200);
const texts = z.array(text).min(1).max(100);
export const list = <T extends z.ZodType>(schema: T) => z.array(schema).max(200);
export const IMPLEMENTATION_KINDS = ["STANDARD", "CONFIGURATION", "EXTENSION", "INTEGRATION", "MANUAL", "NEEDS_VALIDATION"] as const;

export const FIT_TYPES = ["STANDARD", "CONFIGURATION", "EXTENSION", "INTEGRATION", "MANUAL", "LICENSE_DEPENDENT"] as const;

/** A reference is trusted only because a server-side curated catalog supplied it. */
export const TrustedReferenceSchema = z.strictObject({
  id, targetProduct: text, targetRelease: text,
  status: z.enum(["VERIFIED", "UNVERIFIED"]), evidence: text,
  fitType: z.enum(FIT_TYPES),
  capability: text.optional(), objects: z.array(text).max(50).optional(),
  limitations: z.array(text).max(50).optional(), evidenceUrls: z.array(text).max(10).optional(),
});
export type TrustedReference = z.infer<typeof TrustedReferenceSchema>;

/** Internal evaluation input. Approved decisions and verified references must
 * come from authorized server records, never from the generated response. */
export const DesignContextSchema = z.strictObject({
  targetProduct: z.enum(["S4HANA_CLOUD_PUBLIC", "S4HANA_CLOUD_PRIVATE", "S4HANA_ON_PREMISE"]),
  targetRelease: text,
  asIsSteps: list(z.strictObject({ id, name: text })).min(1),
  sources: list(z.strictObject({ id, locator: text, text: text.max(40000) })).min(1),
  requirements: list(z.strictObject({ id, asIsStepId: id, sourceId: id, quote: text, critical: z.boolean() })).min(1),
  conflicts: list(z.strictObject({ id, sourceIds: ids.min(1), question: text })),
  approvedDecisions: list(z.strictObject({
    id, subjectType: z.enum(["REQUIREMENT", "CONFLICT"]), subjectId: id,
    outcome: z.enum(["DEFERRED", "REJECTED", "RESOLVED"]), rationale: text,
  })),
  references: list(TrustedReferenceSchema),
  /** Ids of OPEN decisions supplied as guidance (never approvals). Omitted on the hosted path. */
  decisionRegister: list(z.strictObject({ id })).optional(),
});

export const DetailedDesignSchema = z.strictObject({
  schemaVersion: z.literal(1), processName: text,
  steps: list(z.strictObject({
    id, sequence: z.number().int().positive(), title: text,
    asIsStepIds: ids, requirementIds: ids.min(1), actor: text, trigger: text,
    inputDocuments: texts, outputDocuments: texts,
    actions: list(z.strictObject({ actor: text, system: text, operation: text, fields: texts })).min(1),
    businessRules: list(z.strictObject({ id, condition: text, response: text })).min(1),
    exceptions: list(z.strictObject({ condition: text, response: text, owner: text })),
    exceptionsNotApplicableReason: text.nullable(),
    masterData: list(z.strictObject({ object: text, fields: texts, owner: text })).min(1),
    effects: z.strictObject({ inventory: text, financial: text, ownership: text }),
    implementation: z.strictObject({
      kind: z.enum(IMPLEMENTATION_KINDS),
      detail: text, referenceIds: ids,
    }),
    /** Open decisions (decisionRegister ids) this step is held on or conditional on. */
    decisionIds: ids.optional(),
    addedValue: text,
    acceptanceTests: list(z.strictObject({
      id, kind: z.enum(["NORMAL", "EXCEPTION"]), given: text, when: text, then: text,
      requirementIds: ids.min(1),
    })).min(1),
  })).min(1),
  eliminatedAsIsSteps: list(z.strictObject({ asIsStepId: id, reason: text })),
  coverage: list(z.strictObject({
    requirementId: id, disposition: z.enum(["IMPLEMENTED", "CONDITIONAL", "DEFERRED", "REJECTED"]),
    stepIds: ids, decisionId: id.nullable(), rationale: text,
    /** CONDITIONAL = behaviour itself partly designed, a future capability, or two designs remain open. IMPLEMENTED may also link decisionIds for policy values still open. */
    decisionIds: ids.optional(), questionIds: ids.optional(),
  })),
  conflictDecisions: list(z.strictObject({ conflictId: id, decisionId: id.nullable() })),
  openQuestions: list(z.strictObject({ id, question: text, owner: text, affectedStepIds: ids.min(1), decisionIds: ids.optional() })),
});

export type DesignContext = z.infer<typeof DesignContextSchema>;
export type DetailedDesign = z.infer<typeof DetailedDesignSchema>;
type Issue = { code: string; path: string; detail?: string };
const MAX_DRAFT_ERRORS = 20;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
/** Locate a strict-parse failure for the repair loop: real path, issue code and
 * key names/expected types only. Model-supplied values are never echoed. */
export function draftIssues(issues: z.core.$ZodIssue[]): Issue[] {
  return issues.slice(0, MAX_DRAFT_ERRORS).map(issue => {
    const path = ["draft", ...issue.path.filter(part => typeof part === "number" || (typeof part === "string" && SAFE_NAME.test(part)))].join(".");
    const extra = issue.code === "unrecognized_keys" ? issue.keys.slice(0, 5).map(key => SAFE_NAME.test(key) ? key : "<unsafe_key>").join(", ")
      : issue.code === "invalid_type" ? `expected ${String(issue.expected).slice(0, 20)}` : "";
    return { code: "INVALID_DRAFT", path: path.slice(0, 200), detail: `${issue.code}${extra ? `: ${extra}` : ""}`.slice(0, 200) };
  });
}
export type DesignEvaluation = {
  structurallyValid: boolean; errors: Issue[]; blockers: Issue[];
  reviewStatus: "BLOCKED" | "HUMAN_REVIEW_REQUIRED";
};

/** This checks structure and trace integrity, not semantic correctness.
 * Even a clean result requires a consultant to review business/SAP fit. */
export function evaluateDesign(input: unknown, value: unknown): DesignEvaluation {
  const errors: Issue[] = [];
  const blockers: Issue[] = [];
  const error = (code: string, path: string, detail?: string) => { errors.push(detail ? { code, path, detail } : { code, path }); };
  const block = (code: string, path: string) => { blockers.push({ code, path }); };
  const result = (): DesignEvaluation => ({
    structurallyValid: errors.length === 0, errors, blockers,
    reviewStatus: errors.length || blockers.length ? "BLOCKED" : "HUMAN_REVIEW_REQUIRED",
  });
  const parsedInput = DesignContextSchema.safeParse(input);
  const parsedDraft = DetailedDesignSchema.safeParse(value);
  // Do not return raw Zod values or model-controlled property names.
  if (!parsedInput.success) error("INVALID_INPUT", "input");
  if (!parsedDraft.success) errors.push(...draftIssues(parsedDraft.error.issues));
  if (!parsedInput.success || !parsedDraft.success) return result();
  const context = parsedInput.data;
  const draft = parsedDraft.data;
  const unique = (values: string[], path: string, code: string) => {
    if (new Set(values).size !== values.length) error(code, path);
  };
  for (const key of ["asIsSteps", "sources", "requirements", "conflicts", "approvedDecisions", "references"] as const) {
    unique(context[key].map(item => item.id), `input.${key}`, "DUPLICATE_INPUT_ID");
  }
  const asIs = new Set(context.asIsSteps.map(item => item.id));
  const sources = new Map(context.sources.map(item => [item.id, item]));
  const requirements = new Map(context.requirements.map(item => [item.id, item]));
  const conflicts = new Map(context.conflicts.map(item => [item.id, item]));
  const decisions = new Map(context.approvedDecisions.map(item => [item.id, item]));
  const references = new Map(context.references.map(item => [item.id, item]));
  const openDecisions = new Set((context.decisionRegister ?? []).map(item => item.id));
  // With no register supplied every decision link is unknown, so decisionIds must be empty.
  const checkDecisions = (refs: string[] | undefined, path: string) => {
    unique(refs ?? [], path, "DUPLICATE_TRACE");
    if ((refs ?? []).some(ref => !openDecisions.has(ref))) error("UNKNOWN_DECISION", path);
  };
  context.requirements.forEach((requirement, i) => {
    const path = `input.requirements.${i}`;
    if (!asIs.has(requirement.asIsStepId)) error("UNKNOWN_AS_IS", path);
    const source = sources.get(requirement.sourceId);
    if (!source) error("UNKNOWN_SOURCE", path);
    else if (!source.text.includes(requirement.quote)) error("SOURCE_QUOTE_INVALID", path);
  });
  context.conflicts.forEach((conflict, i) => {
    unique(conflict.sourceIds, `input.conflicts.${i}`, "DUPLICATE_TRACE");
    if (conflict.sourceIds.some(sourceId => !sources.has(sourceId))) error("UNKNOWN_SOURCE", `input.conflicts.${i}`);
  });
  context.approvedDecisions.forEach((decision, i) => {
    const valid = decision.subjectType === "REQUIREMENT"
      ? requirements.has(decision.subjectId) && decision.outcome !== "RESOLVED"
      : conflicts.has(decision.subjectId) && decision.outcome === "RESOLVED";
    if (!valid) error("INVALID_APPROVED_DECISION", `input.approvedDecisions.${i}`);
  });
  const releaseMissing = /^(tbd|unknown|not specified|n\/a)$/i.test(context.targetRelease);
  if (releaseMissing) block("TARGET_RELEASE_MISSING", "input.targetRelease");
  const approved = (decisionId: string | null, subjectType: "REQUIREMENT" | "CONFLICT",
    subjectId: string, outcome: "DEFERRED" | "REJECTED" | "RESOLVED", path: string) => {
    const decision = decisionId ? decisions.get(decisionId) : undefined;
    if (!decision || decision.subjectType !== subjectType || decision.subjectId !== subjectId || decision.outcome !== outcome) {
      error("DECISION_NOT_APPROVED", path);
    }
  };
  unique([...draft.steps.map(step => step.id), ...draft.steps.flatMap(step => [
    ...step.businessRules.map(rule => rule.id), ...step.acceptanceTests.map(test => test.id),
  ]), ...draft.openQuestions.map(question => question.id)], "draft", "DUPLICATE_OUTPUT_ID");
  const steps = new Map(draft.steps.map(step => [step.id, step]));
  draft.steps.forEach((step, i) => {
    const path = `draft.steps.${i}`;
    if (step.sequence !== i + 1) error("INVALID_SEQUENCE", path);
    unique(step.asIsStepIds, path, "DUPLICATE_TRACE");
    unique(step.requirementIds, path, "DUPLICATE_TRACE");
    checkDecisions(step.decisionIds, path);
    if (step.asIsStepIds.some(ref => !asIs.has(ref))) error("UNKNOWN_AS_IS", path);
    for (const ref of step.requirementIds) {
      const requirement = requirements.get(ref);
      if (!requirement) error("UNKNOWN_REQUIREMENT", path);
      else if (!step.asIsStepIds.includes(requirement.asIsStepId)) error("AS_IS_TRACE_MISMATCH", path);
    }
    if (!step.exceptions.length && !step.exceptionsNotApplicableReason) error("EXCEPTION_SCOPE_MISSING", path);
    if (step.exceptions.length && step.exceptionsNotApplicableReason) error("EXCEPTION_SCOPE_CONFLICT", path);
    if (!step.acceptanceTests.some(test => test.kind === "NORMAL")) error("NORMAL_TEST_MISSING", path);
    if (step.exceptions.length && !step.acceptanceTests.some(test => test.kind === "EXCEPTION")) error("EXCEPTION_TEST_MISSING", path);
    step.acceptanceTests.forEach((test, j) => {
      unique(test.requirementIds, `${path}.acceptanceTests.${j}`, "DUPLICATE_TRACE");
      for (const ref of test.requirementIds) {
        if (!requirements.has(ref)) error("UNKNOWN_REQUIREMENT", `${path}.acceptanceTests.${j}`);
        else if (!step.requirementIds.includes(ref)) error("TEST_TRACE_MISMATCH", `${path}.acceptanceTests.${j}`);
      }
    });
    const implementation = step.implementation;
    unique(implementation.referenceIds, `${path}.implementation`, "DUPLICATE_TRACE");
    if (implementation.referenceIds.some(ref => !references.has(ref))) error("UNKNOWN_REFERENCE", `${path}.implementation`);
    if (implementation.kind === "NEEDS_VALIDATION") block("IMPLEMENTATION_UNVERIFIED", `${path}.implementation`);
    const cited = implementation.referenceIds.flatMap(ref => references.get(ref) ?? []);
    const fitMismatch = () => error("SAP_FIT_MISMATCH", `${path}.implementation`,
      `kind ${implementation.kind}; cited ${cited.map(reference => `${reference.id}=${reference.fitType}`).join(", ")}`.slice(0, 200));
    const applicable = !releaseMissing && cited.length > 0 && cited.every(reference =>
      reference.status === "VERIFIED" && reference.targetProduct === context.targetProduct &&
      reference.targetRelease === context.targetRelease);
    if (cited.some(reference => reference.fitType === "LICENSE_DEPENDENT")) block("LICENSE_ENTITLEMENT_UNCONFIRMED", `${path}.implementation`);
    if (implementation.kind === "STANDARD" || implementation.kind === "CONFIGURATION") {
      if (!applicable) error("SAP_APPLICABILITY_UNVERIFIED", `${path}.implementation`);
      // Standard/configuration may be realized by either, never by an extension or license-gated entry.
      else if (cited.some(reference => reference.fitType !== "STANDARD" && reference.fitType !== "CONFIGURATION") ||
          !cited.some(reference => reference.fitType === implementation.kind)) fitMismatch();
    } else if (implementation.kind === "EXTENSION" || implementation.kind === "INTEGRATION") {
      if (!cited.length) block("SAP_REFERENCE_MISSING", `${path}.implementation`);
      else if (!applicable) error("SAP_APPLICABILITY_UNVERIFIED", `${path}.implementation`);
      else if (!cited.some(reference => reference.fitType === implementation.kind)) fitMismatch();
    }
  });
  unique(draft.eliminatedAsIsSteps.map(item => item.asIsStepId), "draft.eliminatedAsIsSteps", "DUPLICATE_DISPOSITION");
  const mapped = new Set(draft.steps.flatMap(step => step.asIsStepIds));
  const eliminated = new Set(draft.eliminatedAsIsSteps.map(item => item.asIsStepId));
  draft.eliminatedAsIsSteps.forEach((item, i) => {
    if (!asIs.has(item.asIsStepId)) error("UNKNOWN_AS_IS", `draft.eliminatedAsIsSteps.${i}`);
    if (mapped.has(item.asIsStepId)) error("AS_IS_DISPOSITION_CONFLICT", `draft.eliminatedAsIsSteps.${i}`);
  });
  context.asIsSteps.forEach((step, i) => {
    if (!mapped.has(step.id) && !eliminated.has(step.id)) error("AS_IS_UNCOVERED", `input.asIsSteps.${i}`);
  });
  unique(draft.coverage.map(item => item.requirementId), "draft.coverage", "DUPLICATE_DISPOSITION");
  const questionIds = new Set(draft.openQuestions.map(question => question.id));
  const coverage = new Map(draft.coverage.map(item => [item.requirementId, item]));
  draft.coverage.forEach((item, i) => {
    const path = `draft.coverage.${i}`;
    if (!requirements.has(item.requirementId)) error("UNKNOWN_REQUIREMENT", path);
    unique(item.stepIds, path, "DUPLICATE_TRACE");
    if (item.stepIds.some(ref => !steps.has(ref))) error("UNKNOWN_STEP", path);
    const traced = draft.steps.filter(step => step.requirementIds.includes(item.requirementId));
    checkDecisions(item.decisionIds, path);
    unique(item.questionIds ?? [], path, "DUPLICATE_TRACE");
    if ((item.questionIds ?? []).some(ref => !questionIds.has(ref))) error("UNKNOWN_QUESTION", path);
    if (item.disposition === "CONDITIONAL") {
      if (!item.decisionIds?.length && !item.questionIds?.length) error("CONDITIONAL_UNLINKED", path);
      block("COVERAGE_CONDITIONAL", path);
    }
    if (item.disposition === "IMPLEMENTED" || item.disposition === "CONDITIONAL") {
      if (!item.stepIds.length || traced.length !== item.stepIds.length ||
          traced.some(step => !item.stepIds.includes(step.id))) error("COVERAGE_TRACE_MISMATCH", path);
      if (item.decisionId !== null) error("UNEXPECTED_DECISION", path);
      if (requirements.get(item.requirementId)?.critical &&
          (!traced.length || traced.some(step => !step.acceptanceTests.some(test => test.requirementIds.includes(item.requirementId))))) {
        error("CRITICAL_REQUIREMENT_UNTESTED", path);
      }
    } else {
      approved(item.decisionId, "REQUIREMENT", item.requirementId, item.disposition, path);
      if (item.stepIds.length || traced.length) error("COVERAGE_TRACE_MISMATCH", path);
    }
  });
  context.requirements.forEach((item, i) => {
    if (!coverage.has(item.id)) error("REQUIREMENT_UNDISPOSITIONED", `input.requirements.${i}`);
  });
  unique(draft.conflictDecisions.map(item => item.conflictId), "draft.conflictDecisions", "DUPLICATE_DISPOSITION");
  draft.conflictDecisions.forEach((item, i) => {
    const path = `draft.conflictDecisions.${i}`;
    if (!conflicts.has(item.conflictId)) error("UNKNOWN_CONFLICT", path);
    if (item.decisionId === null) block("OPEN_CONFLICT", path);
    else approved(item.decisionId, "CONFLICT", item.conflictId, "RESOLVED", path);
  });
  context.conflicts.forEach((item, i) => {
    if (!draft.conflictDecisions.some(decision => decision.conflictId === item.id)) error("CONFLICT_UNDISPOSITIONED", `input.conflicts.${i}`);
  });
  draft.openQuestions.forEach((question, i) => {
    const path = `draft.openQuestions.${i}`;
    unique(question.affectedStepIds, path, "DUPLICATE_TRACE");
    checkDecisions(question.decisionIds, path);
    if (question.affectedStepIds.some(ref => !steps.has(ref))) error("UNKNOWN_STEP", path);
    block("OPEN_QUESTION", path);
  });
  return result();
}

/** Preserve original source excerpts alongside each proposed step.
 * A valid comparison can still be blocked and must display its evaluation. */
export function materializeComparison(input: unknown, value: unknown) {
  if (!evaluateDesign(input, value).structurallyValid) throw new Error("INVALID_DETAILED_DESIGN");
  const context = DesignContextSchema.parse(input);
  const draft = DetailedDesignSchema.parse(value);
  const sources = new Map(context.sources.map(source => [source.id, source]));
  return draft.steps.map(step => ({
    sourceFacts: context.requirements.filter(requirement => step.requirementIds.includes(requirement.id)).map(requirement => ({
      requirementId: requirement.id, sourceId: requirement.sourceId,
      locator: sources.get(requirement.sourceId)!.locator, quote: requirement.quote,
    })),
    toBe: step,
  }));
}
