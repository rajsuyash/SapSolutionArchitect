// Sections of the To-Be document that are built by the server from trusted inputs, with no model call: the document control block
// (frozen revision metadata, generation date, target product and release), the As-Is narrative per To-Be step (the client-sourced
// descriptions of the steps it replaces) and the consolidated RICEFW list (derived from the fit-gap register and the steps that cite it).
// The report renders them and the eval judge receives them next to the design, so a reader sees the same document the consultant gets.
import type { DetailedDesign } from "./ai/design-quality";
import { BUILT_CLASSES, buildTypeOf } from "./ai/design-registers-v3";
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
/** Input open questions read as IQ-1..IQ-n in the design text; `label` is the readable id, `id` the original one. */
export const inputQuestionLabel = (index: number) => `IQ-${index + 1}`;
export type InputQuestionRow = { label: string; id: string; question: string; owner: string };
export const inputQuestionRows = (questions: readonly { id: string; question: string; owner: string; label?: string }[]): InputQuestionRow[] =>
  questions.map((item, i) => ({ label: item.label ?? inputQuestionLabel(i), id: item.id, question: item.question, owner: item.owner }));

export type DeriveInput = {
  design: DetailedDesign;
  /** The input open questions the result still carries, in input order. */
  inputQuestions?: readonly { id: string; question: string; owner: string; label?: string }[];
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
/** Where a RICEFW item comes from: a fit-gap row, a step realised as (or described as) a build, a report or KPI built with custom analytics, an interface, or a load program. */
export type RicefwSource = "FIT_GAP" | "STEP" | "ANALYTICS" | "INTERFACE" | "MIGRATION";
export type RicefwItem = { id: string; source: RicefwSource; type: string; classification: string; requirementId: string | null; linkedSteps: { id: string; title: string }[];
  rationale: string; referenceIds: string[]; needsValidation: boolean; validationReason: string | null; owner: string | null; status: string | null };
export type ActorRoleRow = { stepId: string; actor: string; roleIds: string[] };
export type DerivedSections = {
  documentControl: DocumentControl; asIsNarratives: AsIsNarrative[]; eliminatedAsIs: EliminatedAsIs[]; ricefwList: RicefwItem[]; actorRoles: ActorRoleRow[]; inputQuestions: InputQuestionRow[];
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
    return { source: "FIT_GAP" as const, type: row.ricefwType ?? (BUILT_CLASSES.includes(row.classification) ? buildTypeOf(row.justification)?.type : undefined) ?? row.classification, classification: row.classification, requirementId: row.requirementId,
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
  // A step whose realization text names a build (a key-user extension, custom field or logic, form, workflow) but whose kind is not extension or integration.
  for (const step of design.steps) {
    const built = buildTypeOf(step.implementation.detail);
    if (!built || covered.has(step.id) || step.implementation.kind === "EXTENSION" || step.implementation.kind === "INTEGRATION") continue;
    covered.add(step.id);
    const referenced = step.implementation.referenceIds.length > 0;
    items.push({ source: "STEP", type: built.type, classification: "STEP_BUILD", requirementId: step.requirementIds[0] ?? null, linkedSteps: titleOf(new Set([step.id])),
      rationale: step.implementation.detail.slice(0, RATIONALE_CHARS), referenceIds: step.implementation.referenceIds, needsValidation: !referenced,
      validationReason: referenced ? null : "The step names something to build but cites no catalog reference.", owner: null, status: null });
  }
  // Every interface in scope is something to build or connect, unless a fit-gap item or step already lists its steps.
  for (const row of design.interfaces ?? []) {
    if (row.outOfScopeReason || row.stepIds.some(stepId => covered.has(stepId))) continue;
    row.stepIds.forEach(stepId => covered.add(stepId));
    items.push({ source: "INTERFACE", type: "INTERFACE", classification: "INTERFACE_REGISTER", requirementId: row.requirementIds[0] ?? null, linkedSteps: titleOf(new Set(row.stepIds)),
      rationale: `${row.counterpartSystem} (${row.direction.toLowerCase()}): ${row.payload}`.slice(0, RATIONALE_CHARS), referenceIds: row.referenceIds, needsValidation: row.needsValidation,
      validationReason: row.validationReason, owner: row.errorOwner, status: null });
  }
  // A migration object loaded by a custom program or script is a conversion item.
  for (const row of design.dataMigration ?? []) {
    if (buildTypeOf(`${row.approach}`)?.type !== "CONVERSION") continue;
    items.push({ source: "MIGRATION", type: "CONVERSION", classification: "MIGRATION_PROGRAM", requirementId: row.requirementIds[0] ?? null, linkedSteps: titleOf(new Set(row.stepIds)),
      rationale: `${row.object}: ${row.approach}`.slice(0, RATIONALE_CHARS), referenceIds: [], needsValidation: true,
      validationReason: "The load program is proposed from the approach text; a consultant must confirm it is needed instead of the standard migration tools.", owner: null, status: null });
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
  return mergeDuplicateRicefw(items).map((item, i) => ({ id: `RICEFW-${i + 1}`, ...item }));
}

const RICEFW_TOKEN_OVERLAP = 0.6, RICEFW_MIN_TOKENS = 4;
const ricefwTokens = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
/** Of two items of one type, true when they are the same thing listed twice: the same requirement, a shared step (two fit-gap rows for different requirements are never merged), or
 * rationales that share 60% of the words of the shorter one. */
function sameRicefwItem(a: Omit<RicefwItem, "id">, b: Omit<RicefwItem, "id">): boolean {
  if (a.type !== b.type) return false;
  if (a.source === "FIT_GAP" && b.source === "FIT_GAP" && a.requirementId !== b.requirementId) return false;
  const tokensA = ricefwTokens(a.rationale), tokensB = ricefwTokens(b.rationale);
  const shared = [...tokensA].filter(token => tokensB.has(token)).length, smaller = Math.min(tokensA.size, tokensB.size);
  if (smaller >= RICEFW_MIN_TOKENS && shared / smaller >= RICEFW_TOKEN_OVERLAP) return true;
  if (a.requirementId !== null && a.requirementId === b.requirementId) return true;
  return a.linkedSteps.some(step => b.linkedSteps.some(other => other.id === step.id));
}
/** Items listed twice (a fit-gap row and a step, or two steps, naming the same enhancement) become one: the first item stays, with the union of steps and references. */
function mergeDuplicateRicefw(items: Omit<RicefwItem, "id">[]): Omit<RicefwItem, "id">[] {
  const kept: Omit<RicefwItem, "id">[] = [];
  for (const item of items) {
    const i = kept.findIndex(other => sameRicefwItem(other, item));
    if (i < 0) { kept.push(item); continue; }
    const first = kept[i]!;
    kept[i] = { ...first, requirementId: first.requirementId ?? item.requirementId, needsValidation: first.needsValidation || item.needsValidation,
      validationReason: first.validationReason ?? item.validationReason, owner: first.owner ?? item.owner, status: first.status ?? item.status,
      linkedSteps: [...new Map([...first.linkedSteps, ...item.linkedSteps].map(step => [step.id, step])).values()], referenceIds: [...new Set([...first.referenceIds, ...item.referenceIds])] };
  }
  return kept;
}

/** Which role-catalogue rows cover each step, next to the step's actor as written. */
export const actorRoles = ({ design }: Pick<DeriveInput, "design">): ActorRoleRow[] =>
  design.steps.map(step => ({ stepId: step.id, actor: step.actor, roleIds: (design.roles ?? []).filter(role => role.stepIds.includes(step.id)).map(role => role.id) }));

export function deriveSections(input: DeriveInput): DerivedSections {
  const { narratives, eliminated } = asIsNarratives(input);
  return { documentControl: documentControl(input), asIsNarratives: narratives, eliminatedAsIs: eliminated, ricefwList: ricefwList(input), actorRoles: actorRoles(input), inputQuestions: inputQuestionRows(input.inputQuestions ?? []) };
}
