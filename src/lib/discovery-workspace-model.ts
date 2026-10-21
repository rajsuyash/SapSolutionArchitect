import { z } from "zod";
import { validateDiscovery, type DiscoveryInput } from "./discovery";
import { STEP_KEYS as stepKeys, STEP_QUESTIONS as stepQuestions, WORKSPACE_FIELDS } from "./workspace-fields";
import { parseInterviewInput, validateInterviewTurn, type InterviewInput, type InterviewTurn } from "./ai/discovery-interview";

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
const ProposalSchema = z.strictObject({
  id, fieldId: id, operation: z.enum(["PROPOSE_SET", "PROPOSE_REPLACE"]),
  previousValue: text().nullable(), value: text(), sourceId: id, quote: text(),
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED"]), createdAt: z.iso.datetime(), decidedBy: id.nullable(),
});
const MessageSchema = z.strictObject({ id, role: z.enum(["user", "assistant"]), text: text(20000),
  createdBy: id.nullable(), createdAt: z.iso.datetime() });
const QuestionSchema = z.strictObject({ gapKey: id, fieldId: id, question: text(500), whyItMatters: text(500),
  askedAtRevision: z.number().int().positive() });
const ObservationSchema = z.strictObject({ id, kind: z.enum(["POSSIBLE_CONFLICT", "FOLLOW_UP_SUGGESTION"]),
  fieldIds: z.array(id).min(1).max(10), detail: text(1000), status: z.enum(["PENDING", "DISMISSED", "RESOLVED"]),
  rationale: text(1000).nullable(), reviewedBy: id.nullable() });
const ConfirmationSchema = z.strictObject({ revision: z.number().int().positive(), by: id, at: z.iso.datetime() });

export const WorkspaceStateSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: z.number().int().positive().max(2147483647),
  variantCode: z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/), variantName: label,
  targetProduct, targetRelease: label.nullable(), problemStatement: text(8000),
  sources: z.array(SourceSchema).max(200), messages: z.array(MessageSchema).max(500),
  facts: z.array(FactSchema).max(100), steps: z.array(StepSchema).max(200), stepDrafts: z.array(StepDraftSchema).max(200),
  requirements: z.array(RequirementSchema).max(200), requirementDrafts: z.array(RequirementDraftSchema).max(200),
  proposals: z.array(ProposalSchema).max(500),
  questions: z.array(QuestionSchema).max(500), observations: z.array(ObservationSchema).max(500),
  confirmation: ConfirmationSchema.nullable(),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type WorkspaceMeta = { actorId: string; at: string; id: string };
export const WorkspaceCreateSchema = z.strictObject({
  variantCode: z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/), variantName: label,
  targetProduct, targetRelease: label.nullable(), problemStatement: text(8000),
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
  z.strictObject({ type: z.literal("REVIEW_OBSERVATION"), observationId: id,
    decision: z.enum(["DISMISS", "RESOLVE"]), rationale: text(1000) }),
  z.strictObject({ type: z.literal("CONFIRM") }),
]);
export type WorkspaceCommand = z.infer<typeof WorkspaceCommandSchema>;

function fail(code: string): never { throw new Error(code); }
function unique(values: string[]) { return new Set(values).size === values.length; }
function checkMeta(meta: WorkspaceMeta) {
  if (!id.safeParse(meta.actorId).success || !id.safeParse(meta.id).success || !z.iso.datetime().safeParse(meta.at).success) fail("INVALID_WORKSPACE_META");
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
    state.sources.some(s => Buffer.byteLength(s.text, "utf8") > 40000)) fail("INVALID_WORKSPACE_STATE");
  const sources = new Map(state.sources.map(source => [source.id, source.text]));
  const validEvidence = (ref: { sourceId: string; quote: string } | null) => !ref || !!sources.get(ref.sourceId)?.includes(ref.quote);
  if ([...state.facts, ...state.stepDrafts.flatMap(d => d.fields), ...state.requirementDrafts.map(d => d.statement)].some(f => !validEvidence(f.evidence) ||
    (f.status === "KNOWN" && !f.evidence) || (f.status === "KNOWN") !== (f.value !== null) ||
    (f.status === "NOT_APPLICABLE" && !f.rationale) || (f.status === "OWNER_PENDING" && !f.owner)) ||
    state.steps.some(s => !validEvidence(s.evidence)) || state.requirements.some(r => !validEvidence(r.evidence)) ||
    state.proposals.some(p => !sources.get(p.sourceId)?.includes(p.quote) || p.value !== p.quote)) fail("INVALID_WORKSPACE_EVIDENCE");
  return state;
}

export function createWorkspace(rawInput: z.infer<typeof WorkspaceCreateSchema>, meta: WorkspaceMeta): WorkspaceState {
  checkMeta(meta);
  const parsed = WorkspaceCreateSchema.safeParse(rawInput);
  if (!parsed.success) fail("INVALID_WORKSPACE_CREATE");
  const input = parsed.data;
  const sourceId = `s_${meta.id}`;
  const source: WorkspaceState["sources"][number] = { id: sourceId, kind: "USER_ENTRY", title: "Initial problem",
    revision: "1", locator: "Initial problem", text: input.problemStatement, createdBy: meta.actorId, createdAt: meta.at };
  const facts = WORKSPACE_FIELDS.map(field => field.id === "business_problem"
    ? { id: field.id, status: "KNOWN" as const, value: input.problemStatement, rationale: null, owner: null,
      evidence: { sourceId, quote: input.problemStatement }, acceptedBy: meta.actorId, acceptedAt: meta.at }
    : { id: field.id, status: "EMPTY" as const, value: null, rationale: null, owner: null,
      evidence: null, acceptedBy: null, acceptedAt: null });
  return checked({ schemaVersion: 1, revision: 1, ...input, sources: [source], messages: [], facts,
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
function draftComplete(draft: WorkspaceState["stepDrafts"][number]) {
  const fields = new Map(draft.fields.map(f => [f.id.slice(draft.id.length + 1), f]));
  return ["name", "actor", "system", "trigger", "description"].every(key => fields.get(key)?.status === "KNOWN") &&
    ["inputs", "outputs", "controls", "exceptions"].every(key => ["KNOWN", "NOT_APPLICABLE"].includes(fields.get(key)?.status ?? "EMPTY"));
}

export function getWorkspaceReadiness(raw: WorkspaceState) {
  const state = checked(raw);
  const blockers: { code: string; fieldId?: string; detail: string }[] = [];
  for (const field of WORKSPACE_FIELDS) {
    const fact = state.facts.find(item => item.id === field.id)!;
    if (fact.status === "EMPTY") blockers.push({ code: "FIELD_UNANSWERED", fieldId: field.id, detail: field.label });
    else if (field.priority === "CRITICAL" && fact.status !== "KNOWN") {
      blockers.push({ code: "CRITICAL_FIELD_UNRESOLVED", fieldId: field.id, detail: field.label });
    }
  }
  if (!state.steps.length && !state.stepDrafts.length) blockers.push({ code: "AS_IS_STEP_MISSING", detail: "Describe at least one current step" });
  state.stepDrafts.forEach(draft => {
    if (!draftComplete(draft)) blockers.push({ code: "AS_IS_STEP_INCOMPLETE", detail: `Complete current step ${draft.id}` });
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
  if (state.observations.some(o => o.status === "PENDING")) blockers.push({ code: "OBSERVATIONS_PENDING", detail: "Review possible contradictions" });
  return { ready: blockers.length === 0, blockers };
}

export function applyWorkspaceCommand(rawState: WorkspaceState, rawCommand: unknown, meta: WorkspaceMeta): WorkspaceState {
  checkMeta(meta);
  const state = structuredClone(checked(rawState));
  const parsed = WorkspaceCommandSchema.safeParse(rawCommand);
  if (!parsed.success) fail("INVALID_WORKSPACE_COMMAND");
  const command = parsed.data;
  if (command.type === "CONFIRM") {
    if (!getWorkspaceReadiness(state).ready) fail("WORKSPACE_NOT_READY");
    compileDiscovery(state);
    state.revision++;
    state.confirmation = { revision: state.revision, by: meta.actorId, at: meta.at };
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
    proposal.status = command.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED";
    proposal.decidedBy = meta.actorId;
    if (command.decision === "ACCEPT") {
      const fact = findFact(state, proposal.fieldId);
      if (!fact || fact.value !== proposal.previousValue ||
        (proposal.operation === "PROPOSE_SET" ? fact.status !== "EMPTY" : fact.status !== "KNOWN")) fail("STALE_PROPOSAL");
      fact.status = "KNOWN"; fact.value = proposal.value; fact.evidence = { sourceId: proposal.sourceId, quote: proposal.quote };
      fact.rationale = null; fact.owner = null; fact.acceptedBy = meta.actorId; fact.acceptedAt = meta.at;
    }
  } else if (command.type === "REVIEW_OBSERVATION") {
    const observation = state.observations.find(o => o.id === command.observationId);
    if (!observation || observation.status !== "PENDING") fail("OBSERVATION_NOT_PENDING");
    observation.status = command.decision === "DISMISS" ? "DISMISSED" : "RESOLVED";
    observation.rationale = command.rationale;
    observation.reviewedBy = meta.actorId;
  }
  state.revision++;
  // New user content may contradict a confirmed interpretation; require a new review.
  if (command.type !== "DECIDE_PROPOSAL" || command.decision === "ACCEPT") state.confirmation = null;
  return checked(state);
}

/** Persist only a validated model turn. It cannot change an accepted fact. */
export function recordInterviewTurn(rawState: WorkspaceState, rawTurn: unknown, currentMessageId: string, meta: WorkspaceMeta): WorkspaceState {
  checkMeta(meta);
  const state = structuredClone(checked(rawState));
  const input = buildInterviewInput(state, currentMessageId);
  const validated = validateInterviewTurn(input, rawTurn);
  if (!validated.success) fail("INVALID_INTERVIEW_TURN");
  const turn: InterviewTurn = validated.data;
  if (state.messages.some(m => m.id === meta.id)) fail("DUPLICATE_WORKSPACE_ID");
  const reply = [turn.reply, ...turn.questions.map(q => `${q.question} ${q.whyItMatters}`)].join("\n\n");
  state.messages.push({ id: meta.id, role: "assistant", text: reply, createdBy: null, createdAt: meta.at });
  for (const question of turn.questions) state.questions.push({ ...question,
    fieldId: input.activeGaps.find(g => g.key === question.gapKey)!.fieldId, askedAtRevision: state.revision });
  turn.proposedUpdates.forEach((proposal, index) => state.proposals.push({
    id: `p_${meta.id}_${index}`, ...proposal, status: "PENDING", createdAt: meta.at, decidedBy: null,
  }));
  turn.observations.forEach((observation, index) => state.observations.push({
    id: `o_${meta.id}_${index}`, ...observation, status: "PENDING", rationale: null, reviewedBy: null,
  }));
  state.revision++;
  return checked(state);
}

export function buildInterviewInput(rawState: WorkspaceState, currentMessageId: string): InterviewInput {
  const state = checked(rawState);
  const message = state.messages.find(m => m.id === currentMessageId && m.role === "user");
  if (!message) fail("UNKNOWN_CURRENT_MESSAGE");
  const asked = new Set(state.questions.map(q => q.gapKey));
  // The interview contract caps fields at 100; present a moving window of
  // incomplete step drafts while retaining all drafts in durable state.
  const incompleteDrafts = state.stepDrafts.filter(d => !draftComplete(d));
  const remainingDraftSlots = Math.max(0, 10 - incompleteDrafts.length);
  const visibleDrafts = [...incompleteDrafts.slice(0, 9),
    ...(remainingDraftSlots > 1 ? state.stepDrafts.filter(d => draftComplete(d)).slice(-(remainingDraftSlots - 1)) : [])];
  const visibleRequirements = state.requirementDrafts.filter(d => d.statement.status !== "KNOWN").slice(0, 8);
  const fields = [...WORKSPACE_FIELDS.map(def => {
    const fact = state.facts.find(f => f.id === def.id)!;
    return { id: def.id, label: `${def.domain}: ${def.label}`, value: fact.value,
      status: fact.status === "OWNER_PENDING" ? "UNKNOWN" as const : fact.status };
  }), ...visibleDrafts.flatMap(draft => draft.fields.map(fact => ({ id: fact.id,
    label: `AS_IS step ${draft.id}: ${fact.id.slice(draft.id.length + 1)}`, value: fact.value,
    status: fact.status === "OWNER_PENDING" ? "UNKNOWN" as const : fact.status }))),
  ...visibleRequirements.map(draft => ({ id: draft.statement.id, label: `${draft.kind}: desired requirement or pain point for step ${draft.asIsStepId}`,
    value: draft.statement.value, status: draft.statement.status === "OWNER_PENDING" ? "UNKNOWN" as const : draft.statement.status }))];
  const catalogGaps = WORKSPACE_FIELDS.filter(def => {
    const fact = state.facts.find(f => f.id === def.id)!;
    return fact.status === "EMPTY" && !asked.has(`g_${def.id}`);
  }).map(def => ({ key: `g_${def.id}`, fieldId: def.id,
    detail: `${def.question} This is about ${def.domain === "AS_IS" ? "current practice" : def.domain === "DESIRED" ? "the desired future" : "business context"}.`,
    priority: def.priority }));
  const draftGaps = visibleDrafts.flatMap(draft => draft.fields.filter(fact =>
    fact.status === "EMPTY" && !asked.has(`g_${fact.id}`)).map(fact => {
    const key = fact.id.slice(draft.id.length + 1) as (typeof stepKeys)[number];
    return { key: `g_${fact.id}`, fieldId: fact.id, detail: `${stepQuestions[key]} This is current practice for step ${draft.id}.`,
      priority: (["name", "actor", "system", "trigger", "description"] as string[]).includes(key) ? "CRITICAL" as const : "IMPORTANT" as const };
  }));
  const requirementGaps = visibleRequirements.filter(d => d.statement.status === "EMPTY" &&
    !asked.has(`g_${d.statement.id}`)).map(d => ({ key: `g_${d.statement.id}`, fieldId: d.statement.id,
    detail: d.kind === "PAIN_POINT" ? "What fails or causes delay in this current step, and what is the business impact?" :
      "What should change in this future process, and what outcome would show it works?",
    priority: d.critical ? "CRITICAL" as const : "IMPORTANT" as const }));
  const activeGaps = [...catalogGaps, ...draftGaps, ...requirementGaps].slice(0, 100);
  const allGapKeys = [...WORKSPACE_FIELDS.map(def => `g_${def.id}`),
    ...visibleDrafts.flatMap(draft => draft.fields.map(fact => `g_${fact.id}`)),
    ...visibleRequirements.map(d => `g_${d.statement.id}`)];
  const closedGapKeys = allGapKeys.filter(key => !activeGaps.some(g => g.key === key)).slice(0, 200);
  const evidenceSources: typeof state.sources = [];
  let evidenceBytes = 0;
  for (const source of state.sources.filter(s => s.id !== currentMessageId).slice().reverse()) {
    const bytes = Buffer.byteLength(source.text, "utf8");
    if (evidenceSources.length < 50 && evidenceBytes + bytes <= 120_000) {
      evidenceSources.unshift(source); evidenceBytes += bytes;
    }
  }
  const history: { role: "user" | "assistant"; text: string }[] = [];
  let historyBytes = 0;
  for (const message of state.messages.filter(m => m.id !== currentMessageId).slice().reverse()) {
    const content = message.text.slice(0, 8000);
    const bytes = Buffer.byteLength(content, "utf8");
    if (history.length < 24 && historyBytes + bytes <= 40_000) {
      history.unshift({ role: message.role, text: content }); historyBytes += bytes;
    }
  }
  return parseInterviewInput({ schemaVersion: 1, contextRevision: state.revision, variantName: state.variantName,
    problemStatement: state.problemStatement, currentMessage: { id: message.id, text: message.text },
    evidence: evidenceSources.map(s => ({ id: s.id, text: s.text })), fields, activeGaps, closedGapKeys, history });
}

/** Compile reviewed user facts only. This artifact remains USER_PROVIDED/DRAFT
 * in the discovery repository; confirmation does not verify SAP capability. */
export function compileDiscovery(rawState: WorkspaceState): DiscoveryInput {
  const state = checked(rawState);
  const input: DiscoveryInput = {
    schemaVersion: 1, variantName: state.variantName, targetRelease: state.targetRelease,
    sources: state.sources.map(s => ({ id: s.id, title: s.title, revision: s.revision, locator: s.locator, text: s.text })),
    asIsSteps: [...state.steps, ...state.stepDrafts.map(draft => {
      if (!draftComplete(draft)) fail("AS_IS_STEP_INCOMPLETE");
      const field = (key: (typeof stepKeys)[number]) => draft.fields.find(f => f.id === `${draft.id}_${key}`)!;
      const list = (key: "inputs" | "outputs" | "controls" | "exceptions") =>
        field(key).status === "KNOWN" ? field(key).value!.split("\n").map(s => s.trim()).filter(Boolean) : [];
      return { id: draft.id, name: field("name").value!, actor: field("actor").value!,
        system: field("system").value!, trigger: field("trigger").value!, description: field("description").value!,
        inputs: list("inputs"), outputs: list("outputs"), controls: list("controls"), exceptions: list("exceptions"),
        evidence: field("description").evidence! };
    })].map((step, index) => ({ ...step, sequence: index + 1 })),
    requirements: [...state.requirements, ...state.requirementDrafts.map(draft => {
      if (draft.statement.status !== "KNOWN") fail("REQUIREMENT_INCOMPLETE");
      return { id: draft.id, asIsStepId: draft.asIsStepId, kind: draft.kind, critical: draft.critical,
        statement: draft.statement.value!, evidence: draft.statement.evidence! };
    })],
    conflicts: [],
    openQuestions: state.facts.filter(f => ["UNKNOWN", "OWNER_PENDING"].includes(f.status)).map(f => ({
      id: `q_${f.id}`, question: WORKSPACE_FIELDS.find(def => def.id === f.id)!.question,
      owner: f.owner ?? "Process owner",
    })),
  };
  return validateDiscovery(input);
}
