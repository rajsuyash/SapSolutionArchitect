// Pure scoring of a recorded consultant run (interview transcript + final To-Be). No I/O:
// the live driver (scripts/eval-consultant.ts) records, this module judges.
import { z } from "zod";

const count = z.number().int().nonnegative();
export const TurnRecordSchema = z.object({
  index: z.number().int().positive(),
  userMessage: z.string(),
  /** activeGaps handed to the model for this turn. */
  gapsAvailable: count,
  questions: z.array(z.object({ gapKey: z.string(), fieldId: z.string(), question: z.string() })),
  proposals: count,
  /** Provider calls made by runStage for this turn; 1 means the first attempt validated. */
  attempts: count,
  validationErrors: count,
  /** Model reported by runStage for this turn (absent in older transcripts). */
  model: z.string().optional(),
  /** Every validation issue runStage produced, tagged with the 1-based attempt it came from (absent in older transcripts). */
  issues: z.array(z.object({ attempt: z.number().int().positive(), path: z.string(), code: z.string(), detail: z.string().optional() })).default([]),
  /** stop_reason of each provider response for this turn, in attempt order (absent in older transcripts). */
  stopReasons: z.array(z.string().nullable()).default([]),
  /** Server-side repairs applied to the accepted turn (reply_replaced, question_dropped, name_hint_dropped). */
  warnings: z.array(z.object({ path: z.string(), code: z.string(), detail: z.string().optional() })).default([]),
  /** Provider responses of the chat call accepted from a JSON text block instead of a tool call (absent in older transcripts). */
  textFallbacks: count.default(0),
  /** The background extraction of this turn's user message (absent in older transcripts and when it was already done). */
  extraction: z.object({ attempts: count, validationErrors: count, textFallbacks: count,
    warnings: z.array(z.object({ path: z.string(), code: z.string(), detail: z.string().optional() })), inputTokens: count, outputTokens: count, latencyMs: count,
    error: z.string().nullable() }).nullable().default(null),
  /** Stage error code when the turn failed (AI_INVALID_OUTPUT, AI_PROVIDER_ERROR, ...). */
  error: z.string().nullable(),
  inputTokens: count, outputTokens: count, latencyMs: count,
});
const StepRecordSchema = z.looseObject({
  id: z.string(), title: z.string(), requirementIds: z.array(z.string()),
  actions: z.array(z.looseObject({ operation: z.string(), system: z.string().optional(), fields: z.array(z.string()).optional() })),
  implementation: z.looseObject({ kind: z.string(), detail: z.string() }),
  acceptanceTests: z.array(z.looseObject({ given: z.string(), when: z.string(), then: z.string() })),
  addedValue: z.string(),
});
const registerRows = z.array(z.looseObject({})).optional();
const RegisterRows = { kpis: registerRows, interfaces: registerRows };
export const TranscriptSchema = z.object({
  schemaVersion: z.literal(1),
  caseId: z.string(), provider: z.string(), model: z.string(), startedAt: z.string(),
  turns: z.array(TurnRecordSchema),
  readiness: z.object({
    reached: z.boolean(), atTurn: z.number().int().positive().nullable(),
    /** The driver filled the template directly after the turn cap so the To-Be could still be measured. */
    forcedCompletion: z.boolean(), directEdits: count, blockers: z.array(z.string()),
  }),
  toBe: z.object({
    attempted: z.boolean(), structurallyValid: z.boolean(), errorCode: z.string().nullable(),
    attempts: count, validationErrors: count, inputTokens: count, outputTokens: count,
    /** Absent in older transcripts. Provider stop reasons, validation issue codes+paths (no model values) and tokens per To-Be request kind. */
    latencyMs: count.optional(), stopReasons: z.array(z.string()).optional(),
    issues: z.array(z.object({ attempt: count, path: z.string(), code: z.string(), detail: z.string().optional() })).optional(),
    /** Server-side repairs applied to accepted calls (REPAIRED_* codes and paths), and the capped raw payloads of calls that failed validation. */
    warnings: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
    rawFailures: z.array(z.object({ substage: z.string(), key: z.string(), attempt: count, json: z.string(), truncated: z.boolean() })).optional(),
    substages: z.record(z.string(), z.object({ calls: count, inputTokens: count, outputTokens: count })).optional(),
    requirements: z.array(z.object({ id: z.string(), statement: z.string(), evidence: z.string().optional() })),
    /** The design exactly as the generator validated it (v1 or v2). Loose on purpose: unknown keys, including the v2 registers
     * and coverage, must survive parsing, or the judge and replays see a steps-only design. */
    design: z.looseObject({ steps: z.array(StepRecordSchema), ...RegisterRows }).nullable(),
    /** Sections the server builds without a model (document control, As-Is narratives, RICEFW list); the judge reads them with the design. */
    derived: z.record(z.string(), z.unknown()).optional(),
  }).nullable(),
  /** Active interviewer gaps left when the run ended (absent in older transcripts). */
  gapsRemaining: count.optional(),
  /** Steps and requirements that exist at the end of the run. The driver creates none itself, so all came from accepted
   * interviewer proposals (absent in older transcripts, which pre-created them). */
  structure: z.object({ steps: count, requirements: count }).optional(),
  aborted: z.string().nullable(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/** The slice of a fixture the scorer needs. Regexes are source strings, compiled case-insensitively. */
export const ScoringCaseSchema = z.object({
  caseId: z.string(),
  expected: z.object({
    capabilities: z.array(z.object({ id: z.string(), name: z.string(), solutionRegex: z.string(), painRegex: z.string() })).min(1),
    kpis: z.array(z.object({ id: z.string(), regex: z.string() })),
    salesforce: z.object({ mentionRegex: z.string(), replaceRegex: z.string() }),
  }),
  passBar: z.object({
    maxTurnsToReadiness: z.number(), maxRepeatedGapKeys: z.number(), maxNearDuplicates: z.number(),
    minFirstAttemptValidRate: z.number(), requireToBeValid: z.boolean(), minCapabilities: z.number(),
    minKpis: z.number(), requireSalesforceIntegration: z.boolean(),
    /** Cross-turn semantic duplicates tolerated (default 0). */
    maxSemanticDuplicates: z.number().default(0),
  }),
});
export type ScoringCase = z.infer<typeof ScoringCaseSchema>;

export const NEAR_DUPLICATE_JACCARD = 0.8;
/** Two questions in different turns at or above this normalized-token Jaccard are the same question asked again. */
export const SEMANTIC_DUPLICATE_JACCARD = 0.6;
const STOPWORDS = new Set(("a an the of to in on for and or is are was were be been do does did you your we our it its this that these those with at by " +
  "from as how what which who whom when where why can could would should will not no any about me us there than then so if").split(" "));
/** Tokens of a question without stopwords and, once the run has enough questions, without the wording nearly every
 * question shares (a walkthrough template): what is left is the topic. */
function topicTokens(questions: string[]): Set<string>[] {
  const sets = questions.map(q => new Set([...tokens(q)].filter(t => !STOPWORDS.has(t))));
  if (questions.length < 8) return sets;
  const frequency = new Map<string, number>();
  for (const set of sets) for (const token of set) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  return sets.map(set => new Set([...set].filter(t => frequency.get(t)! <= questions.length * 0.4)));
}
const rx = (source: string) => new RegExp(source, "i");
const tokens = (text: string) => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(Boolean));
export function jaccard(a: string, b: string): number {
  const left = tokens(a), right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

type Step = NonNullable<NonNullable<Transcript["toBe"]>["design"]>["steps"][number];
type Design = NonNullable<NonNullable<Transcript["toBe"]>["design"]>;
const rowText = (row: Record<string, unknown>) => Object.values(row).filter(v => typeof v === "string").join(" ");
const stepText = (step: Step) => [step.title, ...step.actions.flatMap(a => [a.operation, a.system ?? "", ...(a.fields ?? [])]),
  step.implementation.detail].join("\n");

const count_ = (values: string[]) => Object.fromEntries(Object.entries(values.reduce<Record<string, number>>((acc, v) => {
  acc[v] = (acc[v] ?? 0) + 1; return acc;
}, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

export function scoreRun(rawTranscript: unknown, rawCase: unknown) {
  const transcript = TranscriptSchema.parse(rawTranscript);
  const { expected, passBar } = ScoringCaseSchema.parse(rawCase);
  const { turns, toBe } = transcript;

  const questions = turns.flatMap(t => t.questions.map(q => ({ turn: t.index, ...q })));
  // A gapKey asked twice, in one turn or across turns, is repeated: count occurrences.
  const occurrences = new Map<string, number>();
  for (const q of questions) occurrences.set(q.gapKey, (occurrences.get(q.gapKey) ?? 0) + 1);
  const repeatedGapKeys = [...occurrences].filter(([, n]) => n > 1).map(([key]) => key);

  const nearDuplicates: { a: { turn: number; question: string }; b: { turn: number; question: string }; jaccard: number }[] = [];
  for (let i = 0; i < questions.length; i++) for (let j = i + 1; j < questions.length; j++) {
    const score = jaccard(questions[i]!.question, questions[j]!.question);
    if (score >= NEAR_DUPLICATE_JACCARD) nearDuplicates.push({
      a: { turn: questions[i]!.turn, question: questions[i]!.question },
      b: { turn: questions[j]!.turn, question: questions[j]!.question }, jaccard: Number(score.toFixed(3)) });
  }

  const topics = topicTokens(questions.map(q => q.question));
  const semanticDuplicates: { a: { turn: number; question: string }; b: { turn: number; question: string }; jaccard: number }[] = [];
  for (let i = 0; i < questions.length; i++) for (let j = i + 1; j < questions.length; j++) {
    if (questions[i]!.turn === questions[j]!.turn) continue;
    const left = topics[i]!, right = topics[j]!;
    if (!left.size || !right.size) continue;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared++;
    const score = shared / (left.size + right.size - shared);
    if (score >= SEMANTIC_DUPLICATE_JACCARD) semanticDuplicates.push({
      a: { turn: questions[i]!.turn, question: questions[i]!.question },
      b: { turn: questions[j]!.turn, question: questions[j]!.question }, jaccard: Number(score.toFixed(3)) });
  }

  // attempts === 1 is the recorded provider-call count; 0 means "not captured" and must never count as valid.
  const validTurns = turns.filter(t => t.error === null && t.attempts === 1 && t.validationErrors === 0).length;
  const histogram = (key: (i: Transcript["turns"][number]["issues"][number]) => string) => {
    const counts: Record<string, number> = {};
    for (const issue of turns.flatMap(t => t.issues)) counts[key(issue)] = (counts[key(issue)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  };
  const validationErrorCodes = histogram(i => i.code);
  // Array indices are collapsed so questions.3.gapKey and questions.0.gapKey count as one rule.
  const validationErrorPaths = histogram(i => `${i.path.replace(/\.\d+(?=\.|$)/g, ".*")}|${i.code}`);
  const firstAttemptValidRate = turns.length ? validTurns / turns.length : 0;
  // "Valid" lets the server repair a reply or fall back to a JSON text block; "clean" does not: it counts the turns where the
  // chat call (and the extraction, when one ran) came back as a native tool call that needed no repair at all.
  const extractions = turns.flatMap(t => t.extraction ? [t.extraction] : []);
  const extractionValid = extractions.filter(e => e.error === null && e.attempts === 1 && e.validationErrors === 0).length;
  const cleanTurns = turns.filter(t => t.error === null && t.attempts === 1 && t.validationErrors === 0 && t.textFallbacks === 0 && t.warnings.length === 0 &&
    (!t.extraction || (t.extraction.error === null && t.extraction.attempts === 1 && t.extraction.validationErrors === 0 &&
      t.extraction.textFallbacks === 0 && t.extraction.warnings.length === 0))).length;
  const turnsToReadiness = transcript.readiness.reached ? transcript.readiness.atTurn : null;

  const requirementText = new Map((toBe?.requirements ?? []).map(r => [r.id, `${r.statement}\n${r.evidence ?? ""}`]));
  const steps = toBe?.design?.steps ?? [];
  const capabilities = expected.capabilities.map(cap => {
    const solution = rx(cap.solutionRegex), pain = rx(cap.painRegex);
    const matching = steps.filter(step => solution.test(stepText(step)));
    // Mentioning the capability is not enough: the step must serve a requirement that names the related pain.
    const linked = matching.find(step => step.requirementIds.some(id => pain.test(requirementText.get(id) ?? "")));
    return { id: cap.id, name: cap.name, covered: !!linked, stepId: linked?.id ?? null,
      reason: linked ? "covered" as const : matching.length ? "no_requirement_link" as const : "no_solution_text" as const };
  });
  const capabilityCount = capabilities.filter(c => c.covered).length;

  const design: Design | null = toBe?.design ?? null;
  // v2 designs state KPIs in their own register; v1 designs only in step added value and acceptance tests.
  const kpiCorpus = [...steps.flatMap(s => [s.addedValue, ...s.acceptanceTests.map(t => `${t.given} ${t.when} ${t.then}`)]),
    ...(design?.kpis ?? []).map(rowText)].join("\n");
  const kpis = expected.kpis.map(k => ({ id: k.id, met: rx(k.regex).test(kpiCorpus) }));
  const kpiCount = kpis.filter(k => k.met).length;

  const mention = rx(expected.salesforce.mentionRegex), replace = rx(expected.salesforce.replaceRegex);
  const salesforce = {
    integration: steps.some(s => s.implementation.kind === "INTEGRATION" && mention.test(`${stepText(s)}\n${s.addedValue}`)) ||
      (design?.interfaces ?? []).some(row => mention.test(rowText(row))),
    replaced: steps.some(s => replace.test(`${stepText(s)}\n${s.addedValue}`)),
  };

  const toBeValid = !!toBe?.attempted && toBe.structurallyValid && steps.length > 0;
  const check = (name: string, pass: boolean, detail: string) => ({ name, pass, detail });
  const checks = [
    check("readiness", turnsToReadiness !== null && turnsToReadiness <= passBar.maxTurnsToReadiness,
      `${turnsToReadiness ?? "not reached"} turns (max ${passBar.maxTurnsToReadiness})`),
    check("repeatedGapKeys", repeatedGapKeys.length <= passBar.maxRepeatedGapKeys, `${repeatedGapKeys.length} (max ${passBar.maxRepeatedGapKeys})`),
    check("nearDuplicates", nearDuplicates.length <= passBar.maxNearDuplicates, `${nearDuplicates.length} pairs (max ${passBar.maxNearDuplicates})`),
    check("semanticDuplicates", semanticDuplicates.length <= passBar.maxSemanticDuplicates,
      `${semanticDuplicates.length} cross-turn pairs at Jaccard >= ${SEMANTIC_DUPLICATE_JACCARD} (max ${passBar.maxSemanticDuplicates})`),
    check("firstAttemptValid", turns.length > 0 && firstAttemptValidRate >= passBar.minFirstAttemptValidRate,
      `${(firstAttemptValidRate * 100).toFixed(0)}% of ${turns.length} turns (min ${passBar.minFirstAttemptValidRate * 100}%)`),
    check("toBeValid", !passBar.requireToBeValid || toBeValid, toBe ? (toBeValid ? "valid" : `invalid (${toBe.errorCode ?? "no steps"})`) : "To-Be not generated"),
    check("capabilities", capabilityCount >= passBar.minCapabilities, `${capabilityCount}/${capabilities.length} (min ${passBar.minCapabilities})`),
    check("kpis", kpiCount >= passBar.minKpis, `${kpiCount}/${kpis.length} (min ${passBar.minKpis})`),
    check("salesforce", !passBar.requireSalesforceIntegration || (salesforce.integration && !salesforce.replaced),
      `integration=${salesforce.integration} replaced=${salesforce.replaced}`),
  ];

  return {
    caseId: transcript.caseId, provider: transcript.provider, model: transcript.model,
    turns: {
      total: turns.length, turnsToReadiness, forcedCompletion: transcript.readiness.forcedCompletion,
      directEdits: transcript.readiness.directEdits,
      questionsPerTurn: turns.map(t => t.questions.length),
      zeroQuestionTurnsWithGapsRemaining: turns.filter(t => t.questions.length === 0 && t.gapsAvailable > 0).map(t => t.index),
      failedTurns: turns.filter(t => t.error !== null).map(t => ({ turn: t.index, error: t.error })),
    },
    repeatedGapKeys, nearDuplicateCount: nearDuplicates.length, nearDuplicates: nearDuplicates.slice(0, 20), // sample only
    semanticDuplicateCount: semanticDuplicates.length, semanticDuplicates: semanticDuplicates.slice(0, 20),
    interviewerCreated: transcript.structure ?? null,
    validationErrorCodes, validationErrorPaths,
    stopReasons: count_(turns.flatMap(t => t.stopReasons.map(r => r ?? "none"))),
    warningCodes: count_(turns.flatMap(t => t.warnings.map(w => w.code))),
    firstAttemptValidRate: Number(firstAttemptValidRate.toFixed(3)),
    extractionRuns: extractions.length, extractionFirstAttemptValidRate: extractions.length ? Number((extractionValid / extractions.length).toFixed(3)) : null,
    extractionFailures: extractions.filter(e => e.error !== null).length,
    textFallbackTurns: turns.filter(t => t.textFallbacks > 0 || (t.extraction?.textFallbacks ?? 0) > 0).length,
    cleanFirstTryRate: turns.length ? Number((cleanTurns / turns.length).toFixed(3)) : 0,
    toBeValid, capabilities, capabilityCount, kpis, kpiCount, salesforce,
    outputTokens: turns.reduce((n, t) => n + t.outputTokens, 0) + (toBe?.outputTokens ?? 0),
    aborted: transcript.aborted, checks, pass: checks.every(c => c.pass),
  };
}
export type Score = ReturnType<typeof scoreRun>;

export function summarize(score: Score): string {
  const lines = [`${score.pass ? "PASS" : "FAIL"}  ${score.caseId}  ${score.provider}/${score.model}`,
    ...score.checks.map(c => `  ${c.pass ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`)];
  const missed = score.capabilities.filter(c => !c.covered).map(c => `${c.id} (${c.reason})`);
  if (missed.length) lines.push(`  capabilities missed: ${missed.join(", ")}`);
  if (score.turns.zeroQuestionTurnsWithGapsRemaining.length) {
    lines.push(`  turns with 0 questions while gaps remained: ${score.turns.zeroQuestionTurnsWithGapsRemaining.join(", ")}`);
  }
  if (score.extractionRuns) lines.push(`  extraction: ${score.extractionRuns} runs, first-attempt valid ${((score.extractionFirstAttemptValidRate ?? 0) * 100).toFixed(0)}%, failures ${score.extractionFailures}`);
  lines.push(`  clean first try (no repair, no text fallback, chat + extraction): ${(score.cleanFirstTryRate * 100).toFixed(0)}%; turns using the JSON-text fallback: ${score.textFallbackTurns}`);
  if (score.interviewerCreated) lines.push(`  created by the interviewer: ${score.interviewerCreated.steps} steps, ${score.interviewerCreated.requirements} requirements`);
  if (score.turns.forcedCompletion) lines.push(`  note: template completed by direct entry after the turn cap (${score.turns.directEdits} edits)`);
  const top = (h: Record<string, number>) => Object.entries(h).slice(0, 8).map(([k, n]) => `${k} x${n}`).join(", ");
  if (Object.keys(score.validationErrorCodes).length) {
    lines.push(`  validation error codes: ${top(score.validationErrorCodes)}`, `  validation error paths: ${top(score.validationErrorPaths)}`);
  }
  if (Object.keys(score.stopReasons).length) lines.push(`  stop reasons: ${top(score.stopReasons)}`);
  if (Object.keys(score.warningCodes).length) lines.push(`  server repairs (warnings): ${top(score.warningCodes)}`);
  if (score.aborted) lines.push(`  aborted: ${score.aborted}`);
  return lines.join("\n");
}
