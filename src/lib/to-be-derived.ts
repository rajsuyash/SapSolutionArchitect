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
export type RicefwItem = { id: string; type: string; classification: string; requirementId: string; linkedSteps: { id: string; title: string }[];
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

/** One entry per fit-gap row that needs something built or connected, with the steps that cite its requirement. Version 1 designs have no fit-gap. */
export function ricefwList({ design }: Pick<DeriveInput, "design">): RicefwItem[] {
  const classes: readonly string[] = RICEFW_CLASSES;
  return (design.fitGap ?? []).filter(row => classes.includes(row.classification)).map((row, i) => {
    const linked = new Set([...row.stepIds, ...design.steps.filter(step => step.requirementIds.includes(row.requirementId)).map(step => step.id)]);
    return { id: `RICEFW-${i + 1}`, type: row.ricefwType ?? row.classification, classification: row.classification, requirementId: row.requirementId,
      linkedSteps: design.steps.filter(step => linked.has(step.id)).map(step => ({ id: step.id, title: step.title })),
      rationale: row.justification, referenceIds: row.referenceIds, needsValidation: row.needsValidation, validationReason: row.validationReason,
      owner: row.owner ?? null, status: row.status ?? null };
  });
}

/** Which role-catalogue rows cover each step, next to the step's actor as written. */
export const actorRoles = ({ design }: Pick<DeriveInput, "design">): ActorRoleRow[] =>
  design.steps.map(step => ({ stepId: step.id, actor: step.actor, roleIds: (design.roles ?? []).filter(role => role.stepIds.includes(step.id)).map(role => role.id) }));

export function deriveSections(input: DeriveInput): DerivedSections {
  const { narratives, eliminated } = asIsNarratives(input);
  return { documentControl: documentControl(input), asIsNarratives: narratives, eliminatedAsIs: eliminated, ricefwList: ricefwList(input), actorRoles: actorRoles(input) };
}
