import { z } from "zod";
import type { DetailedDesign } from "./design-quality";
import { REGISTER_GROUPS, REGISTER_KEYS, groupOf, type RegisterGroup, type RegisterKey } from "./design-registers";

/** The consistency pass: after the parts are assembled and valid, one more call reads the whole design in a compact form and lists what does not fit
 * together (the outline, then parallel sections, then a read-through: the final pass of STORM-style generation). Each finding names the elements involved
 * by id, so the server can send the step or register group it concerns back once; what cannot be fixed that way becomes a review finding in the report.
 * The pass is advisory: it never makes a valid design invalid. */

export const REVIEW_KINDS = ["CONTRADICTION", "MISSING_LINK", "UNRESOLVED_CODE", "COVERAGE_GAP", "INTERNAL_TERM"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export const MAX_REVIEW_FINDINGS = 20;
const EXPLANATION_MAX_CHARS = 400;

export const ReviewFindingSchema = z.strictObject({
  kind: z.enum(REVIEW_KINDS),
  /** Ids of the elements involved: a step, a business rule or test, a register row, a requirement or an open question. A trailing ".field" is allowed and ignored. */
  paths: z.array(z.string().trim().min(1).max(120)).min(1).max(4),
  explanation: z.string().trim().min(1).max(EXPLANATION_MAX_CHARS),
});
export const ReviewSchema = z.strictObject({ findings: z.array(ReviewFindingSchema).max(MAX_REVIEW_FINDINGS) });
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/** A finding after routing: `parts` are the steps and register groups it concerns (empty = it concerns the design as a whole), `outcome` what became of it. */
export type RoutedFinding = ReviewFinding & { parts: Part[]; blockerPath: string; outcome: "REPAIRED" | "UNRESOLVED" };
/** What a finding came to, as stored with the result. */
export type ReviewOutcome = Pick<RoutedFinding, "kind" | "paths" | "explanation" | "outcome" | "blockerPath">;
export type Part = { type: "step"; stepId: string } | { type: "group"; group: RegisterGroup };
export const partKey = (part: Part) => part.type === "step" ? `step:${part.stepId}` : `group:${part.group}`;

// --- what the reviewer reads ----------------------------------------------------------------------------------------------------

/** Keys that only carry traceability or catalog bookkeeping; the reviewer needs the content, not these. */
const DROPPED = new Set(["requirementIds", "contextFieldIds", "referenceIds", "validationReason", "needsValidation", "pros", "cons"]);
const strip = (value: unknown, limit: number): unknown => typeof value === "string" ? cut(value, limit) : Array.isArray(value) ? value.map(item => strip(item, limit))
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !DROPPED.has(key)).map(([key, item]) => [key, strip(item, limit)])) : value;

/** The review reads the whole design in one request, and a long design is large (18 steps measured at about 220k characters of step text alone), so the
 * text the reviewer sees is shortened: enough of each statement to see what it claims, not all of it. The repair of a part carries that part in full. */
const CUT_CHARS = { trigger: 160, rule: 170, exception: 110, effect: 190, implementation: 280, action: 90, document: 70, register: 220 } as const;
/** The review request is kept under this many characters of design (about 35k tokens): the text limits below are scaled down together until it fits. */
export const MAX_REVIEW_DESIGN_CHARS = 120_000;
const SCALES = [1, 0.7, 0.5, 0.35, 0.25] as const;
const MAX_ACTIONS = 4;
const cut = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

/** The design as the reviewer reads it: every step with shortened operational text, every register row with its content, the coverage table and the open
 * questions. Acceptance tests keep only their id and kind; traceability arrays and catalog bookkeeping are left out. */
export function compactDesign(design: DetailedDesign, maxChars = MAX_REVIEW_DESIGN_CHARS) {
  const fits = SCALES.map(scale => compactAt(design, scale));
  return fits.find(compact => JSON.stringify(compact).length <= maxChars) ?? fits[fits.length - 1]!;
}

function compactAt(design: DetailedDesign, scale: number) {
  const c = (value: string, limit: number) => cut(value, Math.max(40, Math.round(limit * scale)));
  const registers = Object.fromEntries(REGISTER_KEYS.flatMap(key => design[key] ? [[key, strip(design[key], Math.max(40, Math.round(CUT_CHARS.register * scale)))]] : []));
  return {
    processName: design.processName,
    steps: design.steps.map(step => ({
      id: step.id, title: step.title, requirementIds: step.requirementIds, enablesStepIds: step.enablesStepIds, actor: step.actor, trigger: c(step.trigger, CUT_CHARS.trigger),
      stepType: step.stepType, phase: step.phase, interimProcess: step.interimProcess,
      inputDocuments: step.inputDocuments.map(item => c(item, CUT_CHARS.document)), outputDocuments: step.outputDocuments.map(item => c(item, CUT_CHARS.document)),
      actions: step.actions.slice(0, MAX_ACTIONS).map(action => c(`${action.actor} in ${action.system}: ${action.operation}`, CUT_CHARS.action)),
      businessRules: step.businessRules.map(rule => ({ id: rule.id, condition: c(rule.condition, CUT_CHARS.rule), response: c(rule.response, CUT_CHARS.rule) })),
      exceptions: step.exceptions.map(item => c(`${item.condition} -> ${item.response}`, CUT_CHARS.exception)),
      effects: Object.fromEntries(Object.entries(step.effects).map(([key, value]) => [key, c(value, CUT_CHARS.effect)])),
      implementation: { kind: step.implementation.kind, detail: c(step.implementation.detail, CUT_CHARS.implementation) }, decisionIds: step.decisionIds,
      acceptanceTests: step.acceptanceTests.map(test => `${test.id} (${test.kind})`),
    })),
    coverage: design.coverage.map(({ requirementId, disposition, stepIds }) => ({ requirementId, disposition, stepIds })),
    openQuestions: design.openQuestions.map(({ id, question, affectedStepIds }) => ({ id, question: c(question, CUT_CHARS.rule), affectedStepIds })),
    ...registers,
  };
}

// --- routing ----------------------------------------------------------------------------------------------------------------------

/** Which step or register group each element id belongs to: steps and their rules and tests, register rows, and register names. Everything else (requirements, questions) is design-wide. */
function routes(design: DetailedDesign): ReadonlyMap<string, { part?: Part; path: string }> {
  const map = new Map<string, { part?: Part; path: string }>();
  design.steps.forEach((step, i) => {
    const part: Part = { type: "step", stepId: step.id }, path = `draft.steps.${i}`;
    for (const id of [step.id, ...step.businessRules.map(rule => rule.id), ...step.acceptanceTests.map(test => test.id)]) map.set(id, { part, path });
  });
  for (const key of REGISTER_KEYS) {
    const group = groupOf(key);
    if (!group || !design[key]) continue;
    map.set(key, { part: { type: "group", group }, path: `draft.${key}` });
    (design[key] as { id?: string }[]).forEach((row, i) => { if (row.id) map.set(row.id, { part: { type: "group", group }, path: `draft.${key}.${i}` }); });
  }
  return map;
}

/** Routes each finding to the steps and register groups its paths name. Unknown ids are ignored; a finding with none left concerns the design as a whole. */
export function routeFindings(design: DetailedDesign, findings: readonly ReviewFinding[]): RoutedFinding[] {
  const known = routes(design);
  return findings.map(finding => {
    const hits = finding.paths.flatMap(path => known.get(path.split(".")[0]!) ?? []);
    const parts = [...new Map(hits.flatMap(hit => hit.part ? [[partKey(hit.part), hit.part] as const] : [])).values()];
    return { ...finding, parts, blockerPath: hits[0]?.path ?? "draft", outcome: "UNRESOLVED" as const };
  });
}

/** The blockers for findings that stay open: kind in the code, the element in the path, the reviewer's sentence as the detail. */
export const reviewBlockers = (findings: readonly Pick<RoutedFinding, "kind" | "blockerPath" | "explanation" | "outcome">[] | undefined) =>
  (findings ?? []).filter(finding => finding.outcome === "UNRESOLVED").map(finding =>
    ({ code: `REVIEW_${finding.kind}`, path: finding.blockerPath, detail: finding.explanation.slice(0, EXPLANATION_MAX_CHARS) }));

/** The repair note for one part: the findings that concern it, in the reviewer's words (it is the model's own text about the model's own design, never client input). */
export function repairNote(part: Part, findings: readonly ReviewFinding[]): string {
  const lines = findings.slice(0, 6).map(finding => `[${finding.kind}] ${finding.explanation} (elements: ${finding.paths.join(", ")})`);
  const what = part.type === "step" ? `step ${part.stepId}` : `register group ${part.group} (${(REGISTER_GROUPS[part.group] as readonly RegisterKey[]).join(", ")})`;
  return `A reviewer read the whole finished design and reported the following about ${what}: ${lines.join(" ")} Rewrite the complete answer so that each finding no longer holds, changing only what that needs and keeping every other field exactly as in "currentAnswer". If a finding is about another part, make this part consistent with it without inventing facts.`;
}
