import { z } from "zod";

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
  })).max(100),
  activeGaps: z.array(z.strictObject({
    key: identifier, fieldId: identifier, detail: content(1000),
    priority: z.enum(["CRITICAL", "IMPORTANT", "LATER"]),
  })).max(100),
  closedGapKeys: z.array(identifier).max(200),
  history: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), text: content(8000) })).max(24),
});
export type InterviewInput = z.infer<typeof InterviewInputSchema>;

const REPLIES = ["Thank you for that context.", "Let's review what you've shared.", "We can take this one step at a time."] as const;
const observationShape = z.strictObject({
  kind: z.enum(["POSSIBLE_CONFLICT", "FOLLOW_UP_SUGGESTION"]),
  fieldIds: z.array(identifier).min(1).max(10), detail: content(1000),
});
const updateShape = {
  fieldId: identifier, operation: z.enum(["PROPOSE_SET", "PROPOSE_REPLACE"]),
  previousValue: fieldValue.nullable(), sourceId: identifier, quote: content(8000),
};

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
  proposedUpdates: z.array(z.strictObject({ ...updateShape, value: fieldValue })).max(12),
  observations: z.array(observationShape).max(6),
});
/** The contract shown to the model as the tool schema: no server-owned scalars and no `value`. */
export const InterviewTurnToolSchema = z.strictObject({
  reply: z.enum(REPLIES),
  questions: z.array(z.strictObject({ gapKey: identifier, question: content(500), whyItMatters: content(500) })).max(3),
  proposedUpdates: z.array(z.strictObject(updateShape)).max(12),
  observations: z.array(observationShape).max(6),
});
/** What the validator accepts from the model. Server-owned scalars and `value` may be present (and are then ignored);
 * a reply outside the allowed set or a question without usable whyItMatters is repaired or dropped with a warning. */
export const InterviewTurnRawSchema = z.strictObject({
  schemaVersion: z.unknown().optional(), contextRevision: z.unknown().optional(), reply: z.unknown().optional(),
  questions: z.array(z.strictObject({ gapKey: identifier, question: content(500), whyItMatters: z.unknown().optional() })).max(3),
  proposedUpdates: z.array(z.strictObject({ ...updateShape, value: z.unknown().optional() })).max(12),
  observations: z.array(observationShape).max(6),
});
export type InterviewTurn = z.infer<typeof InterviewTurnSchema>;
export type InterviewIssue = { path: string; code: string };
export type InterviewWarning = { path: string; code: string };

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

/** Fold text for quote matching only: NFKC, straight quotes/dashes, case-insensitive, whitespace runs as one space.
 * Every folded character remembers the span of original code points it came from, so a match maps back to the source. */
function fold(source: string) {
  let text = "";
  const start: number[] = [], end: number[] = [], first: boolean[] = [], last: boolean[] = [];
  let offset = 0;
  for (const point of source) {
    const from = offset; offset += point.length;
    const folded = [...point.normalize("NFKC").replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2010-\u2015\u2212]/g, "-").toLowerCase()];
    folded.forEach((char, index) => {
      if (/\s/.test(char)) {
        if (text.endsWith(" ")) { end[end.length - 1] = offset; return; }
        char = " ";
      }
      text += char; start.push(from); end.push(offset); first.push(index === 0); last.push(index === folded.length - 1);
    });
  }
  return { text, start, end, first, last };
}

/** Resolve a model quote to the EXACT source substring. A verbatim quote is kept as is. Otherwise the folded quote must
 * match exactly one folded span of the source, and the original text of that span is returned; the model's wording is
 * never stored. Zero matches is "missing", several is "ambiguous". */
export function resolveQuote(source: string, quote: string):
  { kind: "exact"; quote: string } | { kind: "normalized"; quote: string } | { kind: "missing" } | { kind: "ambiguous" } {
  if (source.includes(quote)) return { kind: "exact", quote };
  const needle = fold(quote).text.trim();
  if (!needle) return { kind: "missing" };
  const haystack = fold(source);
  const spans: [number, number][] = [];
  for (let at = haystack.text.indexOf(needle); at >= 0; at = haystack.text.indexOf(needle, at + 1)) {
    const last = at + needle.length - 1;
    // A match may not begin or end inside the expansion of one source character (e.g. a ligature).
    if (haystack.first[at] && haystack.last[last]) spans.push([haystack.start[at]!, haystack.end[last]!]);
  }
  if (spans.length !== 1) return { kind: spans.length ? "ambiguous" : "missing" };
  return { kind: "normalized", quote: source.slice(spans[0]![0], spans[0]![1]) };
}

const usableWhy = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 500 && !value.includes("\0");

/** Validate references and extractive provenance against the authorized revision, and normalise the server-owned parts
 * of the turn: schemaVersion/contextRevision come from `input`, an off-list reply becomes the first allowed one, a
 * question without whyItMatters is dropped, and each update's quote becomes the exact source substring with value set
 * equal to it. Repairs are returned as warnings, never as errors. This does not establish business truth or the
 * relevance of a selected passage; a user must still review each proposal before a separate authorized apply. */
export function validateInterviewTurn(input: InterviewInput, raw: unknown):
  { success: true; data: InterviewTurn; warnings: InterviewWarning[] } | { success: false; errors: InterviewIssue[] } {
  const parsed = InterviewTurnRawSchema.safeParse(raw);
  if (!parsed.success) return { success: false, errors: parsed.error.issues.slice(0, 30).map(issue => ({
    path: issue.path.filter(part => typeof part === "number" ||
      (typeof part === "string" && /^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(part))).join("."), code: issue.code,
  })) };
  const model = parsed.data;
  const errors: InterviewIssue[] = [];
  const warnings: InterviewWarning[] = [];
  const invalid = (path: string, code: string) => errors.push({ path, code });
  const reply = REPLIES.find(allowed => allowed === model.reply);
  if (!reply) warnings.push({ path: "reply", code: "reply_replaced" });
  const kept = model.questions.flatMap((question, index) => {
    if (usableWhy(question.whyItMatters)) return [{ index, question: { ...question, whyItMatters: question.whyItMatters } }];
    warnings.push({ path: `questions.${index}.whyItMatters`, code: "question_dropped" });
    return [];
  });
  if (model.questions.length && !kept.length && input.activeGaps.length) {
    invalid(`questions.${model.questions.findIndex(q => !usableWhy(q.whyItMatters))}.whyItMatters`, "missing_why_it_matters");
  }
  const active = new Set(input.activeGaps.map(gap => gap.key));
  const previousAssistantText = input.history.filter(item => item.role === "assistant").map(item => questionKey(item.text));
  const seenQuestions = new Set<string>();
  const seenGaps = new Set<string>();
  kept.forEach(({ index, question }) => {
    const path = `questions.${index}`;
    if (!active.has(question.gapKey) || input.closedGapKeys.includes(question.gapKey)) invalid(`${path}.gapKey`, "inactive_gap");
    if (seenGaps.has(question.gapKey)) invalid(`${path}.gapKey`, "duplicate_gap");
    seenGaps.add(question.gapKey);
    const normalized = questionKey(question.question);
    if (seenQuestions.has(normalized) || previousAssistantText.some(message => message.includes(normalized))) {
      invalid(`${path}.question`, "repeated_question");
    }
    seenQuestions.add(normalized);
  });
  const fields = new Map(input.fields.map(field => [field.id, field]));
  const sources = new Map([...input.evidence, input.currentMessage].map(item => [item.id, item.text]));
  const updated = new Set<string>();
  const updates = model.proposedUpdates.map((update, index) => {
    const path = `proposedUpdates.${index}`;
    const field = fields.get(update.fieldId);
    if (!field) invalid(`${path}.fieldId`, "unknown_field");
    if (updated.has(update.fieldId)) invalid(`${path}.fieldId`, "duplicate_update");
    updated.add(update.fieldId);
    if (field && (update.operation === "PROPOSE_SET"
      ? field.status !== "EMPTY" || field.value !== null || update.previousValue !== null
      : field.status !== "KNOWN" || field.value === null || update.previousValue !== field.value)) {
      invalid(`${path}.operation`, "invalid_previous_value");
    }
    const source = sources.get(update.sourceId);
    const resolved = source === undefined ? { kind: "missing" as const } : resolveQuote(source, update.quote);
    if (resolved.kind === "missing") invalid(`${path}.quote`, "quote_not_in_source");
    else if (resolved.kind === "ambiguous") invalid(`${path}.quote`, "ambiguous_quote");
    else if (resolved.quote.length > 8000) invalid(`${path}.quote`, "quote_too_long");
    else if (resolved.kind === "normalized") warnings.push({ path: `${path}.quote`, code: "quote_normalized" });
    const quote = resolved.kind === "exact" || resolved.kind === "normalized" ? resolved.quote : update.quote;
    return { fieldId: update.fieldId, operation: update.operation, previousValue: update.previousValue,
      sourceId: update.sourceId, quote, value: quote };
  });
  model.observations.forEach((observation, index) => {
    if (duplicate(observation.fieldIds) || observation.fieldIds.some(id => !fields.has(id))) {
      invalid(`observations.${index}.fieldIds`, "invalid_field_refs");
    }
  });
  if (errors.length) return { success: false, errors: errors.slice(0, 30) };
  const turn = InterviewTurnSchema.safeParse({ schemaVersion: 1, contextRevision: input.contextRevision,
    reply: reply ?? REPLIES[0], questions: kept.map(({ question }) => question), proposedUpdates: updates,
    observations: model.observations });
  return turn.success ? { success: true, data: turn.data, warnings }
    : { success: false, errors: [{ path: "", code: "invalid_turn" }] };
}
