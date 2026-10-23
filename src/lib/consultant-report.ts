// Reviewable To-Be report: one pure view-model shared by the page, the JSON endpoint and the exports.
// Human labels live here only. Internal codes are kept as secondary text for consultants.
import { z } from "zod";
import { DetailedDesignSchema, type DetailedDesign, type TrustedReference } from "./ai/design-quality";
import type { DiscoveryInput } from "./discovery";
import { WORKSPACE_FIELDS } from "./workspace-fields";

/** What the server stores plus the context needed to read it. Never contains provider metrics, sources text or secrets. */
export type ReportData = {
  jobId: string; project: { name: string; clientName: string }; variant: { code: string; name: string };
  targetProduct: string; targetRelease: string | null; sourceRevision: number; generatedAt: string | null;
  discovery: Pick<DiscoveryInput, "asIsSteps" | "requirements" | "conflicts" | "openQuestions"> & {
    sources: { id: string; title: string; locator: string; revision: string }[] };
  design: DetailedDesign; blockers: { code: string; path: string }[];
  unresolvedInputQuestions: { id: string; question: string; owner: string }[];
  /** Only references the design cites, resolved from the curated catalog at read time. */
  references: TrustedReference[];
  /** Size of the curated catalog for this product and release; 0 means no SAP claim in the design could be verified. */
  catalogReferenceCount: number;
};

const StoredSchema = z.object({
  design: DetailedDesignSchema,
  evaluation: z.object({ blockers: z.array(z.object({ code: z.string().max(80), path: z.string().max(200) })).max(1000) }),
  unresolvedInputQuestions: z.array(z.object({ id: z.string(), question: z.string(), owner: z.string() })).max(100),
  sourceRevision: z.number().int(), snapshotId: z.string(),
});
/** Re-validates what was stored; a corrupted row must fail loudly rather than render partially. */
export const parseStoredToBe = (result: unknown) => StoredSchema.parse(result);

export const PRODUCT_LABELS: Record<string, string> = {
  S4HANA_CLOUD_PUBLIC: "SAP S/4HANA Cloud Public Edition", S4HANA_CLOUD_PRIVATE: "SAP S/4HANA Cloud Private Edition",
  S4HANA_ON_PREMISE: "SAP S/4HANA on-premise" };
const FIT_LABELS: Record<string, string> = { STANDARD: "Standard SAP", CONFIGURATION: "Configuration", EXTENSION: "Extension",
  INTEGRATION: "Integration", MANUAL: "Manual process", LICENSE_DEPENDENT: "Licence-dependent", NEEDS_VALIDATION: "Needs SAP validation" };
const DISPOSITION_LABELS = { IMPLEMENTED: "Implemented in the To-Be design", DEFERRED: "Deferred (approved decision)", REJECTED: "Rejected (approved decision)",
  CONDITIONAL: "Conditional on an open decision (partly designed)" } as const;
const FIT_CLASS_LABELS: Record<string, string> = { STANDARD: "Standard", CONFIGURATION: "Configuration", STANDARD_INTEGRATION: "Standard integration (released SAP API)", KEY_USER_EXTENSION: "Key-user extension",
  SIDE_BY_SIDE_BTP: "Side-by-side (BTP)", CLASSIC_RICEFW: "Classic custom development (RICEFW)", MANUAL_WORKAROUND: "Manual workaround" };
const DIRECTION_LABELS: Record<string, string> = { INBOUND: "Into SAP", OUTBOUND: "From SAP", BIDIRECTIONAL: "Both ways" };
const contextLabel = (fieldId: string) => WORKSPACE_FIELDS.find(field => field.id === fieldId)?.label ?? "Company context";
const KIND_LABELS: Record<string, string> = { PAIN_POINT: "Pain point", TO_BE_REQUIREMENT: "Future requirement", CONTROL: "Control" };
const BLOCKERS: Record<string, { category: string; label: string }> = {
  TARGET_RELEASE_MISSING: { category: "Target release", label: "The target SAP release has not been decided." },
  IMPLEMENTATION_UNVERIFIED: { category: "SAP validation", label: "The SAP realization is not yet validated against the target release." },
  LICENSE_ENTITLEMENT_UNCONFIRMED: { category: "Licensing", label: "A cited SAP capability depends on a licence that is not confirmed." },
  SAP_REFERENCE_MISSING: { category: "SAP validation", label: "An extension or integration is proposed without a cited SAP reference." },
  OPEN_CONFLICT: { category: "Source conflicts", label: "Sources disagree and no approved decision resolves the conflict." },
  OPEN_QUESTION: { category: "Open decisions", label: "A business question raised in the design is still unanswered." },
  COVERAGE_CONDITIONAL: { category: "Open decisions", label: "A requirement is only partly designed until an open decision is answered." },
  INPUT_QUESTION_UNRESOLVED: { category: "Open decisions", label: "A question from discovery is still unanswered." },
};

export const STATUS_COPY = {
  BLOCKED: { label: "Blocked", detail: "This draft cannot be reviewed for approval until the blockers below are resolved. It has not been approved." },
  HUMAN_REVIEW_REQUIRED: { label: "Human review required", detail: "No automated blockers remain, but a consultant and the business owners must still review it. It has not been approved or verified against SAP." },
} as const;

const officialUrl = (value: string) => {
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "sap.com" || url.hostname.endsWith(".sap.com")); }
  catch { return false; }
};
export const formatTimestamp = (iso: string | null) => iso && !Number.isNaN(Date.parse(iso))
  ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC` : "Not recorded";

export type RefView = { id: string; found: boolean; capability: string; fit: string; objects: string[]; limitations: string[]; urls: string[] };
export type ImplementationView = { kind: string; kindLabel: string; detail: string; refs: RefView[] };
export type BlockerView = { code: string; category: string; label: string; subject: string; anchor: string | null };
export type StepStatus = { code: "BLOCKED" | "REVIEW"; label: string; blockers: BlockerView[] };
type Design = DetailedDesign["steps"][number];
export type StepView = { anchor: string; heading: string; step: Design; asIsNames: string[]; implementation: ImplementationView; status: StepStatus };
export type ComparisonRow = {
  id: string; heading: string; actor: string; system: string; trigger: string; description: string;
  requirements: { id: string; kindLabel: string; statement: string; critical: boolean; quote: string }[];
  eliminatedReason: string | null; steps: StepView[]; status: string;
};
export type TraceRow = { id: string; label: string; kindLabel: string; statement: string; critical: boolean; asIs: string; disposition: string;
  rationale: string; steps: string[]; rules: string[]; tests: string[] };
export type Register = { id: string; text: string; owner: string; affects: string; state: string };
/** Solution-design registers of a schemaVersion 2 design, already labelled. Null for a version 1 design. */
export type SolutionView = {
  decisions: { id: string; topic: string; options: string; recommendation: string; rationale: string; affects: string; owner: string; status: string; basis: string }[];
  fitGap: { requirementId: string; requirement: string; statement: string; classification: string; ricefwType: string; justification: string; sap: string; steps: string; stepTitles: string[] }[];
  orgStructure: { id: string; unitType: string; proposal: string; source: string; openPoint: string }[];
  masterData: { id: string; object: string; owner: string; keyFields: string; migrationSource: string; steps: string }[];
  interfaces: { id: string; system: string; direction: string; trigger: string; payload: string; apiCandidate: string; errorOwner: string; steps: string; scope: string }[];
  kpis: { id: string; name: string; baseline: string; target: string; measuredFrom: string; steps: string }[];
  dataMigration: { id: string; sequence: number; object: string; source: string; approach: string; risk: string }[];
  cutover: { id: string; sequence: number; activity: string; owner: string; risk: string }[];
  /** One entry per register row that traces to requirements, for the traceability export. */
  traces: { kind: string; label: string; summary: string; requirementIds: string[]; stepTitles: string[] }[];
};
export type ReportModel = ReturnType<typeof buildReport>;

/** Builds every label, count and trace once, so the page and the exports cannot disagree. */
export function buildReport(data: ReportData) {
  const { design, discovery } = data;
  const status = data.blockers.length ? "BLOCKED" as const : "HUMAN_REVIEW_REQUIRED" as const;
  const stepAt = (index: number): Design | undefined => design.steps[index];
  const stepTitle = (step: Design) => `Step ${step.sequence}: ${step.title}`;
  const anchor = (step: Design) => `step-${step.id}`;
  const refs = new Map(data.references.map(ref => [ref.id, ref]));
  // Requirement ids are internal identifiers; people read "Requirement 3".
  const requirementLabels = Object.fromEntries(discovery.requirements.map((item, index) => [item.id, `Requirement ${index + 1}`]));
  const asIsName = (id: string) => discovery.asIsSteps.find(item => item.id === id)?.name ?? "Unknown current step";

  const subjectOf = (path: string): { subject: string; anchor: string | null } => {
    const index = (pattern: RegExp) => Number(pattern.exec(path)?.[1] ?? NaN);
    const step = stepAt(index(/^draft\.steps\.(\d+)/));
    if (step) return { subject: stepTitle(step), anchor: anchor(step) };
    const question = design.openQuestions[index(/^draft\.openQuestions\.(\d+)/)];
    if (question) return { subject: question.question, anchor: "registers" };
    const decision = design.conflictDecisions[index(/^draft\.conflictDecisions\.(\d+)/)];
    if (decision) return { subject: discovery.conflicts.find(item => item.id === decision.conflictId)?.question ?? "A source conflict", anchor: "registers" };
    const input = data.unresolvedInputQuestions[index(/^input\.openQuestions\.(\d+)/)];
    if (input) return { subject: input.question, anchor: "registers" };
    return { subject: path.startsWith("input.targetRelease") ? "Project" : "Design", anchor: null };
  };
  const blockers: BlockerView[] = data.blockers.map(blocker => ({
    code: blocker.code, ...(BLOCKERS[blocker.code] ?? { category: "Other", label: "Review is needed before this can progress." }), ...subjectOf(blocker.path) }));
  const byCategory = [...Map.groupBy(blockers, item => item.category)].map(([category, items]) => ({ category, items }));

  const refView = (id: string): RefView => {
    const ref = refs.get(id);
    return ref ? { id, found: true, capability: ref.capability ?? ref.id, fit: FIT_LABELS[ref.fitType] ?? ref.fitType,
      objects: ref.objects ?? [], limitations: ref.limitations ?? [], urls: (ref.evidenceUrls ?? []).filter(officialUrl) }
      : { id, found: false, capability: "Reference no longer in the curated catalog", fit: "Unknown", objects: [], limitations: [], urls: [] };
  };
  const stepViews: StepView[] = design.steps.map(step => {
    const own = blockers.filter(item => item.anchor === anchor(step));
    return { anchor: anchor(step), heading: stepTitle(step), step, asIsNames: step.asIsStepIds.map(asIsName),
      implementation: { kind: step.implementation.kind, kindLabel: FIT_LABELS[step.implementation.kind] ?? step.implementation.kind,
        detail: step.implementation.detail, refs: step.implementation.referenceIds.map(refView) },
      status: own.length ? { code: "BLOCKED", label: `Blocked (${own.length})`, blockers: own } : { code: "REVIEW", label: "Needs human review", blockers: [] } };
  });

  const comparison: ComparisonRow[] = discovery.asIsSteps.map(asIs => {
    const eliminated = design.eliminatedAsIsSteps.find(item => item.asIsStepId === asIs.id);
    const mapped = stepViews.filter(view => view.step.asIsStepIds.includes(asIs.id));
    const blocked = mapped.some(view => view.status.code === "BLOCKED");
    return { id: asIs.id, heading: `Current step ${asIs.sequence}: ${asIs.name}`, actor: asIs.actor, system: asIs.system,
      trigger: asIs.trigger, description: asIs.description,
      requirements: discovery.requirements.filter(item => item.asIsStepId === asIs.id).map(item => ({ id: item.id,
        kindLabel: KIND_LABELS[item.kind] ?? item.kind, statement: item.statement, critical: item.critical, quote: item.evidence.quote })),
      eliminatedReason: eliminated?.reason ?? null, steps: mapped,
      status: eliminated ? "Eliminated by design, needs human review" : !mapped.length ? "Not covered"
        : blocked ? "Blocked" : "Needs human review" };
  });

  const traceability: TraceRow[] = discovery.requirements.map(requirement => {
    const coverage = design.coverage.find(item => item.requirementId === requirement.id);
    const covering = design.steps.filter(step => step.requirementIds.includes(requirement.id));
    return { id: requirement.id, label: requirementLabels[requirement.id]!, kindLabel: KIND_LABELS[requirement.kind] ?? requirement.kind, statement: requirement.statement,
      critical: requirement.critical, asIs: asIsName(requirement.asIsStepId),
      disposition: coverage ? DISPOSITION_LABELS[coverage.disposition] : "No disposition recorded",
      rationale: coverage?.rationale ?? "", steps: covering.map(stepTitle),
      rules: covering.flatMap(step => step.businessRules.map(rule => `${rule.id} (${stepTitle(step)})`)),
      tests: covering.flatMap(step => step.acceptanceTests.filter(test => test.requirementIds.includes(requirement.id)).map(test => test.id)) };
  });

  const stepNames = (ids: string[]) => ids.map(id => design.steps.find(step => step.id === id)).flatMap(step => step ? [stepTitle(step)] : []).join("; ");
  const questions: Register[] = [
    ...design.openQuestions.map(item => ({ id: item.id, text: item.question, owner: item.owner, affects: stepNames(item.affectedStepIds), state: "Open" })),
    ...data.unresolvedInputQuestions.map(item => ({ id: item.id, text: item.question, owner: item.owner, affects: "Whole process", state: "Open" })),
  ];
  const conflicts: Register[] = discovery.conflicts.map(conflict => {
    const decision = design.conflictDecisions.find(item => item.conflictId === conflict.id);
    return { id: conflict.id, text: conflict.question, owner: "Project lead", affects: "Sources: " + conflict.sourceIds.join(", "),
      state: decision?.decisionId ? "Resolved by approved decision" : "Open" };
  });
  const sapPoints: Register[] = stepViews.flatMap(view => {
    const notes: { text: string; state: string }[] = [
      ...(view.implementation.kind === "NEEDS_VALIDATION" ? [{ text: "Validate the SAP realization for the target release.", state: "Not validated" }] : []),
      ...view.implementation.refs.flatMap(ref => [
        ...ref.limitations.map(limit => ({ text: `${ref.capability}: ${limit}`, state: "Limitation to confirm" })),
        ...(ref.found ? [] : [{ text: "A cited reference is missing from the curated catalog.", state: "Not validated" }])]),
    ];
    return notes.map((note, index) => ({ id: `${view.step.id}-${index + 1}`, text: note.text, owner: "SAP consultant", affects: view.heading, state: note.state }));
  });

  const solution = ((): SolutionView | null => {
    if (design.schemaVersion !== 2) return null;
    const requirementRefs = (list: string[]) => list.map(item => requirementLabels[item] ?? "Unknown requirement").join(", ");
    const contextRefs = (list: string[]) => list.map(contextLabel).join(", ");
    const stepList = (list: string[]) => list.flatMap(item => { const step = design.steps.find(candidate => candidate.id === item); return step ? [stepTitle(step)] : []; });
    const sap = (row: { referenceIds: string[]; needsValidation: boolean; validationReason: string | null }) =>
      [...row.referenceIds.map(item => { const view = refView(item); return `${view.capability} [${view.id}]`; }),
        ...(row.needsValidation ? [`Needs SAP validation: ${row.validationReason ?? "no reason recorded"}`] : [])].join("; ") || "-";
    const result: SolutionView = {
      decisions: (design.keyDesignDecisions ?? []).map(row => ({ id: row.id, topic: row.topic, recommendation: row.recommendation, rationale: row.rationale,
        options: row.options.map(option => `${option.name} (${FIT_LABELS[option.fitType] ?? option.fitType}). Pros: ${option.pros} Cons: ${option.cons}`).join("\n"),
        affects: stepList(row.impactedStepIds).join("; "), owner: row.owner, status: "Proposed, not approved",
        basis: [requirementRefs(row.requirementIds), contextRefs(row.contextFieldIds)].filter(Boolean).join("; ") || "-" })),
      fitGap: (design.fitGap ?? []).map(row => ({ requirementId: row.requirementId, requirement: requirementLabels[row.requirementId] ?? "Unknown requirement",
        statement: discovery.requirements.find(item => item.id === row.requirementId)?.statement ?? "", classification: FIT_CLASS_LABELS[row.classification] ?? row.classification,
        ricefwType: row.ricefwType ?? "-", justification: row.justification, sap: sap(row), steps: stepList(row.stepIds).join("; "), stepTitles: stepList(row.stepIds) })),
      orgStructure: (design.orgStructure ?? []).map(row => ({ id: row.id, unitType: row.unitType, proposal: row.proposal,
        source: [contextRefs(row.contextFieldIds), requirementRefs(row.requirementIds), stepList(row.stepIds).join("; ")].filter(Boolean).join("; ") || "-",
        openPoint: row.openPoint ?? "-" })),
      masterData: (design.masterDataPrerequisites ?? []).map(row => ({ id: row.id, object: row.object, owner: row.owner, keyFields: row.keyFields.join(", "),
        migrationSource: row.migrationSource, steps: stepList(row.stepIds).join("; ") || "-" })),
      interfaces: (design.interfaces ?? []).map(row => ({ id: row.id, system: row.counterpartSystem, direction: DIRECTION_LABELS[row.direction] ?? row.direction,
        trigger: row.triggerFrequency, payload: row.payload, apiCandidate: sap(row), errorOwner: row.errorOwner, steps: stepList(row.stepIds).join("; ") || "-",
        scope: row.outOfScopeReason ? `Out of scope: ${row.outOfScopeReason}` : "In scope" })),
      kpis: (design.kpis ?? []).map(row => ({ id: row.id, name: row.name, baseline: row.baseline, target: row.target,
        measuredFrom: `${row.measuredFrom} (${sap(row)})`, steps: stepList(row.stepIds).join("; ") || "-" })),
      dataMigration: [...(design.dataMigration ?? [])].sort((a, b) => a.sequence - b.sequence)
        .map(row => ({ id: row.id, sequence: row.sequence, object: row.object, source: row.source, approach: row.approach, risk: row.risk })),
      cutover: [...(design.cutover ?? [])].sort((a, b) => a.sequence - b.sequence)
        .map(row => ({ id: row.id, sequence: row.sequence, activity: row.activity, owner: row.owner, risk: row.risk })),
      traces: [],
    };
    const trace = (kind: string, label: string, summary: string, requirementIds: string[], stepIds: string[]) =>
      requirementIds.length ? [{ kind, label, summary, requirementIds, stepTitles: stepList(stepIds) }] : [];
    result.traces = [
      ...(design.keyDesignDecisions ?? []).flatMap(row => trace("Key design decision", row.id, `${row.topic}: recommend ${row.recommendation}. ${row.rationale}`, row.requirementIds, row.impactedStepIds)),
      ...(design.orgStructure ?? []).flatMap(row => trace("Organisation structure", row.id, `${row.unitType}: ${row.proposal}`, row.requirementIds, row.stepIds)),
      ...(design.masterDataPrerequisites ?? []).flatMap(row => trace("Master data", row.id, `${row.object} (${row.owner})`, row.requirementIds, row.stepIds)),
      ...(design.interfaces ?? []).flatMap(row => trace("Interface", row.id, `${row.counterpartSystem}, ${DIRECTION_LABELS[row.direction]}: ${row.payload}`, row.requirementIds, row.stepIds)),
      ...(design.kpis ?? []).flatMap(row => trace("KPI", row.id, `${row.name}: baseline ${row.baseline}, target ${row.target}`, row.requirementIds, row.stepIds)),
      ...(design.dataMigration ?? []).flatMap(row => trace("Data migration", row.id, `${row.object}: ${row.approach}`, row.requirementIds, row.stepIds)),
      ...(design.cutover ?? []).flatMap(row => trace("Cutover", row.id, row.activity, row.requirementIds, row.stepIds)),
    ];
    const flagged = [...(design.fitGap ?? []), ...(design.kpis ?? []), ...(design.interfaces ?? [])].filter(row => row.needsValidation);
    sapPoints.push(...flagged.map((row, index) => ({ id: `register-${index + 1}`, text: row.validationReason ?? "Validate against the target release.",
      owner: "SAP consultant", affects: "Solution-design registers", state: "Not validated" })));
    return result;
  })();

  const coverageCount = (kind: keyof typeof DISPOSITION_LABELS) => design.coverage.filter(item => item.disposition === kind).length;
  return {
    data, requirementLabels, status, statusCopy: STATUS_COPY[status], blockers, blockersByCategory: byCategory,
    header: { project: data.project.name, client: data.project.clientName, variant: data.variant.name,
      sourceRevision: data.sourceRevision, product: PRODUCT_LABELS[data.targetProduct] ?? data.targetProduct,
      release: data.targetRelease ?? "Not decided", generatedAt: formatTimestamp(data.generatedAt), processName: design.processName },
    summary: { asIsSteps: discovery.asIsSteps.length, eliminated: design.eliminatedAsIsSteps.length, toBeSteps: design.steps.length,
      rules: design.steps.reduce((sum, step) => sum + step.businessRules.length, 0),
      exceptions: design.steps.reduce((sum, step) => sum + step.exceptions.length, 0),
      tests: design.steps.reduce((sum, step) => sum + step.acceptanceTests.length, 0), requirements: discovery.requirements.length,
      implemented: coverageCount("IMPLEMENTED"), deferred: coverageCount("DEFERRED"), rejected: coverageCount("REJECTED"),
      openQuestions: questions.length, conflicts: conflicts.length },
    catalogWarning: data.catalogReferenceCount === 0
      ? `Warning: there is no verified SAP reference catalog for ${PRODUCT_LABELS[data.targetProduct] ?? data.targetProduct} ${data.targetRelease ?? "(release not decided)"}. Every SAP claim in this design needs SAP validation.` : null,
    comparison, steps: stepViews, traceability, registers: { questions, conflicts, sapPoints }, solution,
    sources: discovery.sources,
  };
}

export const TEST_LABEL = "Specified — not executed";
export const testKindLabel = (kind: "NORMAL" | "EXCEPTION") => kind === "NORMAL" ? "Normal path" : "Exception path";
