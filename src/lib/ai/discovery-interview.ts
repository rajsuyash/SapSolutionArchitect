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

/** All changes are proposals. No output field conveys approval or readiness.
 * Questions and observations remain untrusted model text, not workflow commands. */
export const InterviewTurnSchema = z.strictObject({
  schemaVersion: z.literal(1),
  contextRevision: z.number().int().positive().max(2147483647),
  // Keep acknowledgement separate from questions and application-owned status.
  reply: z.enum(["Thank you for that context.", "Let's review what you've shared.", "We can take this one step at a time."]),
  questions: z.array(z.strictObject({
    gapKey: identifier, question: content(500), whyItMatters: content(500),
  })).max(3),
  proposedUpdates: z.array(z.strictObject({
    fieldId: identifier,
    operation: z.enum(["PROPOSE_SET", "PROPOSE_REPLACE"]),
    previousValue: fieldValue.nullable(), value: fieldValue,
    sourceId: identifier, quote: content(8000),
  })).max(12),
  observations: z.array(z.strictObject({
    kind: z.enum(["POSSIBLE_CONFLICT", "FOLLOW_UP_SUGGESTION"]),
    fieldIds: z.array(identifier).min(1).max(10), detail: content(1000),
  })).max(6),
});
export type InterviewTurn = z.infer<typeof InterviewTurnSchema>;
export type InterviewIssue = { path: string; code: string };

// Defense in depth for common identifiers/credential formats, not a complete
// secret detector. Authorized context assembly must exclude credential stores.
const sensitive = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\b(?:Bearer\s+\S+|Authorization\s*:\s*Basic\s+\S+|(?:password|api[_ -]?key|secret|token)\s*[:=]\s*\S+)/i;
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

/** Validate references and extractive provenance against the authorized revision.
 * This does not establish business truth or the relevance of a selected passage;
 * a user must still review each proposal before a separate authorized apply. */
export function validateInterviewTurn(input: InterviewInput, raw: unknown):
  { success: true; data: InterviewTurn } | { success: false; errors: InterviewIssue[] } {
  const parsed = InterviewTurnSchema.safeParse(raw);
  if (!parsed.success) return { success: false, errors: parsed.error.issues.slice(0, 30).map(issue => ({
    path: issue.path.filter(part => typeof part === "number" ||
      (typeof part === "string" && /^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(part))).join("."), code: issue.code,
  })) };
  const turn = parsed.data;
  const errors: InterviewIssue[] = [];
  const invalid = (path: string, code: string) => errors.push({ path, code });
  if (turn.contextRevision !== input.contextRevision) invalid("contextRevision", "stale_revision");
  const active = new Set(input.activeGaps.map(gap => gap.key));
  const previousAssistantText = input.history.filter(item => item.role === "assistant").map(item => questionKey(item.text));
  const seenQuestions = new Set<string>();
  const seenGaps = new Set<string>();
  turn.questions.forEach((question, index) => {
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
  turn.proposedUpdates.forEach((update, index) => {
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
    if (!sources.get(update.sourceId)?.includes(update.quote)) invalid(`${path}.quote`, "quote_not_in_source");
    if (update.value !== update.quote) invalid(`${path}.value`, "value_must_equal_quote");
  });
  turn.observations.forEach((observation, index) => {
    if (duplicate(observation.fieldIds) || observation.fieldIds.some(id => !fields.has(id))) {
      invalid(`observations.${index}.fieldIds`, "invalid_field_refs");
    }
  });
  return errors.length ? { success: false, errors: errors.slice(0, 30) } : { success: true, data: turn };
}
