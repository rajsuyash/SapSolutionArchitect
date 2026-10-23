// Sections of the To-Be document that are built by the server from trusted inputs, with no model call: the document control block
// (frozen revision metadata, generation date, target product and release), the As-Is narrative per To-Be step (the client-sourced
// descriptions of the steps it replaces) and the consolidated RICEFW list (derived from the fit-gap register and the steps that cite it).
// The report renders them and the eval judge receives them next to the design, so a reader sees the same document the consultant gets.
import type { DetailedDesign } from "./ai/design-quality";
import type { DiscoveryInput } from "./discovery";

export const PLACEHOLDER = "to be assigned";
/** Reviewer roles are placeholders: the server does not know who the project's reviewers are, and never approves anything. */
export const REVIEWER_ROLES = ["Process owner", "SAP solution architect", "Business key user", "Control and compliance reviewer"] as const;
/** Fit-gap classes that need something built or connected, and so appear in the RICEFW list. */
export const RICEFW_CLASSES = ["CLASSIC_RICEFW", "SIDE_BY_SIDE_BTP", "KEY_USER_EXTENSION", "STANDARD_INTEGRATION"] as const;

export type DeriveMeta = {
  sourceRevision: number | null; variantCode: string | null; variantName: string; snapshotId: string | null; generatedAt: string | null;
  targetProduct: string; targetRelease: string | null;
  sources: readonly { id: string; title: string; revision: string; digest?: string }[];
};
export type DeriveInput = {
  design: DetailedDesign;
  asIsSteps: readonly Pick<DiscoveryInput["asIsSteps"][number], "id" | "sequence" | "name" | "actor" | "system" | "trigger" | "description" | "inputs" | "outputs" | "controls" | "exceptions">[];
  meta: DeriveMeta;
};

export type DocumentControl = {
  title: string; version: string; date: string; status: "HUMAN_REVIEW_REQUIRED"; designSchemaVersion: number;
  sourceRevision: { discoveryRevision: number | null; variantCode: string | null; variantName: string; snapshotId: string | null;
    targetProduct: string; targetRelease: string; sources: { id: string; title: string; revision: string; digest: string }[] };
  reviewerRoles: { role: string; assignee: string }[];
  signOff: { role: string; name: string; date: string; status: "HUMAN_REVIEW_REQUIRED" }[];
};
export type AsIsNarrative = { toBeStepId: string; toBeTitle: string;
  asIs: { asIsStepId: string; name: string; actor: string; system: string; trigger: string; description: string; inputs: string[]; outputs: string[]; controls: string[]; exceptions: string[] }[] };
export type EliminatedAsIs = { asIsStepId: string; name: string; description: string; reason: string };
/** Where a RICEFW item comes from: a fit-gap row, a step realised as an extension or integration, or a report or KPI built with custom analytics. */
export type RicefwSource = "FIT_GAP" | "STEP" | "ANALYTICS";
export type RicefwItem = { id: string; source: RicefwSource; type: string; classification: string; requirementId: string | null; linkedSteps: { id: string; title: string }[];
  rationale: string; referenceIds: string[]; needsValidation: boolean; validationReason: string | null; owner: string | null; status: string | null };
export type ActorRoleRow = { stepId: string; actor: string; roleIds: string[] };
export type DerivedSections = {
  documentControl: DocumentControl; asIsNarratives: AsIsNarrative[]; eliminatedAsIs: EliminatedAsIs[]; ricefwList: RicefwItem[]; actorRoles: ActorRoleRow[];
};

const NOT_RECORDED = "Not recorded";
const isoDate = (iso: string | null) => iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : NOT_RECORDED;

export function documentControl({ design, meta }: Pick<DeriveInput, "design" | "meta">): DocumentControl {
  return {
    title: design.processName, version: "0.1 draft", date: isoDate(meta.generatedAt), status: "HUMAN_REVIEW_REQUIRED", designSchemaVersion: design.schemaVersion,
    sourceRevision: { discoveryRevision: meta.sourceRevision, variantCode: meta.variantCode, variantName: meta.variantName, snapshotId: meta.snapshotId,
      targetProduct: meta.targetProduct, targetRelease: meta.targetRelease ?? "not decided",
      sources: meta.sources.map(source => ({ id: source.id, title: source.title, revision: source.revision, digest: source.digest ?? NOT_RECORDED })) },
    reviewerRoles: REVIEWER_ROLES.map(role => ({ role, assignee: PLACEHOLDER })),
    // Sign-off is always a human act: whatever the design checks say, the table starts empty and review-required.
    signOff: REVIEWER_ROLES.map(role => ({ role, name: PLACEHOLDER, date: "-", status: "HUMAN_REVIEW_REQUIRED" as const })),
  };
}

/** The As-Is text of each To-Be step's replaced steps, kept apart from every To-Be statement. */
export function asIsNarratives({ design, asIsSteps }: Pick<DeriveInput, "design" | "asIsSteps">): { narratives: AsIsNarrative[]; eliminated: EliminatedAsIs[] } {
  const byId = new Map(asIsSteps.map(step => [step.id, step]));
  return {
    narratives: design.steps.map(step => ({ toBeStepId: step.id, toBeTitle: step.title,
      asIs: step.asIsStepIds.flatMap(asIsStepId => {
        const asIs = byId.get(asIsStepId);
        return asIs ? [{ asIsStepId, name: asIs.name, actor: asIs.actor, system: asIs.system, trigger: asIs.trigger, description: asIs.description,
          inputs: [...asIs.inputs], outputs: [...asIs.outputs], controls: [...asIs.controls], exceptions: [...asIs.exceptions] }] : [];
      }) })),
    eliminated: design.eliminatedAsIsSteps.map(item => ({ asIsStepId: item.asIsStepId, name: byId.get(item.asIsStepId)?.name ?? "Unknown current step",
      description: byId.get(item.asIsStepId)?.description ?? "", reason: item.reason })),
  };
}

/** A report or KPI whose realization names something built: custom or key-user queries and CDS views, BTP or SAP Analytics Cloud content. */
const CUSTOM_ANALYTICS = /\b(?:custom(?:ised|ized)?|bespoke)\b|\bCDS\b|\banalytical quer|\bSAP Analytics Cloud\b|\bSAC\b|\bBTP\b|\bkey[- ]user (?:report|quer|view|analytic)/i;
const STEP_KIND_ITEM = { EXTENSION: { type: "ENHANCEMENT", classification: "STEP_EXTENSION" }, INTEGRATION: { type: "INTERFACE", classification: "STEP_INTEGRATION" } } as const;
const RATIONALE_CHARS = 400;

/** Everything that needs something built or connected, once each: the fit-gap rows of the classes in RICEFW_CLASSES, every step whose realization is an
 * extension or an integration and that no such row already links, and every report or KPI realised with custom analytics. Version 1 designs have no registers. */
export function ricefwList({ design }: Pick<DeriveInput, "design">): RicefwItem[] {
  const classes: readonly string[] = RICEFW_CLASSES;
  const titleOf = (stepIds: ReadonlySet<string>) => design.steps.filter(step => stepIds.has(step.id)).map(step => ({ id: step.id, title: step.title }));
  const items: Omit<RicefwItem, "id">[] = (design.fitGap ?? []).filter(row => classes.includes(row.classification)).map(row => {
    const linked = new Set([...row.stepIds, ...design.steps.filter(step => step.requirementIds.includes(row.requirementId)).map(step => step.id)]);
    return { source: "FIT_GAP" as const, type: row.ricefwType ?? row.classification, classification: row.classification, requirementId: row.requirementId,
      linkedSteps: titleOf(linked), rationale: row.justification, referenceIds: row.referenceIds, needsValidation: row.needsValidation, validationReason: row.validationReason,
      owner: row.owner ?? null, status: row.status ?? null };
  });
  const covered = new Set(items.flatMap(item => item.linkedSteps.map(step => step.id)));
  for (const step of design.steps) {
    const kind = step.implementation.kind;
    if ((kind !== "EXTENSION" && kind !== "INTEGRATION") || covered.has(step.id)) continue;
    covered.add(step.id);
    const referenced = step.implementation.referenceIds.length > 0;
    items.push({ source: "STEP", ...STEP_KIND_ITEM[kind], requirementId: step.requirementIds[0] ?? null, linkedSteps: titleOf(new Set([step.id])),
      rationale: step.implementation.detail.slice(0, RATIONALE_CHARS), referenceIds: step.implementation.referenceIds, needsValidation: !referenced,
      validationReason: referenced ? null : "The step is an extension or integration but cites no catalog reference.", owner: null, status: null });
  }
  const analytics = [
    ...(design.reports ?? []).map(row => ({ ...row, text: `${row.name}: ${row.realization}`, linked: row.stepIds })),
    ...(design.kpis ?? []).map(row => ({ ...row, text: `${row.name}: ${row.measuredFrom}`, linked: [...row.stepIds, ...(row.producingStepId ? [row.producingStepId] : [])] })),
  ];
  for (const row of analytics) {
    if (!CUSTOM_ANALYTICS.test(row.text) || items.some(item => item.type === "REPORT" && item.requirementId !== null && row.requirementIds.includes(item.requirementId))) continue;
    items.push({ source: "ANALYTICS", type: "REPORT", classification: "CUSTOM_ANALYTICS", requirementId: row.requirementIds[0] ?? null, linkedSteps: titleOf(new Set(row.linked)),
      rationale: row.text.slice(0, RATIONALE_CHARS), referenceIds: row.referenceIds, needsValidation: row.needsValidation, validationReason: row.validationReason, owner: null, status: null });
  }
  return items.map((item, i) => ({ id: `RICEFW-${i + 1}`, ...item }));
}

/** Which role-catalogue rows cover each step, next to the step's actor as written. */
export const actorRoles = ({ design }: Pick<DeriveInput, "design">): ActorRoleRow[] =>
  design.steps.map(step => ({ stepId: step.id, actor: step.actor, roleIds: (design.roles ?? []).filter(role => role.stepIds.includes(step.id)).map(role => role.id) }));

export function deriveSections(input: DeriveInput): DerivedSections {
  const { narratives, eliminated } = asIsNarratives(input);
  return { documentControl: documentControl(input), asIsNarratives: narratives, eliminatedAsIs: eliminated, ricefwList: ricefwList(input), actorRoles: actorRoles(input) };
}
