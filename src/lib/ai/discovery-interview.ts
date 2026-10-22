import { z } from "zod";
import { indexSentences, resolveSentenceIds, type Citation } from "./interview-sentences";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const content = (limit: number) => z.string().min(1).max(limit)
  .refine(value => !!value.trim() && !value.includes("\0"));
const fieldValue = content(8000);

/** This is an internal, server-assembled context. It is not an HTTP body and
 * must be loaded only after project authorization. Evidence remains verbatim. */
export const InterviewInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  contextRevision: z.number().int().positive().max(2147483647),
  variantName: content(200),
  problemStatement: content(20000),
  currentMessage: z.strictObject({ id: identifier, text: content(20000) }),
  evidence: z.array(z.strictObject({ id: identifier, text: content(40000) })).max(50),
  fields: z.array(z.strictObject({
    id: identifier, label: content(200), value: fieldValue.nullable(),
    status: z.enum(["EMPTY", "KNOWN", "UNKNOWN", "NOT_APPLICABLE"]),
  })).max(200),
  /** `stepId` ties a gap to one current step: a turn may ask at most one gap per step. */
  activeGaps: z.array(z.strictObject({
    key: identifier, fieldId: identifier, detail: content(1000),
    priority: z.enum(["CRITICAL", "IMPORTANT", "LATER"]), stepId: identifier.optional(),
  })).max(100),
  closedGapKeys: z.array(identifier).max(300),
  /** Current steps (and steps already proposed but not yet accepted) so the model neither re-proposes nor mis-references one. */
  steps: z.array(z.strictObject({ id: identifier, name: content(200).nullable(), summary: content(500).nullable(),
    status: z.enum(["CURRENT", "PROPOSED"]) })).max(60),
  /** Requirements and pain points already recorded or proposed, for the same reason. */
  requirements: z.array(z.strictObject({ stepId: identifier, kind: z.enum(["PAIN_POINT", "TO_BE_REQUIREMENT", "CONTROL"]),
    statement: content(500), status: z.enum(["CURRENT", "PROPOSED"]) })).max(80),
  history: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), text: content(8000) })).max(24),
});
export type InterviewInput = z.infer<typeof InterviewInputSchema>;

/** Most proposals of each kind one turn may carry; extra ones are dropped (see validateInterviewTurn), never an error. */
const MAX_PROPOSALS = 20;
const MAX_NEW_STEPS = 12;
const MAX_NEW_REQUIREMENTS = 16;
const requirementKind = z.enum(["PAIN_POINT", "TO_BE_REQUIREMENT", "CONTROL"]);
const REPLIES = ["Thank you for that context.", "Let's review what you've shared.", "We can take this one step at a time."] as const;
const observationShape = z.strictObject({
  kind: z.enum(["POSSIBLE_CONFLICT", "FOLLOW_UP_SUGGESTION"]),
  fieldIds: z.array(identifier).min(1).max(10), detail: content(1000),
});
/** The model cites 1 to 3 sentence IDs (`S7`) shown in the input; the server turns them into `sourceId` + exact `quote`.
 * Format is checked on resolution (unknown_sentence_id), not by the schema, so a malformed ID gets a precise repair message. */
const sentenceIds = z.array(z.string().min(1).max(16)).min(1).max(3);
/** What the server stores for one citation: the exact source substring. */
const storedCite = { sourceId: identifier, quote: content(8000) };
const updateBase = { fieldId: identifier, operation: z.enum(["PROPOSE_SET", "PROPOSE_REPLACE"]), previousValue: fieldValue.nullable() };
/** PROPOSE_STEP: a new current step. The cited sentences become its description; nameHint is a short label, kept only if
 * it is a phrase of the source and otherwise dropped with a warning. */
const stepBase = { nameHint: content(200).nullable().optional() };
/** PROPOSE_REQUIREMENT: `stepRef` is an existing step id or `new_<n>`, the n-th entry (from 0) of this turn's proposedSteps. */
const requirementBase = { stepRef: identifier, kind: requirementKind, critical: z.boolean() };

/** A validated turn as the server stores it. All changes are proposals. No output field conveys approval or readiness.
 * Questions and observations remain untrusted model text, not workflow commands. `value` is server-owned: it is always
 * the exact source substring stored in `quote`. */
export const InterviewTurnSchema = z.strictObject({
  schemaVersion: z.literal(1),
  contextRevision: z.number().int().positive().max(2147483647),
  // Keep acknowledgement separate from questions and application-owned status.
  reply: z.enum(REPLIES),
  questions: z.array(z.strictObject({
    gapKey: identifier, question: content(500), whyItMatters: content(500),
  })).max(3),
  proposedUpdates: z.array(z.strictObject({ ...updateBase, ...storedCite, value: fieldValue })).max(MAX_PROPOSALS),
  proposedSteps: z.array(z.strictObject({ ...storedCite, value: fieldValue, nameHint: content(200).nullable() })).max(MAX_NEW_STEPS),
  proposedRequirements: z.array(z.strictObject({ ...requirementBase, ...storedCite, value: fieldValue })).max(MAX_NEW_REQUIREMENTS),
  observations: z.array(observationShape).max(6),
});
/** The contract shown to the model as the tool schema: sentence IDs as evidence, no server-owned scalars and no `value`. */
export const InterviewTurnToolSchema = z.strictObject({
  reply: z.enum(REPLIES),
  questions: z.array(z.strictObject({ gapKey: identifier, question: content(500), whyItMatters: content(500) })).max(3),
  proposedUpdates: z.array(z.strictObject({ ...updateBase, sentenceIds })).max(MAX_PROPOSALS),
  proposedSteps: z.array(z.strictObject({ ...stepBase, sentenceIds })).max(MAX_NEW_STEPS),
  proposedRequirements: z.array(z.strictObject({ ...requirementBase, sentenceIds })).max(MAX_NEW_REQUIREMENTS),
  observations: z.array(observationShape).max(6),
});
/** What the validator accepts. Server-owned scalars and `value` may be present (and are then ignored); a reply outside
 * the allowed set or a question without usable whyItMatters is repaired or dropped with a warning. The evidence key
 * differs by who wrote the turn: a model cites `sentenceIds`; a turn the server already validated carries `sourceId` + `quote`. */
const rawTurn = <C extends z.ZodRawShape>(cite: C) => z.strictObject({
  schemaVersion: z.unknown().optional(), contextRevision: z.unknown().optional(), reply: z.unknown().optional(),
  questions: z.array(z.strictObject({ gapKey: identifier, question: content(500), whyItMatters: z.unknown().optional() })).max(3),
  proposedUpdates: z.array(z.strictObject({ ...updateBase, ...cite, value: z.unknown().optional() })).max(MAX_PROPOSALS),
  proposedSteps: z.array(z.strictObject({ ...stepBase, ...cite, value: z.unknown().optional() })).max(MAX_NEW_STEPS).default([]),
  proposedRequirements: z.array(z.strictObject({ ...requirementBase, ...cite, value: z.unknown().optional() })).max(MAX_NEW_REQUIREMENTS).default([]),
  observations: z.array(observationShape).max(6),
});
export const InterviewTurnRawSchema = rawTurn({ sentenceIds });
const StoredTurnRawSchema = rawTurn(storedCite);
export type InterviewTurn = z.infer<typeof InterviewTurnSchema>;
export type InterviewIssue = { path: string; code: string };
export type InterviewWarning = { path: string; code: string; detail?: string };

// Defense in depth for common identifiers/credential formats, not a complete
// secret detector. Authorized context assembly must exclude credential stores.
const sensitive = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\b(?:Bearer\s+\S+|Authorization\s*:\s*Basic\s+\S+|(?:password|api[_ -]?key|secret|token)\s*[:=]\s*\S+)/i;
/** The same screen the interview input applies, exposed so a message is refused when sent rather than wedging every later turn. */
export const containsSensitiveText = (text: string) => sensitive.test(text);
const duplicate = (values: string[]) => new Set(values).size !== values.length;
const questionKey = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en");

/** Throw only a fixed error code: client or source text must never leak in
 * validation errors, model repair instructions, metrics or logs. */
export function parseInterviewInput(raw: unknown): InterviewInput {
  const parsed = InterviewInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("INVALID_INTERVIEW_INPUT");
  const input = parsed.data;
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 256 * 1024 || sensitive.test(JSON.stringify(input))) {
    throw new Error("INVALID_INTERVIEW_INPUT");
  }
  const evidenceIds = input.evidence.map(item => item.id);
  const fieldIds = input.fields.map(item => item.id);
  const gapKeys = input.activeGaps.map(item => item.key);
  if (duplicate([...evidenceIds, input.currentMessage.id, ...fieldIds, ...gapKeys, ...input.closedGapKeys]) ||
    gapKeys.some(key => input.closedGapKeys.includes(key)) ||
    input.activeGaps.some(gap => !fieldIds.includes(gap.fieldId)) ||
    input.fields.some(field => field.status === "KNOWN" ? field.value === null : field.value !== null)) {
    throw new Error("INVALID_INTERVIEW_INPUT");
  }
  return input;
}

const usableWhy = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 500 && !value.includes("\0");

/** Repairs a model reply that is almost right, before strict parsing: a fourth question is cut, extra keys on a question
 * are removed, a missing previousValue means null, and an advisory observation or proposal that is malformed is dropped.
 * Each repair is a warning. Provenance (cited sentences, quotes, sources) is never repaired here. */
function tidy(raw: unknown, warnings: InterviewWarning[]): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (Array.isArray(out.questions)) {
    if (out.questions.length > 3) warnings.push({ path: "questions", code: "questions_truncated", detail: `dropped ${out.questions.length - 3}` });
    out.questions = out.questions.slice(0, 3).map(q => isObject(q) ? { gapKey: q.gapKey, question: q.question, whyItMatters: q.whyItMatters } : q);
  }
  if (Array.isArray(out.proposedUpdates)) {
    out.proposedUpdates = out.proposedUpdates.flatMap((u, index) => {
      if (!isObject(u)) return [u];
      if (!Array.isArray(u.sentenceIds) && (typeof u.sourceId !== "string" || typeof u.quote !== "string")) {
        warnings.push({ path: `proposedUpdates.${index}`, code: "update_dropped", detail: "malformed" }); return [];
      }
      return [u.previousValue === undefined ? { ...u, previousValue: null } : u];
    });
  }
  if (Array.isArray(out.observations)) {
    out.observations = out.observations.filter((o, index) => {
      if (observationShape.safeParse(o).success) return true;
      warnings.push({ path: `observations.${index}`, code: "observation_dropped", detail: "malformed" }); return false;
    });
  }
  return out;
}

/** One citation as written in a turn: a model cites `sentenceIds`; a turn the server already validated has `sourceId` + `quote`. */
type Cited = { sentenceIds?: string[]; sourceId?: string; quote?: string };
type RawTurn = { reply?: unknown; questions: { gapKey: string; question: string; whyItMatters?: unknown }[];
  proposedUpdates: (Cited & { fieldId: string; operation: "PROPOSE_SET" | "PROPOSE_REPLACE"; previousValue: string | null })[];
  proposedSteps: (Cited & { nameHint?: string | null })[];
  proposedRequirements: (Cited & { stepRef: string; kind: z.infer<typeof requirementKind>; critical: boolean })[];
  observations: z.infer<typeof observationShape>[] };
type TurnResult = { success: true; data: InterviewTurn; warnings: InterviewWarning[] } | { success: false; errors: InterviewIssue[] };

/** Validate a model's turn against the authorized input: references, and extractive provenance. The model cites sentence
 * IDs (see interview-sentences.ts); the server resolves them to the exact source slice and sets `quote` to it and `value`
 * equal to it. schemaVersion/contextRevision come from `input`, an off-list reply becomes the first allowed one, and a
 * question without whyItMatters is dropped. Repairs are returned as warnings, never as errors. This does not establish
 * business truth or the relevance of a selected passage; a user must still review each proposal before a separate
 * authorized apply. */
export const validateInterviewTurn = (input: InterviewInput, raw: unknown): TurnResult => validate(input, raw, "model");

/** Re-check a turn this server already validated (stored shape: `sourceId` + exact `quote`) against the current input,
 * e.g. just before it is persisted. A quote must be an exact substring of its source; nothing is normalised. */
export const revalidateStoredTurn = (input: InterviewInput, raw: unknown): TurnResult => validate(input, raw, "stored");

function validate(input: InterviewInput, raw: unknown, mode: "model" | "stored"): TurnResult {
  // Over a proposal cap: keep the first entries in model order. Dropped proposals are simply never offered;
  // every kept one still goes through citation resolution and user acceptance.
  const warnings: InterviewWarning[] = [];
  let candidate = tidy(raw, warnings);
  for (const [key, max] of [["proposedUpdates", MAX_PROPOSALS], ["proposedSteps", MAX_NEW_STEPS], ["proposedRequirements", MAX_NEW_REQUIREMENTS]] as const) {
    const all = (candidate as Record<string, unknown> | null)?.[key];
    if (!Array.isArray(all) || all.length <= max) continue;
    warnings.push({ path: key, code: "proposals_truncated", detail: `dropped ${all.length - max}` });
    candidate = { ...(candidate as object), [key]: all.slice(0, max) };
  }
  const parsed = (mode === "model" ? InterviewTurnRawSchema : StoredTurnRawSchema).safeParse(candidate);
  if (!parsed.success) return { success: false, errors: parsed.error.issues.slice(0, 30).map(issue => ({
    path: issue.path.filter(part => typeof part === "number" ||
      (typeof part === "string" && /^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(part))).join("."), code: issue.code,
  })) };
  const model = parsed.data as unknown as RawTurn;
  const errors: InterviewIssue[] = [];
  const invalid = (path: string, code: string) => errors.push({ path, code });
  const reply = REPLIES.find(allowed => allowed === model.reply);
  if (!reply) warnings.push({ path: "reply", code: "reply_replaced" });
  const kept = model.questions.flatMap((question, index) => {
    if (usableWhy(question.whyItMatters)) return [{ index, question: { ...question, whyItMatters: question.whyItMatters } }];
    warnings.push({ path: `questions.${index}.whyItMatters`, code: "question_dropped" });
    return [];
  });
  const active = new Set(input.activeGaps.map(gap => gap.key));
  const previousAssistantText = input.history.filter(item => item.role === "assistant").map(item => questionKey(item.text));
  const seenQuestions = new Set<string>();
  const seenGaps = new Set<string>();
  const stepOfGap = new Map(input.activeGaps.map(gap => [gap.key, gap.stepId]));
  const seenSteps = new Set<string>();
  const refused: { path: string; code: string }[] = [];
  // A question that cannot be asked (gap not open, gap or step already asked this turn, wording asked before) is dropped
  // with a warning as long as another question survives; if none does, each refusal is a hard error so the model repairs.
  const asked = kept.filter(({ index, question }) => {
    const path = `questions.${index}`;
    const stepId = stepOfGap.get(question.gapKey);
    const normalized = questionKey(question.question);
    const refusal = !active.has(question.gapKey) || input.closedGapKeys.includes(question.gapKey) ? { path: `${path}.gapKey`, code: "inactive_gap" }
      : seenGaps.has(question.gapKey) ? { path: `${path}.gapKey`, code: "duplicate_gap" }
      : stepId && seenSteps.has(stepId) ? { path: `${path}.gapKey`, code: "duplicate_step_gap" }
      : seenQuestions.has(normalized) || previousAssistantText.some(message => message.includes(normalized)) ? { path: `${path}.question`, code: "repeated_question" }
      : null;
    if (refusal) { refused.push(refusal); return false; }
    seenGaps.add(question.gapKey); seenQuestions.add(normalized);
    if (stepId) seenSteps.add(stepId);
    return true;
  });
  if (asked.length) refused.forEach(item => warnings.push({ path: item.path, code: "question_dropped", detail: item.code }));
  else if (refused.length) refused.forEach(item => invalid(item.path, item.code));
  else if (input.activeGaps.length) {
    // A turn that asks nothing while a gap is open stalls the interview: refuse it so the model repairs it.
    if (model.questions.length) invalid(`questions.${model.questions.findIndex(q => !usableWhy(q.whyItMatters))}.whyItMatters`, "missing_why_it_matters");
    else invalid("questions", "no_questions");
  }
  const fields = new Map(input.fields.map(field => [field.id, field]));
  const sources = new Map([...input.evidence, input.currentMessage].map(item => [item.id, item.text]));
  const index = indexSentences(input);
  /** The source and exact passage a proposal cites, or why there is none. */
  const resolveCitation = (cited: Cited): Citation | { problem: string } => {
    const found = cited.sentenceIds ? resolveSentenceIds(index, sources, cited.sentenceIds)
      : sources.get(cited.sourceId ?? "")?.includes(cited.quote ?? "") ? { sourceId: cited.sourceId!, quote: cited.quote! } : { problem: "quote_not_in_source" };
    return "quote" in found && found.quote.length > 8000 ? { problem: "quote_too_long" } : found;
  };
  const citationPath = (path: string) => `${path}.${mode === "model" ? "sentenceIds" : "quote"}`;
  /** The resolved citation of a proposal, or null when the proposal cannot be kept: a span too long to be one fact is
   * dropped with a warning, anything else (unknown ID, quote not in source) fails the turn so the model repairs it. */
  const cite = (path: string, cited: Cited) => {
    const resolved = resolveCitation(cited);
    if ("problem" in resolved) {
      if (resolved.problem === "evidence_span_too_long") warnings.push({ path, code: resolved.problem });
      else invalid(citationPath(path), resolved.problem);
      return null;
    }
    if ("warning" in resolved && resolved.warning) warnings.push({ path, code: resolved.warning });
    return resolved;
  };
  const updated = new Set<string>();
  const updates = model.proposedUpdates.flatMap((update, index) => {
    const path = `proposedUpdates.${index}`;
    const field = fields.get(update.fieldId);
    // A field proposal that cannot become a fact (unknown field, field already answered, wrong previousValue, a second
    // one for the same field) is dropped with a warning: failing the whole turn costs
    // a repair round for nothing. Every proposal that is kept has a verified quote.
    const drop = (detail: string) => { warnings.push({ path, code: "update_dropped", detail }); return []; };
    if (!field) return drop("unknown_field");
    if (updated.has(update.fieldId)) return drop("duplicate_update");
    if (update.operation === "PROPOSE_SET"
      ? field.status !== "EMPTY" || field.value !== null || update.previousValue !== null
      : field.status !== "KNOWN" || field.value === null || update.previousValue !== field.value) return drop("invalid_previous_value");
    const resolved = cite(path, update);
    if (!resolved) return [];
    updated.add(update.fieldId);
    return [{ fieldId: update.fieldId, operation: update.operation, previousValue: update.previousValue,
      sourceId: resolved.sourceId, quote: resolved.quote, value: resolved.quote }];
  });
  // Is `a` the same passage as `b`: one starts the other (existing summaries are truncated) or most words are shared.
  const similar = (a: string, b: string | null) => {
    const left = questionKey(a), right = questionKey(b ?? "");
    if (Math.min(left.length, right.length) >= 20 && (left.startsWith(right) || right.startsWith(left))) return true;
    const x = new Set(left.split(/[^\p{L}\p{N}]+/u).filter(Boolean)), y = new Set(right.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    let shared = 0; for (const word of x) if (y.has(word)) shared++;
    return x.size >= 4 && y.size >= 4 && shared / (x.size + y.size - shared) >= 0.5;
  };
  const knownSteps = new Map(input.steps.map(step => [step.id, step]));
  // Where each proposed step ended up: kept as the n-th new step, merged into a step that already exists, or refused.
  const stepFate: ({ new: number } | { existing: string } | null)[] = [];
  const steps: { sourceId: string; quote: string; value: string; nameHint: string | null }[] = [];
  model.proposedSteps.forEach((step, index) => {
    const path = `proposedSteps.${index}`;
    const resolved = cite(path, step);
    if (!resolved) { stepFate.push(null); return; }
    let nameHint: string | null = null;
    if (step.nameHint) {
      // A label is a convenience, never provenance: one that is not a phrase of the source is dropped, not an error.
      const hint = step.nameHint.trim();
      if (hint && sources.get(resolved.sourceId)!.includes(hint)) nameHint = hint;
      else warnings.push({ path: `${path}.nameHint`, code: "name_hint_dropped" });
    }
    // A stage that is already a step (or was proposed earlier this turn) is not created twice.
    const sameName = (name: string | null) => !!nameHint && !!name && questionKey(name) === questionKey(nameHint);
    const existing = input.steps.find(x => sameName(x.name) || similar(resolved.quote, x.summary));
    const earlier = steps.findIndex(x => sameName(x.nameHint) || similar(resolved.quote, x.quote));
    if (existing || earlier >= 0) {
      warnings.push({ path, code: "step_dropped", detail: "duplicate_step" });
      stepFate.push(existing ? { existing: existing.id } : { new: earlier });
      return;
    }
    steps.push({ sourceId: resolved.sourceId, quote: resolved.quote, value: resolved.quote, nameHint });
    stepFate.push({ new: steps.length - 1 });
  });
  const takenRequirements = input.requirements.map(item => item.statement);
  const requirements = model.proposedRequirements.flatMap((item, index) => {
    const path = `proposedRequirements.${index}`;
    const resolved = cite(path, item);
    if (!resolved) return [];
    const fresh = /^new_(\d{1,2})$/.exec(item.stepRef);
    const fate = fresh ? stepFate[Number(fresh[1])] : undefined;
    const stepRef = !fresh ? item.stepRef : fate ? ("new" in fate ? `new_${fate.new}` : fate.existing) : null;
    if (!stepRef || (!fresh && !knownSteps.has(stepRef))) {
      // A model's requirement that attaches to no step is dropped; a stored turn was validated once, so it stays fatal.
      if (mode === "model") warnings.push({ path, code: "requirement_dropped", detail: "unknown_step_ref" });
      else invalid(`${path}.stepRef`, "unknown_step_ref");
      return [];
    }
    if (takenRequirements.some(taken => similar(resolved.quote, taken))) {
      warnings.push({ path, code: "requirement_dropped", detail: "duplicate_requirement" });
      return [];
    }
    takenRequirements.push(resolved.quote);
    return [{ stepRef, kind: item.kind, critical: item.critical, sourceId: resolved.sourceId, quote: resolved.quote, value: resolved.quote }];
  });
  // An observation is advisory: one that points at no known field is dropped, never fatal.
  const observations = model.observations.filter((observation, index) => {
    if (!duplicate(observation.fieldIds) && observation.fieldIds.every(id => fields.has(id))) return true;
    warnings.push({ path: `observations.${index}.fieldIds`, code: "observation_dropped", detail: "invalid_field_refs" });
    return false;
  });
  if (errors.length) return { success: false, errors: errors.slice(0, 30) };
  const turn = InterviewTurnSchema.safeParse({ schemaVersion: 1, contextRevision: input.contextRevision,
    reply: reply ?? REPLIES[0], questions: asked.map(({ question }) => question), proposedUpdates: updates,
    proposedSteps: steps, proposedRequirements: requirements, observations });
  return turn.success ? { success: true, data: turn.data, warnings }
    : { success: false, errors: [{ path: "", code: "invalid_turn" }] };
}
