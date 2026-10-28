import { z } from "zod";
import type { CompanyContext } from "./company-context";
import { MAX_OPEN_QUESTIONS, validateDiscovery, type DiscoveryInput } from "./discovery";
import { describeField, REASK_AFTER_USER_TURNS, REASK_SUFFIX, STEP_GAP_PREFIX, STEP_KEYS as stepKeys, STEP_LABELS, STEP_QUESTIONS as stepQuestions,
  describeBlocker, stepLabel, TO_CONFIRM, WORKSPACE_FIELDS } from "./workspace-fields";
import { parseInterviewInput, revalidateStoredTurn, type InterviewInput, type InterviewTurn, type Scope } from "./ai/discovery-interview";

// Re-exported for server callers; the client imports ./workspace-fields directly.
export { WORKSPACE_FIELDS };
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const text = (max = 8000) => z.string().min(1).max(max).refine(value => !!value.trim() && !value.includes("\0"));
const label = text(200);
const evidence = z.strictObject({ sourceId: id, quote: text() });
const status = z.enum(["EMPTY", "KNOWN", "UNKNOWN", "NOT_APPLICABLE", "OWNER_PENDING"]);
const targetProduct = z.enum(["S4HANA_CLOUD_PUBLIC", "S4HANA_CLOUD_PRIVATE", "S4HANA_ON_PREMISE"]);

const fieldIds = new Set<string>(WORKSPACE_FIELDS.map(field => field.id));
const FactSchema = z.strictObject({
  id, status, value: text().nullable(), rationale: text(1000).nullable(), owner: label.nullable(),
  evidence: evidence.nullable(), acceptedBy: id.nullable(), acceptedAt: z.iso.datetime().nullable(),
});
const StepDraftSchema = z.strictObject({ id, fields: z.array(FactSchema).length(stepKeys.length) });
const RequirementDraftSchema = z.strictObject({ id, asIsStepId: id,
  kind: z.enum(["PAIN_POINT", "TO_BE_REQUIREMENT", "CONTROL"]), critical: z.boolean(), statement: FactSchema });
const SourceSchema = z.strictObject({
  id, kind: z.enum(["MESSAGE", "DOCUMENT", "USER_ENTRY"]), title: label, revision: label,
  locator: label, text: text(40000), createdBy: id, createdAt: z.iso.datetime(),
});
const StepSchema = z.strictObject({
  id, name: label, actor: label, system: label, trigger: text(), description: text(),
  inputs: z.array(text()).max(50), outputs: z.array(text()).max(50), controls: z.array(text()).max(50),
  exceptions: z.array(text()).max(50), evidence,
});
const RequirementSchema = z.strictObject({
  id, asIsStepId: id, kind: z.enum(["PAIN_POINT", "TO_BE_REQUIREMENT", "CONTROL"]),
  statement: text(), critical: z.boolean(), evidence,
});
const requirementKind = z.enum(["PAIN_POINT", "TO_BE_REQUIREMENT", "CONTROL"]);
/** PROPOSE_STEP / PROPOSE_REQUIREMENT create a draft when accepted; their `fieldId` is only a placeholder. The optional
 * keys are absent from proposals written before interviewer-created structure existed. */
const ProposalSchema = z.strictObject({
  id, fieldId: id, operation: z.enum(["PROPOSE_SET", "PROPOSE_REPLACE", "PROPOSE_STEP", "PROPOSE_REQUIREMENT"]),
  previousValue: text().nullable(), value: text(), sourceId: id, quote: text(),
  nameHint: text(200).nullable().optional(), stepRef: id.optional(), kind: requirementKind.optional(), critical: z.boolean().optional(),
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]), createdAt: z.iso.datetime(), decidedBy: id.nullable(),
});
const MessageSchema = z.strictObject({ id, role: z.enum(["user", "assistant"]), text: text(20000),
  createdBy: id.nullable(), createdAt: z.iso.datetime(),
  /** A fixed server-written answer to a request for the To-Be (see `toBeNote`), shown beside the reply; absent on other messages. */
  note: text(1000).optional() });
/** `askedAtUserTurn` (user messages so far) drives the single re-ask; questions stored before it existed count as turn 0. */
const QuestionSchema = z.strictObject({ gapKey: id, fieldId: id, question: text(500), whyItMatters: text(500),
  askedAtRevision: z.number().int().positive(), askedAtUserTurn: z.number().int().nonnegative().optional() });
const ObservationSchema = z.strictObject({ id, kind: z.enum(["POSSIBLE_CONFLICT", "FOLLOW_UP_SUGGESTION"]),
  fieldIds: z.array(id).min(1).max(10), detail: text(1000), status: z.enum(["PENDING", "DISMISSED", "RESOLVED"]),
  rationale: text(1000).nullable(), reviewedBy: id.nullable() });
/** `withGaps`: confirmed as a draft whose incomplete step details travel on as open questions. Absent on older confirmations. */
const ConfirmationSchema = z.strictObject({ revision: z.number().int().positive(), by: id, at: z.iso.datetime(), withGaps: z.boolean().optional() });

export const WorkspaceStateSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: z.number().int().positive().max(2147483647),
  variantCode: z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/), variantName: label,
  targetProduct, targetRelease: label.nullable(), problemStatement: text(8000),
  sources: z.array(SourceSchema).max(200), messages: z.array(MessageSchema).max(500),
  facts: z.array(FactSchema).max(100), steps: z.array(StepSchema).max(200), stepDrafts: z.array(StepDraftSchema).max(200),
  requirements: z.array(RequirementSchema).max(200), requirementDrafts: z.array(RequirementDraftSchema).max(200),
  proposals: z.array(ProposalSchema).max(500),
  questions: z.array(QuestionSchema).max(500), observations: z.array(ObservationSchema).max(500),
  /** User messages whose extraction (proposals) is recorded, so a retried or replayed extraction is a no-op. Absent in
   * workspaces saved before extraction became a separate step. */
  extractedMessageIds: z.array(id).max(1000).optional(),
  confirmation: ConfirmationSchema.nullable(),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type WorkspaceMeta = { actorId: string; at: string; id: string };
const ORG_UNIT_LABELS: Record<string, string> = { COMPANY_CODE: "Company code", PLANT: "Plant", SALES_ORG: "Sales organisation", REGION: "Region" };
export const WorkspaceCreateSchema = z.strictObject({
  variantCode: z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/), variantName: label,
  targetProduct, targetRelease: label.nullable(), problemStatement: text(8000),
  /** The project's own entries, seeded as known answers; absent or empty seeds nothing. */
  modules: z.array(label).max(50).optional(),
  orgUnits: z.array(z.strictObject({ type: z.enum(Object.keys(ORG_UNIT_LABELS) as [string, ...string[]]), code: label, name: label })).max(100).optional(),
});

const StepValuesSchema = StepSchema.omit({ id: true, evidence: true });
const RequirementValuesSchema = RequirementSchema.omit({ id: true, evidence: true });
/** Client supplies only business content and references. IDs, actor and time
 * come from the authenticated server. The repository performs revision CAS. */
export const WorkspaceCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("SEND_MESSAGE"), text: text(20000) }),
  z.strictObject({ type: z.literal("ADD_SOURCE"), title: label, revision: label, locator: label, text: text(40000) }),
  z.strictObject({ type: z.literal("SET_FIELD"), fieldId: id, status: z.enum(["KNOWN", "UNKNOWN", "NOT_APPLICABLE", "OWNER_PENDING"]),
    value: text().nullable(), rationale: text(1000).nullable(), owner: label.nullable(),
    sourceId: id.nullable(), quote: text().nullable() }),
  z.strictObject({ type: z.literal("ADD_STEP"), step: StepValuesSchema }),
  z.strictObject({ type: z.literal("START_STEP_DRAFT") }),
  z.strictObject({ type: z.literal("SET_STEP_DRAFT_FIELD"), fieldId: id,
    status: z.enum(["KNOWN", "UNKNOWN", "NOT_APPLICABLE", "OWNER_PENDING"]), value: text().nullable(),
    rationale: text(1000).nullable(), owner: label.nullable(), sourceId: id.nullable(), quote: text().nullable() }),
  z.strictObject({ type: z.literal("UPDATE_STEP"), stepId: id, step: StepValuesSchema }),
  z.strictObject({ type: z.literal("SET_TARGET_RELEASE"), targetRelease: label.nullable() }),
  z.strictObject({ type: z.literal("ADD_REQUIREMENT"), requirement: RequirementValuesSchema }),
  z.strictObject({ type: z.literal("START_REQUIREMENT_DRAFT"), asIsStepId: id,
    kind: z.enum(["PAIN_POINT", "TO_BE_REQUIREMENT", "CONTROL"]), critical: z.boolean() }),
  z.strictObject({ type: z.literal("SET_REQUIREMENT_DRAFT_STATEMENT"), requirementDraftId: id,
    status: z.enum(["KNOWN", "UNKNOWN", "NOT_APPLICABLE", "OWNER_PENDING"]), value: text().nullable(),
    rationale: text(1000).nullable(), owner: label.nullable(), sourceId: id.nullable(), quote: text().nullable() }),
  z.strictObject({ type: z.literal("UPDATE_REQUIREMENT"), requirementId: id, requirement: RequirementValuesSchema }),
  z.strictObject({ type: z.literal("DECIDE_PROPOSAL"), proposalId: id, decision: z.enum(["ACCEPT", "REJECT"]) }),
  z.strictObject({ type: z.literal("DECIDE_PROPOSALS"), ids: z.array(id).min(1).max(100), decision: z.enum(["ACCEPT", "REJECT"]) }),
  z.strictObject({ type: z.literal("REVIEW_OBSERVATION"), observationId: id,
    decision: z.enum(["DISMISS", "RESOLVE"]), rationale: text(1000) }),
  z.strictObject({ type: z.literal("CONFIRM"), allowGaps: z.boolean().optional() }),
]);
export type WorkspaceCommand = z.infer<typeof WorkspaceCommandSchema>;

function fail(code: string): never { throw new Error(code); }
function unique(values: string[]) { return new Set(values).size === values.length; }
function checkMeta(meta: WorkspaceMeta) {
  if (!id.safeParse(meta.actorId).success || !id.safeParse(meta.id).success || !z.iso.datetime().safeParse(meta.at).success) fail("INVALID_WORKSPACE_META");
}
const emptyFact = (factId: string): WorkspaceState["facts"][number] => ({ id: factId, status: "EMPTY", value: null,
  rationale: null, owner: null, evidence: null, acceptedBy: null, acceptedAt: null });
/** Workspaces persisted before a catalog field existed lack its fact: add it EMPTY (never invented) on every read. */
export function backfillCatalog(state: WorkspaceState): WorkspaceState {
  const missing = WORKSPACE_FIELDS.filter(field => !state.facts.some(f => f.id === field.id));
  return missing.length ? { ...state, facts: [...state.facts, ...missing.map(field => emptyFact(field.id))] } : state;
}
function checked(state: WorkspaceState): WorkspaceState {
  const parsed = WorkspaceStateSchema.safeParse(state);
  if (!parsed.success || !unique(state.sources.map(x => x.id)) || !unique(state.messages.map(x => x.id)) ||
    !unique(state.steps.map(x => x.id)) || !unique(state.requirements.map(x => x.id)) ||
    !unique(state.proposals.map(x => x.id)) || !unique(state.observations.map(x => x.id)) ||
    !unique(state.facts.map(x => x.id)) ||
    !unique(state.stepDrafts.map(x => x.id)) ||
    !unique(state.requirementDrafts.map(x => x.id)) ||
    state.requirementDrafts.some(d => d.statement.id !== `${d.id}_statement`) ||
    state.stepDrafts.some(d => d.fields.length !== stepKeys.length ||
      stepKeys.some(key => !d.fields.some(f => f.id === `${d.id}_${key}`))) ||
    state.facts.some(f => !fieldIds.has(f.id) || (f.status === "KNOWN") !== (f.value !== null) ||
      (f.status === "NOT_APPLICABLE" && !f.rationale) || (f.status === "OWNER_PENDING" && !f.owner)) ||
    state.proposals.some(p => p.operation === "PROPOSE_REQUIREMENT" && (!p.stepRef || !p.kind || p.critical === undefined)) ||
    state.sources.some(s => Buffer.byteLength(s.text, "utf8") > 40000)) fail("INVALID_WORKSPACE_STATE");
  const sources = new Map(state.sources.map(source => [source.id, source.text]));
  const validEvidence = (ref: { sourceId: string; quote: string } | null) => !ref || !!sources.get(ref.sourceId)?.includes(ref.quote);
  if ([...state.facts, ...state.stepDrafts.flatMap(d => d.fields), ...state.requirementDrafts.map(d => d.statement)].some(f => !validEvidence(f.evidence) ||
    (f.status === "KNOWN" && !f.evidence) || (f.status === "KNOWN") !== (f.value !== null) ||
    (f.status === "NOT_APPLICABLE" && !f.rationale) || (f.status === "OWNER_PENDING" && !f.owner)) ||
    state.steps.some(s => !validEvidence(s.evidence)) || state.requirements.some(r => !validEvidence(r.evidence)) ||
    state.proposals.some(p => !sources.get(p.sourceId)?.includes(p.quote) || p.value !== p.quote ||
      (!!p.nameHint && !sources.get(p.sourceId)?.includes(p.nameHint)))) fail("INVALID_WORKSPACE_EVIDENCE");
  return backfillCatalog(state);
}

export function createWorkspace(rawInput: z.infer<typeof WorkspaceCreateSchema>, meta: WorkspaceMeta): WorkspaceState {
  checkMeta(meta);
  const parsed = WorkspaceCreateSchema.safeParse(rawInput);
  if (!parsed.success) fail("INVALID_WORKSPACE_CREATE");
  const { modules = [], orgUnits = [], ...input } = parsed.data;
  const sourceId = `s_${meta.id}`;
  const source: WorkspaceState["sources"][number] = { id: sourceId, kind: "USER_ENTRY", title: "Initial problem",
    revision: "1", locator: "Initial problem", text: input.problemStatement, createdBy: meta.actorId, createdAt: meta.at };
  const known = (fieldId: string, value: string, evidence: { sourceId: string; quote: string }) => ({ id: fieldId, status: "KNOWN" as const,
    value, rationale: null, owner: null, evidence, acceptedBy: meta.actorId, acceptedAt: meta.at });
  // Existing workspaces are not migrated: only a variant created from now on starts with these answers.
  const seeded = new Map<string, string>();
  if (modules.length) seeded.set("modules_in_scope", modules.join(", "));
  if (orgUnits.length) seeded.set("target_org_units", orgUnits.map(u => `${ORG_UNIT_LABELS[u.type]} ${u.code} ${u.name}`).join("; "));
  const detailsId = `${sourceId}_project`;
  const lines = [...seeded].map(([fieldId, value]) => `${fieldId === "modules_in_scope" ? "SAP modules in scope" : "Planned organisational units"}: ${value}`);
  const sources = [source];
  if (lines.length) sources.push({ id: detailsId, kind: "USER_ENTRY", title: "Project details", revision: "1",
    locator: "Project details", text: lines.join("\n"), createdBy: meta.actorId, createdAt: meta.at });
  const facts = WORKSPACE_FIELDS.map(field => field.id === "business_problem"
    ? known(field.id, input.problemStatement, { sourceId, quote: input.problemStatement })
    : seeded.has(field.id) ? known(field.id, seeded.get(field.id)!, { sourceId: detailsId, quote: seeded.get(field.id)! })
    : emptyFact(field.id));
  return checked({ schemaVersion: 1, revision: 1, ...input, sources, messages: [], facts,
    steps: [], stepDrafts: [], requirements: [], requirementDrafts: [], proposals: [], questions: [],
    observations: [], confirmation: null });
}

function sourceForEntry(state: WorkspaceState, meta: WorkspaceMeta, textValue: string, title: string) {
  const sourceId = `s_${meta.id}`;
  if (state.sources.some(s => s.id === sourceId)) fail("DUPLICATE_WORKSPACE_ID");
  state.sources.push({ id: sourceId, kind: "USER_ENTRY", title, revision: String(state.revision + 1),
    locator: title, text: textValue, createdBy: meta.actorId, createdAt: meta.at });
  return { sourceId, quote: textValue };
}
function getEvidence(state: WorkspaceState, sourceId: string | null, quote: string | null, value: string,
  meta: WorkspaceMeta, title: string) {
  if ((sourceId === null) !== (quote === null)) fail("INVALID_WORKSPACE_EVIDENCE");
  if (sourceId !== null && quote !== null) {
    if (!state.sources.find(source => source.id === sourceId)?.text.includes(quote)) fail("INVALID_WORKSPACE_EVIDENCE");
    return { sourceId, quote };
  }
  return sourceForEntry(state, meta, value, title);
}
function findFact(state: WorkspaceState, fieldId: string) {
  return state.facts.find(f => f.id === fieldId) ?? state.stepDrafts.flatMap(d => d.fields).find(f => f.id === fieldId)
    ?? state.requirementDrafts.map(d => d.statement).find(f => f.id === fieldId);
}
function setFact(state: WorkspaceState, fact: WorkspaceState["facts"][number], command: {
  status: "KNOWN" | "UNKNOWN" | "NOT_APPLICABLE" | "OWNER_PENDING"; value: string | null;
  rationale: string | null; owner: string | null; sourceId: string | null; quote: string | null;
}, meta: WorkspaceMeta) {
  if ((command.status === "KNOWN") !== (command.value !== null) ||
    (command.status === "NOT_APPLICABLE" && !command.rationale) ||
    (command.status === "OWNER_PENDING" && !command.owner)) fail("INVALID_FIELD_STATUS");
  fact.status = command.status;
  fact.value = command.value;
  fact.rationale = command.rationale;
  fact.owner = command.owner;
  fact.evidence = command.value === null ? null : getEvidence(state, command.sourceId, command.quote, command.value, meta, `Field ${fact.id}`);
  fact.acceptedBy = meta.actorId;
  fact.acceptedAt = meta.at;
}
const CORE_STEP_KEYS = ["name", "actor", "system", "trigger", "description"] as const;
const LIST_STEP_KEYS = ["inputs", "outputs", "controls", "exceptions"] as const;
type StepDraft = WorkspaceState["stepDrafts"][number];
const draftFact = (draft: StepDraft, key: (typeof stepKeys)[number]) => draft.fields.find(f => f.id === `${draft.id}_${key}`)!;
/** The step details still missing: core ones must be KNOWN, list ones KNOWN or NOT_APPLICABLE. */
const missingKeys = (draft: StepDraft) => [
  ...CORE_STEP_KEYS.filter(key => draftFact(draft, key).status !== "KNOWN"),
  ...LIST_STEP_KEYS.filter(key => !["KNOWN", "NOT_APPLICABLE"].includes(draftFact(draft, key).status)),
];
const draftComplete = (draft: StepDraft) => missingKeys(draft).length === 0;
/** Evidence a gap-tolerant compile can cite: the description's, else the first known detail that has some. */
const draftEvidence = (draft: StepDraft) => ["description", ...stepKeys].map(key => draftFact(draft, key as (typeof stepKeys)[number])).find(f => f.status === "KNOWN" && f.evidence)?.evidence ?? null;
/** An incomplete draft can still be carried into a To-Be when it is at least named or described, with evidence. */
const draftCompilable = (draft: StepDraft) => ["name", "description"].some(key => {
  const fact = draftFact(draft, key as "name" | "description");
  return fact.status === "KNOWN" && !!fact.evidence;
});

/** Draft ids are derived from the accepted proposal, so one command may accept many and a replay cannot create twins. */
const stepDraftId = (proposalId: string) => `st_${proposalId.slice(2)}`;
const requirementDraftId = (proposalId: string) => `rq_${proposalId.slice(2)}`;
const knownFact = (factId: string, value: string, evidence: { sourceId: string; quote: string }, meta: WorkspaceMeta):
  WorkspaceState["facts"][number] => ({ id: factId, status: "KNOWN", value, rationale: null, owner: null, evidence,
  acceptedBy: meta.actorId, acceptedAt: meta.at });
/** An existing step or draft id, or the draft an accepted PROPOSE_STEP created; null while that step is not real. */
function resolveStepRef(state: WorkspaceState, ref: string): string | null {
  if ([...state.steps, ...state.stepDrafts].some(step => step.id === ref)) return ref;
  const proposal = state.proposals.find(item => item.id === ref && item.operation === "PROPOSE_STEP" && item.status === "ACCEPTED");
  const draft = proposal && stepDraftId(proposal.id);
  return draft && state.stepDrafts.some(item => item.id === draft) ? draft : null;
}

/** Accept one proposal. Returns false, leaving everything untouched, when the world moved on since it was made. */
function acceptProposal(state: WorkspaceState, proposal: WorkspaceState["proposals"][number], meta: WorkspaceMeta): boolean {
  const evidence = { sourceId: proposal.sourceId, quote: proposal.quote };
  if (proposal.operation === "PROPOSE_STEP") {
    const draftId = stepDraftId(proposal.id);
    if (state.stepDrafts.some(d => d.id === draftId) || state.stepDrafts.length + state.steps.length >= 200) return false;
    state.stepDrafts.push({ id: draftId, fields: stepKeys.map(key => {
      const factId = `${draftId}_${key}`;
      if (key === "description") return knownFact(factId, proposal.value, evidence, meta);
      return key === "name" && proposal.nameHint ? knownFact(factId, proposal.nameHint, { sourceId: proposal.sourceId, quote: proposal.nameHint }, meta)
        : emptyFact(factId);
    }) });
  } else if (proposal.operation === "PROPOSE_REQUIREMENT") {
    const draftId = requirementDraftId(proposal.id);
    const stepId = resolveStepRef(state, proposal.stepRef ?? "");
    if (!stepId || state.requirementDrafts.some(d => d.id === draftId) || state.requirementDrafts.length + state.requirements.length >= 200) return false;
    state.requirementDrafts.push({ id: draftId, asIsStepId: stepId, kind: proposal.kind!, critical: proposal.critical!,
      statement: knownFact(`${draftId}_statement`, proposal.value, evidence, meta) });
  } else {
    const fact = findFact(state, proposal.fieldId);
    if (!fact || fact.value !== proposal.previousValue ||
      (proposal.operation === "PROPOSE_SET" ? fact.status !== "EMPTY" : fact.status !== "KNOWN")) return false;
    Object.assign(fact, { status: "KNOWN", value: proposal.value, evidence, rationale: null, owner: null,
      acceptedBy: meta.actorId, acceptedAt: meta.at });
  }
  proposal.status = "ACCEPTED";
  proposal.decidedBy = meta.actorId;
  return true;
}

export function getWorkspaceReadiness(raw: WorkspaceState) {
  const state = checked(raw);
  const blockers: { code: string; fieldId?: string; detail: string; soft?: true }[] = [];
  for (const field of WORKSPACE_FIELDS) {
    const fact = state.facts.find(item => item.id === field.id)!;
    if (fact.status === "EMPTY") blockers.push({ code: "FIELD_UNANSWERED", fieldId: field.id, detail: field.label });
    else if (field.priority === "CRITICAL" && fact.status !== "KNOWN") {
      blockers.push({ code: "CRITICAL_FIELD_UNRESOLVED", fieldId: field.id, detail: field.label });
    }
  }
  if (!state.steps.length && !state.stepDrafts.length) blockers.push({ code: "AS_IS_STEP_MISSING", detail: "Describe at least one current step" });
  state.stepDrafts.forEach(draft => {
    if (!draftComplete(draft)) blockers.push({ code: "AS_IS_STEP_INCOMPLETE", detail: `Complete current step ${draft.id}`,
      ...(draftCompilable(draft) ? { soft: true as const } : {}) });
  });
  if (!state.requirements.length) blockers.push({ code: "REQUIREMENT_MISSING", detail: "Record at least one pain point or desired requirement" });
  state.requirementDrafts.forEach(draft => {
    if (draft.statement.status !== "KNOWN") blockers.push({ code: "REQUIREMENT_INCOMPLETE", detail: `Complete requirement ${draft.id}` });
  });
  if (!state.requirements.length && state.requirementDrafts.some(d => d.statement.status === "KNOWN")) {
    const index = blockers.findIndex(b => b.code === "REQUIREMENT_MISSING");
    if (index >= 0) blockers.splice(index, 1);
  }
  if (state.proposals.some(p => p.status === "PENDING")) blockers.push({ code: "PROPOSALS_PENDING", detail: "Review proposed facts" });
  if (state.observations.some(o => o.status === "PENDING")) blockers.push({ code: "OBSERVATIONS_PENDING", detail: "Review possible contradictions", soft: true });
  return { ready: blockers.length === 0, draftReady: blockers.every(b => b.soft), blockers };
}

export function applyWorkspaceCommand(rawState: WorkspaceState, rawCommand: unknown, meta: WorkspaceMeta): WorkspaceState {
  checkMeta(meta);
  const state = structuredClone(checked(rawState));
  const parsed = WorkspaceCommandSchema.safeParse(rawCommand);
  if (!parsed.success) fail("INVALID_WORKSPACE_COMMAND");
  const command = parsed.data;
  if (command.type === "CONFIRM") {
    const allowGaps = command.allowGaps === true;
    const readiness = getWorkspaceReadiness(state);
    if (!(allowGaps ? readiness.draftReady : readiness.ready)) fail("WORKSPACE_NOT_READY");
    compileDiscovery(state, { allowGaps });
    state.revision++;
    state.confirmation = { revision: state.revision, by: meta.actorId, at: meta.at, ...(allowGaps && !readiness.ready ? { withGaps: true } : {}) };
    return checked(state);
  }
  if (command.type === "SEND_MESSAGE") {
    if (state.messages.some(m => m.id === meta.id) || state.sources.some(s => s.id === meta.id)) fail("DUPLICATE_WORKSPACE_ID");
    state.messages.push({ id: meta.id, role: "user", text: command.text, createdBy: meta.actorId, createdAt: meta.at });
    state.sources.push({ id: meta.id, kind: "MESSAGE", title: "User message", revision: String(state.revision + 1),
      locator: `Message ${state.revision + 1}`, text: command.text, createdBy: meta.actorId, createdAt: meta.at });
  } else if (command.type === "ADD_SOURCE") {
    if (state.sources.some(s => s.id === meta.id)) fail("DUPLICATE_WORKSPACE_ID");
    state.sources.push({ id: meta.id, kind: "DOCUMENT", title: command.title, revision: command.revision,
      locator: command.locator, text: command.text, createdBy: meta.actorId, createdAt: meta.at });
  } else if (command.type === "SET_FIELD" || command.type === "SET_STEP_DRAFT_FIELD") {
    const fact = command.type === "SET_FIELD" ? state.facts.find(f => f.id === command.fieldId)
      : state.stepDrafts.flatMap(d => d.fields).find(f => f.id === command.fieldId);
    if (!fact) fail("UNKNOWN_WORKSPACE_FIELD");
    setFact(state, fact, command, meta);
  } else if (command.type === "START_STEP_DRAFT") {
    const draftId = `st_${meta.id}`;
    if (state.stepDrafts.some(d => d.id === draftId) || state.steps.some(s => s.id === draftId)) fail("DUPLICATE_WORKSPACE_ID");
    state.stepDrafts.push({ id: draftId, fields: stepKeys.map(key => ({ id: `${draftId}_${key}`, status: "EMPTY",
      value: null, rationale: null, owner: null, evidence: null, acceptedBy: null, acceptedAt: null })) });
  } else if (command.type === "SET_TARGET_RELEASE") {
    state.targetRelease = command.targetRelease;
  } else if (command.type === "START_REQUIREMENT_DRAFT") {
    if (![...state.steps, ...state.stepDrafts].some(s => s.id === command.asIsStepId)) fail("UNKNOWN_WORKSPACE_STEP");
    const draftId = `rq_${meta.id}`;
    state.requirementDrafts.push({ id: draftId, asIsStepId: command.asIsStepId, kind: command.kind,
      critical: command.critical, statement: { id: `${draftId}_statement`, status: "EMPTY", value: null,
        rationale: null, owner: null, evidence: null, acceptedBy: null, acceptedAt: null } });
  } else if (command.type === "SET_REQUIREMENT_DRAFT_STATEMENT") {
    const draft = state.requirementDrafts.find(d => d.id === command.requirementDraftId);
    if (!draft) fail("UNKNOWN_WORKSPACE_REQUIREMENT");
    setFact(state, draft.statement, command, meta);
  } else if (command.type === "ADD_STEP" || command.type === "UPDATE_STEP") {
    const prior = command.type === "UPDATE_STEP" ? state.steps.findIndex(s => s.id === command.stepId) : -1;
    if (command.type === "UPDATE_STEP" && prior < 0) fail("UNKNOWN_WORKSPACE_STEP");
    if (command.type === "ADD_STEP" && state.steps.some(s => s.id === meta.id)) fail("DUPLICATE_WORKSPACE_ID");
    const step = { id: command.type === "ADD_STEP" ? meta.id : command.stepId, ...command.step,
      evidence: sourceForEntry(state, meta, command.step.description, "Current process step") };
    if (prior >= 0) state.steps[prior] = step;
    else state.steps.push(step);
  } else if (command.type === "ADD_REQUIREMENT" || command.type === "UPDATE_REQUIREMENT") {
    if (![...state.steps, ...state.stepDrafts].some(s => s.id === command.requirement.asIsStepId)) fail("UNKNOWN_WORKSPACE_STEP");
    const prior = command.type === "UPDATE_REQUIREMENT" ? state.requirements.findIndex(r => r.id === command.requirementId) : -1;
    if (command.type === "UPDATE_REQUIREMENT" && prior < 0) fail("UNKNOWN_WORKSPACE_REQUIREMENT");
    if (command.type === "ADD_REQUIREMENT" && state.requirements.some(r => r.id === meta.id)) fail("DUPLICATE_WORKSPACE_ID");
    const requirement = { id: command.type === "ADD_REQUIREMENT" ? meta.id : command.requirementId,
      ...command.requirement, evidence: sourceForEntry(state, meta, command.requirement.statement, "Requirement or pain point") };
    if (prior >= 0) state.requirements[prior] = requirement;
    else state.requirements.push(requirement);
  } else if (command.type === "DECIDE_PROPOSAL") {
    const proposal = state.proposals.find(p => p.id === command.proposalId);
    if (!proposal || proposal.status !== "PENDING") fail("PROPOSAL_NOT_PENDING");
    if (command.decision === "ACCEPT") { if (!acceptProposal(state, proposal, meta)) fail("STALE_PROPOSAL"); }
    else { proposal.status = "REJECTED"; proposal.decidedBy = meta.actorId; }
  } else if (command.type === "DECIDE_PROPOSALS") {
    if (!unique(command.ids)) fail("INVALID_WORKSPACE_COMMAND");
    const chosen = state.proposals.filter(p => command.ids.includes(p.id));
    if (chosen.length !== command.ids.length || chosen.some(p => p.status !== "PENDING")) fail("PROPOSAL_NOT_PENDING");
    // Stored order: a requirement proposed against a new step comes after that step. A proposal that went stale stays
    // PENDING and visible for the person to reject or redo; the batch only fails when nothing at all could be applied.
    let decided = 0;
    for (const proposal of chosen) {
      if (command.decision === "REJECT") { proposal.status = "REJECTED"; proposal.decidedBy = meta.actorId; decided++; }
      else if (acceptProposal(state, proposal, meta)) decided++;
    }
    if (!decided) fail("STALE_PROPOSAL");
  } else if (command.type === "REVIEW_OBSERVATION") {
    const observation = state.observations.find(o => o.id === command.observationId);
    if (!observation || observation.status !== "PENDING") fail("OBSERVATION_NOT_PENDING");
    observation.status = command.decision === "DISMISS" ? "DISMISSED" : "RESOLVED";
    observation.rationale = command.rationale;
    observation.reviewedBy = meta.actorId;
  }
  state.revision++;
  // New user content may contradict a confirmed interpretation; require a new review.
  const onlyRejects = (command.type === "DECIDE_PROPOSAL" || command.type === "DECIDE_PROPOSALS") && command.decision === "REJECT";
  if (!onlyRejects) state.confirmation = null;
  return checked(state);
}

/** Whether a participant's message asks for the To-Be (or the future design). A bare "to be" is not enough: "needs to be done". */
const TO_BE_REQUEST = [
  /\bto-be\b/i, /\bto be (?:design|process|state|draft|model|document|version|solution|proposal|blueprint)\b/i,
  /\b(?:future|target) (?:state|process|design)\b/i,
  /\b(?:draft|generate|create|produce|show|give|build|prepare|write)\s+(?:me\s+)?(?:the|a|an|my|our)?\s*to be\b/i,
  /\b(?:draft|generate|create|produce|build|prepare)\s+(?:me\s+)?(?:the|a|an|my|our)?\s*(?:\w+\s+)?design\b/i,
];
export const asksForToBe = (text: string) => TO_BE_REQUEST.some(pattern => pattern.test(text));

/** What the consultant says, from the same readiness rules as the Summary tab, when asked for the To-Be. One paragraph. */
function toBeNote(state: WorkspaceState): string {
  const { ready, draftReady, blockers } = getWorkspaceReadiness(state);
  if (ready) return "The As-Is is complete. A project lead or consultant can confirm it on the Summary tab and then generate the To-Be design.";
  if (draftReady) {
    const steps = blockers.filter(b => b.code === "AS_IS_STEP_INCOMPLETE").length;
    const points = state.observations.filter(o => o.status === "PENDING").length;
    const parts = [steps && `${steps} unfinished step${steps === 1 ? "" : "s"}`, points && `${points} point${points === 1 ? "" : "s"} to check`].filter(Boolean).join(" and ");
    return `A draft To-Be can be generated now: on the Summary tab, a project lead or consultant can use "Confirm as draft with gaps". ${parts} will be carried into the To-Be as ${steps + points === 1 ? "an open question" : "open questions"} to confirm.`;
  }
  const hard = blockers.filter(b => !b.soft);
  const softCount = blockers.length - hard.length;
  const listed = hard.slice(0, 3).map(b => describeBlocker(state, b).replace(/\.$/, "")).join("; ");
  const more = hard.length > 3 ? `; and ${hard.length - 3} more required item${hard.length - 3 === 1 ? "" : "s"}` : "";
  const open = softCount ? ` ${softCount} other gap${softCount === 1 ? "" : "s"} (unfinished steps, points to check) can stay open in a draft.` : "";
  return `Before a To-Be can be drafted: ${listed}${more}.${open} These are listed on the Summary tab.`;
}

/** Persist only a validated model turn. It cannot change an accepted fact. */
/** Persist a validated model turn. It cannot change an accepted fact. `scope` selects what is recorded: "chat" the assistant's
 * reply and questions, "extraction" the proposals and observations found in `currentMessageId` (no reply), "full" both. */
export function recordInterviewTurn(rawState: WorkspaceState, rawTurn: unknown, currentMessageId: string, meta: WorkspaceMeta,
  scope: Scope = "full"): WorkspaceState {
  checkMeta(meta);
  const state = structuredClone(checked(rawState));
  const input = buildInterviewInput(state, currentMessageId);
  const validated = revalidateStoredTurn(input, rawTurn, scope);
  if (!validated.success) fail("INVALID_INTERVIEW_TURN");
  const turn: InterviewTurn = validated.data;
  if (scope !== "chat" && state.extractedMessageIds?.includes(currentMessageId)) fail("ALREADY_EXTRACTED");
  if (state.messages.some(m => m.id === meta.id)) fail("DUPLICATE_WORKSPACE_ID");
  if (scope !== "extraction") {
    const reply = [turn.reply, ...turn.questions.map(q => `${q.question} ${q.whyItMatters}`)].join("\n\n");
    const asked = state.messages.find(m => m.id === currentMessageId && m.role === "user");
    const note = !asked || !asksForToBe(asked.text) ? undefined : toBeNote(state);
    state.messages.push({ id: meta.id, role: "assistant", text: reply, createdBy: null, createdAt: meta.at, ...(note ? { note } : {}) });
  }
  const userTurn = state.messages.filter(m => m.role === "user").length;
  if (scope !== "chat") state.extractedMessageIds = [...(state.extractedMessageIds ?? []), currentMessageId];
  // One question may cover several field gaps of one step: each covered gap is recorded as asked (so none is offered again).
  for (const { gapKeys, ...question } of turn.questions) for (const gapKey of [question.gapKey, ...(gapKeys ?? [])]) {
    state.questions.push({ ...question, gapKey, fieldId: input.activeGaps.find(g => g.key === gapKey)!.fieldId,
      askedAtRevision: state.revision, askedAtUserTurn: userTurn });
  }
  const proposalId = (index: number) => `p_${meta.id}_${index}`;
  const base = { status: "PENDING" as const, createdAt: meta.at, decidedBy: null };
  const fieldCount = turn.proposedUpdates.length;
  turn.proposedUpdates.forEach((proposal, index) => state.proposals.push({ id: proposalId(index), ...proposal, ...base }));
  turn.proposedSteps.forEach((step, index) => state.proposals.push({ id: proposalId(fieldCount + index), fieldId: "step",
    operation: "PROPOSE_STEP", previousValue: null, value: step.value, sourceId: step.sourceId, quote: step.quote,
    nameHint: step.nameHint, ...base }));
  turn.proposedRequirements.forEach((item, index) => {
    // new_<n> names the n-th step proposed in this same turn: store the id that proposal received.
    const fresh = /^new_(\d+)$/.exec(item.stepRef);
    state.proposals.push({ id: proposalId(fieldCount + turn.proposedSteps.length + index), fieldId: "requirement",
      operation: "PROPOSE_REQUIREMENT", previousValue: null, value: item.value, sourceId: item.sourceId, quote: item.quote,
      stepRef: fresh ? proposalId(fieldCount + Number(fresh[1])) : item.stepRef, kind: item.kind, critical: item.critical, ...base });
  });
  turn.observations.forEach((observation, index) => state.observations.push({
    id: `o_${meta.id}_${index}`, ...observation, status: "PENDING", rationale: null, reviewedBy: null,
  }));
  state.revision++;
  return checked(state);
}

/** A chat turn is saved after the message's extraction may already have answered what it asked. A question whose gap is no
 * longer open is not asked; in its place goes the next still-open gap that this turn does not already ask (most urgent
 * first, in the order the interview offers them), worded from the catalog, so a saved turn never ends without a question
 * while a gap remains. Returns the turn to store: `rawTurn` itself when nothing changed. */
const FALLBACK_WHY = "Without this the current process cannot be described well enough to design the future one.";
export function settleChatTurn(rawState: WorkspaceState, currentMessageId: string, rawTurn: unknown): unknown {
  const questions = (rawTurn as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return rawTurn;
  const state = checked(rawState);
  const input = buildInterviewInput(state, currentMessageId);
  const open = new Map(input.activeGaps.map(gap => [gap.key, gap]));
  type Q = { gapKey: string; question: string; whyItMatters: string; gapKeys?: string[] };
  const isOpen = (q: Q) => open.has(q?.gapKey ?? "");
  const survivors = (questions as Q[]).filter(isOpen).map(q => q.gapKeys ? { ...q, gapKeys: q.gapKeys.filter(k => open.has(k)) } : q);
  const missing = questions.length - survivors.length;
  if (!missing) return rawTurn;
  const taken = new Set(survivors.flatMap(q => [q.gapKey, ...(q.gapKeys ?? [])]));
  const takenSteps = new Set(survivors.flatMap(q => { const id = open.get(q.gapKey)?.stepId; return id ? [id] : []; }));
  const heard = input.history.filter(item => item.role === "assistant").map(item => item.text.replace(/\s+/g, " ").trim().toLocaleLowerCase("en"));
  const filler: Q[] = [];
  for (const gap of input.activeGaps) {
    if (filler.length >= missing) break;
    if (taken.has(gap.key) || (gap.stepId && takenSteps.has(gap.stepId))) continue;
    const base = gap.key.startsWith(STEP_GAP_PREFIX) && gap.stepId
      ? `Could you walk me through ${stepLabel(state, gap.stepId)}: who does it, in which system, what starts it and what can go wrong?`
      : (gap.stepId ? describeField(state, gap.fieldId).question.replace(/this (?:current process )?step/, stepLabel(state, gap.stepId))
        : describeField(state, gap.fieldId).question);
    if (!base) continue;
    const question = gap.key.endsWith(REASK_SUFFIX) ? `Coming back to this one: ${base}` : base;
    if (heard.some(message => message.includes(question.replace(/\s+/g, " ").trim().toLocaleLowerCase("en")))) continue;
    filler.push({ gapKey: gap.key, question, whyItMatters: FALLBACK_WHY });
    taken.add(gap.key); if (gap.stepId) takenSteps.add(gap.stepId);
  }
  return { ...(rawTurn as object), questions: [...survivors, ...filler] };
}

const MAX_VISIBLE_DRAFTS = 12;
const MAX_SHOWN_GAPS = 15;
const RECENT_EVIDENCE_MESSAGES = 3;
const trimmed = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

export function buildInterviewInput(rawState: WorkspaceState, currentMessageId: string): InterviewInput {
  const state = checked(rawState);
  const message = state.messages.find(m => m.id === currentMessageId && m.role === "user");
  if (!message) fail("UNKNOWN_CURRENT_MESSAGE");
  const askedAt = new Map(state.questions.map(q => [q.gapKey, q.askedAtUserTurn ?? 0]));
  const userTurns = state.messages.filter(m => m.role === "user").length;
  const pending = state.proposals.filter(p => p.status === "PENDING");
  const covered = new Set(pending.map(p => p.fieldId));
  // The key to offer for a gap: its own key until asked, then the single `_r2` re-ask once enough user turns passed.
  const offer = (base: string): string | null => {
    const first = askedAt.get(base);
    if (first === undefined) return base;
    const again = `${base}${REASK_SUFFIX}`;
    return !askedAt.has(again) && userTurns - first >= REASK_AFTER_USER_TURNS ? again : null;
  };
  const wire = (status: string) => (status === "OWNER_PENDING" ? "UNKNOWN" : status) as "EMPTY" | "KNOWN" | "UNKNOWN" | "NOT_APPLICABLE";
  const incompleteDrafts = state.stepDrafts.filter(d => !draftComplete(d));
  const visibleRequirements = state.requirementDrafts.filter(d => d.statement.status !== "KNOWN").slice(0, 8);
  const stepRef = (draft: (typeof state.stepDrafts)[number]) => {
    const name = draftFact(draft, "name").value, description = draftFact(draft, "description").value;
    return name ? `"${trimmed(name, 80)}"` : description ? `that begins: "${trimmed(description, 120)}"` : "that has no description yet";
  };
  const catalogGaps = (tier: number): InterviewInput["activeGaps"] => WORKSPACE_FIELDS.filter(def => def.tier === tier).flatMap(def => {
    const key = state.facts.find(f => f.id === def.id)!.status === "EMPTY" && !covered.has(def.id) ? offer(`g_${def.id}`) : null;
    return key ? [{ key, fieldId: def.id, priority: def.priority as "CRITICAL" | "IMPORTANT",
      detail: `${def.question} This is about ${def.domain === "AS_IS" ? "current practice" : def.domain === "DESIRED" ? "the desired future" : "business context"}.` }] : [];
  });
  const walkthroughGaps: InterviewInput["activeGaps"] = [];
  const stepFieldGaps: InterviewInput["activeGaps"] = [];
  for (const draft of incompleteDrafts) {
    const walkthroughKey = `${STEP_GAP_PREFIX}${draft.id}`;
    const walkedAt = askedAt.get(walkthroughKey);
    const untouched = CORE_STEP_KEYS.filter(key => key !== "description").every(key => draftFact(draft, key).status === "EMPTY");
    const key = walkedAt === undefined ? walkthroughKey : untouched ? offer(walkthroughKey) : null;
    if (key && !draft.fields.some(f => covered.has(f.id))) walkthroughGaps.push({ key, fieldId: `${draft.id}_name`, priority: "CRITICAL", stepId: draft.id,
      detail: `Walkthrough of the current step ${stepRef(draft)}. Ask ONE open question that has the participant walk you through this step: who does it, in which system, what triggers it, what goes in and out, which checks apply and what can go wrong. Then propose updates for every field of this step that the answer supports.` });
    // Single fields are asked only after the walkthrough was asked and at least one answer has come in since.
    if (walkedAt === undefined || userTurns < walkedAt + 2) continue;
    for (const fact of draft.fields) {
      const fieldKey = fact.status === "EMPTY" && !covered.has(fact.id) ? offer(`g_${fact.id}`) : null;
      const part = fact.id.slice(draft.id.length + 1) as (typeof stepKeys)[number];
      if (fieldKey) stepFieldGaps.push({ key: fieldKey, fieldId: fact.id, stepId: draft.id,
        detail: `${stepQuestions[part]} This is current practice for the step ${stepRef(draft)}.`,
        priority: (CORE_STEP_KEYS as readonly string[]).includes(part) ? "CRITICAL" : "IMPORTANT" });
    }
  }
  const requirementGaps = visibleRequirements.flatMap(d => {
    const key = d.statement.status === "EMPTY" && !covered.has(d.statement.id) ? offer(`g_${d.statement.id}`) : null;
    return key ? [{ key, fieldId: d.statement.id, stepId: d.asIsStepId, priority: d.critical ? "CRITICAL" as const : "IMPORTANT" as const,
      detail: d.kind === "PAIN_POINT" ? "What fails or causes delay in this current step, and what is the business impact?" :
        "What should change in this future process, and what outcome would show it works?" }] : [];
  });
  // Critical business context first, then landscape, then the process itself, then KPIs, targets and constraints.
  // Only the head of the list is shown: the model asks from the top, and a long list only dilutes its attention.
  const headGaps = [...catalogGaps(0), ...catalogGaps(1), ...walkthroughGaps, ...stepFieldGaps, ...requirementGaps,
    ...catalogGaps(2), ...catalogGaps(3)].slice(0, MAX_SHOWN_GAPS);
  // Drafts the model can act on: those named by a shown gap, then those whose walkthrough was already asked (any later
  // message may fill their blanks), then the rest. Their EMPTY fields (and name and description for context) are listed.
  const recentlyAsked = new Set(incompleteDrafts.filter(d => askedAt.has(`${STEP_GAP_PREFIX}${d.id}`)).map(d => d.id));
  const shown = new Set(headGaps.flatMap(g => g.stepId ? [g.stepId] : []));
  // Every incomplete step is listed up to the cap (stable sort, so gap order holds within a rank): extraction can only fill
  // fields it can see, and a step whose walkthrough gap fell below the shown head of the gap list must still have its blanks filled.
  const rank = (d: { id: string }) => shown.has(d.id) ? 0 : recentlyAsked.has(d.id) ? 1 : 2;
  const visibleDrafts = [...incompleteDrafts].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_VISIBLE_DRAFTS);
  // A gap is offered only when its field is listed: more shown steps than the cap lose their gaps (they come back as others complete).
  const unlisted = new Set(incompleteDrafts.filter(d => !visibleDrafts.includes(d)).map(d => d.id));
  const activeGaps = headGaps.filter(g => !g.stepId || !unlisted.has(g.stepId));
  const fields = [...WORKSPACE_FIELDS.map(def => {
    const fact = state.facts.find(f => f.id === def.id)!;
    return { id: def.id, label: `${def.domain}: ${def.label}`, value: fact.value, status: wire(fact.status), ...(covered.has(def.id) ? { pending: true } : {}) };
  }), ...visibleDrafts.flatMap(draft => draft.fields.filter(fact => fact.status === "EMPTY" || /_(name|description)$/.test(fact.id)).map(fact => ({ id: fact.id,
    label: `AS_IS step ${draft.id}${draftFact(draft, "name").value ? ` (${trimmed(draftFact(draft, "name").value!, 60)})` : ""}: ${fact.id.slice(draft.id.length + 1)}`,
    value: fact.value, status: wire(fact.status), ...(covered.has(fact.id) ? { pending: true } : {}) }))),
  ...visibleRequirements.map(draft => ({ id: draft.statement.id, label: `${draft.kind}: desired requirement or pain point for step ${draft.asIsStepId}`,
    value: draft.statement.value, status: wire(draft.statement.status) }))];
  const closedGapKeys = WORKSPACE_FIELDS.map(def => `g_${def.id}`).filter(key => !activeGaps.some(g => g.key === key));
  const currentSteps = [...state.steps.map(step => ({ id: step.id, name: step.name, summary: trimmed(step.description, 160), status: "CURRENT" as const })),
    ...state.stepDrafts.map(draft => ({ id: draft.id, name: draftFact(draft, "name").value && trimmed(draftFact(draft, "name").value!, 200),
      summary: draftFact(draft, "description").value && trimmed(draftFact(draft, "description").value!, 160), status: "CURRENT" as const })),
    ...pending.filter(p => p.operation === "PROPOSE_STEP").map(p => ({ id: p.id, name: p.nameHint ? trimmed(p.nameHint, 200) : null,
      summary: trimmed(p.value, 160), status: "PROPOSED" as const }))].slice(0, 60);
  const knownRequirements = [...state.requirements.map(r => ({ stepId: r.asIsStepId, kind: r.kind, statement: trimmed(r.statement, 200), status: "CURRENT" as const })),
    ...state.requirementDrafts.filter(d => d.statement.value).map(d => ({ stepId: d.asIsStepId, kind: d.kind, statement: trimmed(d.statement.value!, 200), status: "CURRENT" as const })),
    ...pending.filter(p => p.operation === "PROPOSE_REQUIREMENT").map(p => ({ stepId: p.stepRef!, kind: p.kind!, statement: trimmed(p.value, 200), status: "PROPOSED" as const }))].slice(-80);
  const evidenceSources: typeof state.sources = [];
  let evidenceBytes = 0;
  // Documents and entries stay quotable; of the conversation only the last few user messages do. Older answers live in the
  // field values, and re-sending every message made the input grow past what the model could use.
  const recentMessageIds = new Set(state.messages.filter(m => m.role === "user" && m.id !== currentMessageId).slice(-RECENT_EVIDENCE_MESSAGES).map(m => m.id));
  for (const source of state.sources.filter(s => s.id !== currentMessageId && (s.kind !== "MESSAGE" || recentMessageIds.has(s.id))).slice().reverse()) {
    const bytes = Buffer.byteLength(source.text, "utf8");
    if (evidenceSources.length < 50 && evidenceBytes + bytes <= 120_000) {
      evidenceSources.unshift(source); evidenceBytes += bytes;
    }
  }
  const history: { role: "user" | "assistant"; text: string }[] = [];
  let historyBytes = 0;
  for (const message of state.messages.filter(m => m.id !== currentMessageId).slice().reverse()) {
    // A user message is already in evidence when recent; elsewhere only its opening gives the conversation its thread.
    const content = message.text.slice(0, message.role === "user" ? 300 : 8000);
    const bytes = Buffer.byteLength(content, "utf8");
    if (history.length < 24 && historyBytes + bytes <= 40_000) {
      history.unshift({ role: message.role, text: content }); historyBytes += bytes;
    }
  }
  const extracted = new Set(state.extractedMessageIds ?? []);
  const unextractedMessageIds = state.messages.filter(m => m.role === "user" && recentMessageIds.has(m.id) && !extracted.has(m.id)).map(m => m.id);
  return parseInterviewInput({ schemaVersion: 1, contextRevision: state.revision, variantName: state.variantName,
    problemStatement: state.problemStatement, currentMessage: { id: message.id, text: message.text },
    evidence: evidenceSources.map(s => ({ id: s.id, text: s.text })), fields, activeGaps, closedGapKeys, steps: currentSteps,
    requirements: knownRequirements, unextractedMessageIds, history });
}

/** Facts, then steps, then observations (callers pass them in that order). Over the schema limit, keep as many as fit and point at the Summary tab for the rest. */
function capOpenQuestions(questions: DiscoveryInput["openQuestions"]): DiscoveryInput["openQuestions"] {
  if (questions.length <= MAX_OPEN_QUESTIONS) return questions;
  const kept = questions.slice(0, MAX_OPEN_QUESTIONS - 1);
  return [...kept, { id: "q_more_open_points", owner: "Process owner",
    question: `${questions.length - kept.length} further open points are listed on the Summary tab of the discovery workspace.` }];
}

/** Compile reviewed user facts only. This artifact remains USER_PROVIDED/DRAFT
 * in the discovery repository; confirmation does not verify SAP capability. */
export function compileDiscovery(rawState: WorkspaceState, options: { allowGaps?: boolean } = {}): DiscoveryInput {
  const state = checked(rawState);
  const gapQuestions: DiscoveryInput["openQuestions"] = [];
  /** With `allowGaps`, a pending model observation is not dismissed: it travels as an open question for the process owner. */
  const observationQuestions: DiscoveryInput["openQuestions"] = options.allowGaps
    ? state.observations.filter(o => o.status === "PENDING").map(o => ({ id: `q_obs_${o.id}`.slice(0, 64), question: o.detail, owner: "Process owner" }))
    : [];
  /** A step as the To-Be sees it. With `allowGaps` a missing detail becomes TO_CONFIRM plus an open question, never an invented value. */
  const compileDraft = (draft: StepDraft) => {
    const missing = missingKeys(draft);
    if (missing.length && !(options.allowGaps && draftCompilable(draft))) fail("AS_IS_STEP_INCOMPLETE");
    const known = (key: (typeof stepKeys)[number]) => { const f = draftFact(draft, key); return f.status === "KNOWN" ? f.value! : null; };
    const list = (key: (typeof LIST_STEP_KEYS)[number]) => (known(key) ?? "").split("\n").map(s => s.trim()).filter(Boolean);
    const name = known("name");
    // One question per incomplete step, not per missing detail: 70+ near-identical questions are noise and overflow the cap.
    if (missing.length) {
      const details = missing.map(key => STEP_LABELS[key].toLowerCase()).join(", ");
      gapQuestions.push({ id: `q_${draft.id}`.slice(0, 64), question: `${name ?? "Unnamed step"}: confirm ${details}.`.slice(0, 8000), owner: "Process owner" });
    }
    return { id: draft.id, name: name ?? TO_CONFIRM, actor: known("actor") ?? TO_CONFIRM, system: known("system") ?? TO_CONFIRM,
      trigger: known("trigger") ?? TO_CONFIRM, description: known("description") ?? TO_CONFIRM,
      inputs: list("inputs"), outputs: list("outputs"), controls: list("controls"), exceptions: list("exceptions"),
      evidence: draftEvidence(draft)! };
  };
  const input: DiscoveryInput = {
    schemaVersion: 1, variantName: state.variantName, targetRelease: state.targetRelease,
    sources: state.sources.map(s => ({ id: s.id, title: s.title, revision: s.revision, locator: s.locator, text: s.text })),
    asIsSteps: [...state.steps, ...state.stepDrafts.map(compileDraft)].map((step, index) => ({ ...step, sequence: index + 1 })),
    requirements: [...state.requirements, ...state.requirementDrafts.map(draft => {
      if (draft.statement.status !== "KNOWN") fail("REQUIREMENT_INCOMPLETE");
      return { id: draft.id, asIsStepId: draft.asIsStepId, kind: draft.kind, critical: draft.critical,
        statement: draft.statement.value!, evidence: draft.statement.evidence! };
    })],
    conflicts: [],
    companyContext: state.facts.flatMap(f => f.status === "KNOWN" ? [{ fieldId: f.id as CompanyContext[number]["fieldId"], label: WORKSPACE_FIELDS.find(def => def.id === f.id)!.label,
      value: f.value!, evidence: f.evidence! }] : []),
    openQuestions: capOpenQuestions([...state.facts.filter(f => ["UNKNOWN", "OWNER_PENDING"].includes(f.status)).map(f => ({
      id: `q_${f.id}`, question: WORKSPACE_FIELDS.find(def => def.id === f.id)!.question,
      owner: f.owner ?? "Process owner",
    })), ...gapQuestions, ...observationQuestions]),
  };
  return validateDiscovery(input);
}
