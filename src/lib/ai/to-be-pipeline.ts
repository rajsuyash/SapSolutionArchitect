import { z } from "zod";
import { contextForStep } from "../company-context";
import { phase } from "./design-primitives";
import { DetailedDesignSchema, EFFECTS_SHAPE, IMPLEMENTATION_KINDS, STEP_TYPES, draftIssues, evaluateDesign, id, ids, list, text,
  type DesignContext, type DetailedDesign } from "./design-quality";
import { LATE_GROUPS, REGISTER_GROUPS, REGISTER_GROUP_NAMES, RegisterGroupSchemas, groupOf, type RegisterGroup, type RegisterPayloads } from "./design-registers";
import type { ValidationIssue } from "./problem-analysis";
import { repairOutlineLinks, repairOutlineShape, restoreFromPrevious } from "./outline-repair";
import { allowedKinds, applyOutlinePatch, isPatchable, locate, type OutlinePatch } from "./outline-patch";
import { noCatalogNote } from "../sap-releases";
import { normalizeToolInput } from "./tool-input-normalizer";
import { repairRegisterGroup, repairStepBody } from "./part-repair";
import { toBeContext, validateToBeOutput, type ToBeInput, type ToBeOutput } from "./to-be";
import { extractSapCodes, textFields } from "./design-text-lint";
import { ReviewSchema, compactDesign, partKey, repairNote, routeFindings, reviewBlockers, type Part, type RoutedFinding, type ReviewOutcome } from "./to-be-review";
import { collectTargets, explainBlocker, findingLine, fixNote, newStepNote, partPath } from "./to-be-fix";

/** Skeleton-then-expansion To-Be generation. A slow model cannot emit a whole design inside the stage budget, so the model
 * first returns an outline (steps, traceability, coverage, questions), then one small call per step fills in the operational
 * detail, and eight register calls (decisions, fit-gap, foundation, integration, scope, reporting, documents, governance) add the
 * solution-design registers. All but documents and governance run in parallel with the steps; those two need the finished step bodies
 * (actors, output documents, rule ids) and run once the steps are in. The assembled result is a schemaVersion 3 DetailedDesign,
 * validated by the same checks as a one-shot design. */

export type Substage = "to_be_outline" | "to_be_step" | "to_be_registers" | "to_be_review" | "to_be_fix";

export const OutlineSchema = z.strictObject({
  schemaVersion: z.literal(1), processName: text,
  steps: list(z.strictObject({
    id, sequence: z.number().int().positive(), title: text, purpose: text,
    asIsStepIds: ids, requirementIds: ids, enablesStepIds: DetailedDesignSchema.shape.steps.element.shape.enablesStepIds,
    implementation: z.strictObject({ kind: z.enum(IMPLEMENTATION_KINDS), referenceIds: ids }),
  })).min(1),
  eliminatedAsIsSteps: DetailedDesignSchema.shape.eliminatedAsIsSteps,
  coverage: DetailedDesignSchema.shape.coverage,
  conflictDecisions: DetailedDesignSchema.shape.conflictDecisions,
  openQuestions: DetailedDesignSchema.shape.openQuestions,
});
export type Outline = z.infer<typeof OutlineSchema>;

/** What the model sends to repair a few flagged outline items: whole replacement items, matched by id or key (steps and open questions
 * by id, coverage by requirementId, eliminated As-Is steps by asIsStepId); an item with no match is added. See outline-patch.ts. */
export const OutlinePatchSchema = z.strictObject({
  steps: z.array(OutlineSchema.shape.steps.element).min(1).max(200).optional(),
  coverage: z.array(OutlineSchema.shape.coverage.element).min(1).max(200).optional(),
  openQuestions: z.array(OutlineSchema.shape.openQuestions.element).min(1).max(200).optional(),
  eliminatedAsIsSteps: z.array(OutlineSchema.shape.eliminatedAsIsSteps.element).min(1).max(200).optional(),
  remove: z.strictObject({
    coverageRequirementIds: z.array(z.string()).min(1).max(200).optional(),
    stepIds: z.array(z.string()).min(1).max(200).optional(),
    openQuestionIds: z.array(z.string()).min(1).max(200).optional(),
  }).optional(),
}).refine(patch => [patch.steps, patch.coverage, patch.openQuestions, patch.eliminatedAsIsSteps, ...Object.values(patch.remove ?? {})].some(items => items?.length),
  "a patch must replace, add or remove at least one item");
type OutlineStep = Outline["steps"][number];

/** Longest implementation.detail a step answer may carry. The prompt asks for about 600 characters; the rest is slack, not a target. */
export const IMPLEMENTATION_DETAIL_MAX_CHARS = 900;
/** Everything in a design step that the outline does not already fix. Derived from DetailedDesignSchema so the two cannot drift. */
export const StepDetailSchema = DetailedDesignSchema.shape.steps.element
  .omit({ id: true, sequence: true, title: true, asIsStepIds: true, requirementIds: true, enablesStepIds: true, implementation: true })
  .extend({ implementation: z.strictObject({ detail: text.max(IMPLEMENTATION_DETAIL_MAX_CHARS) }),
    // Required in a step answer; optional in a stored design, whose older steps predate it.
    effects: z.strictObject({ ...EFFECTS_SHAPE, accountingEntry: text }),
    // Required in a step answer; optional in a stored design, whose version 1 and 2 steps predate them.
    stepType: z.enum(STEP_TYPES), phase, interimProcess: text.nullable() });
export type StepDetail = z.infer<typeof StepDetailSchema>;

/** What `ask` resolves to when the provider stopped on max_tokens: the answer was cut off, so it is neither parsed nor trusted. */
export const TRUNCATED = Symbol("truncated");
export const OUTPUT_TRUNCATED = "OUTPUT_TRUNCATED";
/** Added to a repair request whose previous answer was cut off. Fixed text: nothing the model wrote is echoed back. */
const TRUNCATION_NOTE = "Your previous answer was cut off because it reached the output limit. Answer again, more concisely: shorter text values, no repetition, and keep any internal reasoning brief.";
/** Tells the model, in every call, when no verified catalog backs this product and release. */
const catalogNote = (input: ToBeInput, references: DesignContext["references"]) =>
  references.length ? {} : { catalogNote: noCatalogNote(input.targetProduct, input.discovery.targetRelease) };
const MAX_NOTE_ISSUES = 30;
const article = (word: string) => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
/** One plain-language line per issue: where, and what kind of mistake. Codes and type names only, never anything the model wrote. */
const describeIssue = ({ path, code, detail }: ValidationIssue): string => {
  const kind = detail && /^invalid_type: expected ([a-z]+), received ([a-z]+)$/.exec(detail);
  return `${path}: ${kind ? `expected ${article(kind[1]!)}, got ${article(kind[2]!)}` : detail ? detail.replace(/^[a-z_]+: /, "") || code : code}`;
};
/** Added to a repair request: the paths and the kind of each issue (so the model can fix them) and, after a cut-off answer, how to shorten. */
const repairNotes = (errors: readonly ValidationIssue[]) => {
  if (!errors.length) return {};
  const lines = errors.filter(error => error.code !== OUTPUT_TRUNCATED).slice(0, MAX_NOTE_ISSUES).map(describeIssue);
  const parts = [...(lines.length ? [`Fix exactly these fields of your previous answer: ${lines.join("; ")}. Change only the listed fields; copy every other field exactly from your previous answer.`] : []),
    ...(errors.some(error => error.code === OUTPUT_TRUNCATED) ? [TRUNCATION_NOTE] : [])];
  return parts.length ? { repairNote: parts.join(" ") } : {};
};

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const quote = (value: unknown) => typeof value === "string" ? `"${value}"` : "(unknown id)";
/** Patch request notes: for each error, the item it points at (by the id the patch matches on), the issue kind and, where the answer is
 * computable, what is allowed. Ids and codes only, never anything the model wrote. */
function patchNotes(errors: readonly ValidationIssue[], outline: unknown, input: ToBeInput, references: DesignContext["references"]) {
  const item = (section: string, index: number): Obj | undefined => {
    const list = isObj(outline) ? outline[section] : undefined;
    return Array.isArray(list) && isObj(list[index]) ? list[index] : undefined;
  };
  const fitTypes = (step: Obj | undefined) => {
    const cited = isObj(step?.implementation) && Array.isArray(step.implementation.referenceIds) ? step.implementation.referenceIds : [];
    return [...new Set(cited.flatMap(ref => references.find(reference => reference.id === ref)?.fitType ?? []))];
  };
  const lines = errors.filter(error => error.code !== OUTPUT_TRUNCATED).slice(0, MAX_NOTE_ISSUES).map(error => {
    const at = locate(error.path), index = at?.index ?? -1;
    const label = !at ? "" : at.section === "asIsSteps" ? `As-Is step ${quote(input.discovery.asIsSteps[index]?.id)}`
      : at.section === "requirements" ? `requirement ${quote(input.discovery.requirements[index]?.id)}`
      : at.section === "steps" ? `step ${quote(item("steps", index)?.id)}` : at.section === "coverage" ? `coverage of requirement ${quote(item("coverage", index)?.requirementId)}`
      : at.section === "openQuestions" ? `open question ${quote(item("openQuestions", index)?.id)}` : `elimination of As-Is step ${quote(item("eliminatedAsIsSteps", index)?.asIsStepId)}`;
    const where = `${error.path} (${label})`;
    switch (error.code) {
      case "SAP_FIT_MISMATCH": {
        const types = fitTypes(item("steps", index)), kind = (item("steps", index)?.implementation as Obj | undefined)?.kind;
        return `${where}: SAP_FIT_MISMATCH. Kind ${String(kind)}; cited fit types ${types.join(", ") || "none"} -> allowed kinds: ${allowedKinds(types).join(", ")}; or change referenceIds so a cited reference has the fit type of the kind you want (EXTENSION and INTEGRATION need a cited reference of that same fit type; STANDARD and CONFIGURATION may cite no EXTENSION, INTEGRATION or LICENSE_DEPENDENT reference).`;
      }
      case "UNKNOWN_DECISION": return input.decisionRegister
        ? `${where}: UNKNOWN_DECISION. decisionIds may only cite ids from input.decisionRegister; remove the others.`
        : `${where}: UNKNOWN_DECISION. No decision register is supplied, so decisionIds must be empty; express the open policy as an open question and link it through questionIds.`;
      case "CONDITIONAL_UNLINKED": return `${where}: CONDITIONAL_UNLINKED. A CONDITIONAL row must list a decision (decisionIds, from the register) or an open question (questionIds): add the question to openQuestions and list its id, or change the disposition.`;
      case "AS_IS_UNCOVERED": return `${where}: AS_IS_UNCOVERED. No step traces this As-Is step and it is not eliminated: add its id to asIsStepIds of the step that realizes it, or add it to eliminatedAsIsSteps with a reason.`;
      case "REQUIREMENT_UNDISPOSITIONED": return `${where}: REQUIREMENT_UNDISPOSITIONED. Add a coverage row for this requirement.`;
      default: return `${describeIssue(error)} (${label}).`;
    }
  });
  return `Fix exactly these items of your previous outline (supplied as "outline"), and only these: ${lines.join(" ")} Answer with submit_to_be_outline_patch holding a replacement for each flagged item, and nothing else: a complete step object per flagged step (matched by id), a coverage row per flagged requirement (matched by requirementId), open questions (matched by id; a new id adds a question) and eliminatedAsIsSteps (matched by asIsStepId). To delete an item that should not exist (for example a coverage row whose requirementId is not an input requirement, or a surplus step or question), list its key under remove: coverageRequirementIds, stepIds or openQuestionIds. The server merges the patch onto the outline, so do not resend items that are not listed.`;
}

/** What the patch call sees of the last outline: each flagged item in full (the model has to change it) and every other item reduced to
 * its ids, links and kinds. Titles, purposes, rationales, questions and the process name are left out, so the repair request still
 * carries none of the model's prose beyond the items it is asked to fix. */
const OUTLINE_DIGEST = {
  steps: ["id", "sequence", "asIsStepIds", "requirementIds", "enablesStepIds", "implementation"],
  coverage: ["requirementId", "disposition", "stepIds", "decisionId", "decisionIds", "questionIds"],
  openQuestions: ["id", "affectedStepIds", "decisionIds"], eliminatedAsIsSteps: ["asIsStepId"], conflictDecisions: ["conflictId", "decisionId"],
} as const;
function outlineDigest(outline: unknown, errors: readonly ValidationIssue[]) {
  if (!isObj(outline)) return {};
  const flagged = new Set(errors.flatMap(error => { const at = locate(error.path); return at ? [`${at.section}.${at.index}`] : []; }));
  return Object.fromEntries(Object.entries(OUTLINE_DIGEST).map(([section, keys]) => [section, !Array.isArray(outline[section]) ? outline[section]
    : outline[section].map((item, i) => !isObj(item) || flagged.has(`${section}.${i}`) ? item : Object.fromEntries(keys.flatMap(key => key in item ? [[key, item[key]]] : [])))]));
}

/** Patch model input: the discovery, the catalog slice and the last outline the server checked (see outlineDigest), with the errors and where each one is. */
export function outlinePatchRequest(input: ToBeInput, references: DesignContext["references"], outline: unknown, validationErrors: ValidationIssue[]) {
  return { input, approvedDecisions: [] as never[], references: references.map(outlineReference), outline: outlineDigest(outline, validationErrors), validationErrors,
    ...catalogNote(input, references), repairNote: patchNotes(validationErrors, outline, input, references) };
}

/** The fix pass asks for a patch that adds the step(s) the design lacks. Unlike a repair patch it carries the whole last outline: the model has to see what exists to add to it. */
export function fixPatchRequest(input: ToBeInput, references: DesignContext["references"], outline: unknown, lines: readonly string[]) {
  return { input, approvedDecisions: [] as never[], references: references.map(outlineReference), outline, validationErrors: [] as ValidationIssue[],
    ...catalogNote(input, references), repairNote: newStepNote(lines) };
}

const PLACEHOLDER = "(filled in by the step call)";
const MAX_ERRORS = 30;
const MAX_ID_LENGTH = 64;
const rePath = (issues: ValidationIssue[], from: string, to: string): ValidationIssue[] =>
  issues.map(issue => ({ ...issue, path: issue.path === from || issue.path.startsWith(`${from}.`) ? to + issue.path.slice(from.length) : issue.path }));

/** The outline as a structurally complete design whose step bodies are inert placeholders that satisfy every per-step rule.
 * Running the unchanged design evaluator over it applies the trace, coverage, catalog-reference and SAP fit-ladder checks to the outline. */
function skeleton(outline: Outline): DetailedDesign {
  const steps = outline.steps.map((step): DetailedDesign["steps"][number] => ({
    id: step.id, sequence: step.sequence, title: step.title, asIsStepIds: step.asIsStepIds, requirementIds: step.requirementIds,
    ...(step.enablesStepIds && { enablesStepIds: step.enablesStepIds }),
    actor: PLACEHOLDER, trigger: PLACEHOLDER, inputDocuments: [PLACEHOLDER], outputDocuments: [PLACEHOLDER],
    actions: [{ actor: PLACEHOLDER, system: PLACEHOLDER, operation: PLACEHOLDER, fields: [PLACEHOLDER] }],
    businessRules: [{ id: `${step.id}-PH-BR`, condition: PLACEHOLDER, response: PLACEHOLDER }],
    exceptions: [], exceptionsNotApplicableReason: PLACEHOLDER,
    masterData: [{ object: PLACEHOLDER, fields: [PLACEHOLDER], owner: PLACEHOLDER }],
    effects: { inventory: PLACEHOLDER, financial: PLACEHOLDER, ownership: PLACEHOLDER },
    implementation: { kind: step.implementation.kind, detail: PLACEHOLDER, referenceIds: step.implementation.referenceIds },
    addedValue: PLACEHOLDER,
    acceptanceTests: [{ id: `${step.id}-PH-T`, kind: "NORMAL", given: PLACEHOLDER, when: PLACEHOLDER, then: PLACEHOLDER, requirementIds: step.requirementIds }],
  }));
  return { schemaVersion: 1, processName: outline.processName, steps, eliminatedAsIsSteps: outline.eliminatedAsIsSteps,
    coverage: outline.coverage, conflictDecisions: outline.conflictDecisions, openQuestions: outline.openQuestions };
}

/** `previous` is the shaped payload and issues of the attempt this one repairs; `shaped` is this attempt's payload after the deterministic repairs. */
export type OutlinePrevious = { value: unknown; issues: readonly ValidationIssue[] };
export function validateOutline(input: ToBeInput, references: DesignContext["references"], raw: unknown, previous?: OutlinePrevious):
  { success: true; outline: Outline; warnings: ValidationIssue[]; shaped: unknown } | { success: false; errors: ValidationIssue[]; shaped: unknown } {
  const normalized = normalizeToolInput(OutlineSchema, raw, "outline");
  const restored = previous ? restoreFromPrevious(previous, normalized.value) : { value: normalized.value, warnings: [] };
  const repaired = repairOutlineShape(input.discovery, new Set(references.map(reference => reference.id)), restored.value,
    new Set((input.decisionRegister ?? []).map(decision => decision.id)));
  const linked = repairOutlineLinks({ product: input.targetProduct, release: input.discovery.targetRelease ?? "UNKNOWN" }, references, repaired.value);
  const parsed = OutlineSchema.safeParse(linked.value);
  if (!parsed.success) return { success: false, errors: rePath(draftIssues(parsed.error.issues), "draft", "outline"), shaped: linked.value };
  const evaluation = evaluateDesign(toBeContext(input, references), skeleton(parsed.data));
  if (!evaluation.structurallyValid) return { success: false, errors: rePath(evaluation.errors, "draft", "outline").slice(0, MAX_ERRORS), shaped: linked.value };
  return { success: true, outline: parsed.data, warnings: [...normalized.warnings, ...restored.warnings, ...repaired.warnings, ...linked.warnings], shaped: linked.value };
}

/** Join the outline and the step bodies into a DetailedDesign. Parallel step calls cannot coordinate ids, so a business-rule or
 * test id already taken elsewhere is prefixed with its step id; a collision that cannot be fixed that way stays and fails validation. */
export function assemble(outline: Outline, details: ReadonlyMap<string, StepDetail>, registers?: ReadonlyMap<RegisterGroup, unknown>): DetailedDesign {
  const taken = new Set([...outline.steps.map(step => step.id), ...outline.openQuestions.map(question => question.id)]);
  const unique = (stepId: string, local: string) => {
    const candidate = taken.has(local) && `${stepId}-${local}`.length <= MAX_ID_LENGTH ? `${stepId}-${local}` : local;
    taken.add(candidate); return candidate;
  };
  const merged = registers && REGISTER_GROUP_NAMES.every(group => registers.has(group))
    ? Object.assign({}, ...REGISTER_GROUP_NAMES.map(group => registers.get(group))) as Partial<DetailedDesign> : undefined;
  return {
    schemaVersion: merged ? 3 : 1, processName: outline.processName, ...merged,
    steps: outline.steps.map(step => {
      const { implementation, businessRules, acceptanceTests, ...rest } = details.get(step.id)!;
      return {
        id: step.id, sequence: step.sequence, title: step.title, asIsStepIds: step.asIsStepIds, requirementIds: step.requirementIds,
        ...(step.enablesStepIds && { enablesStepIds: step.enablesStepIds }),
        ...rest,
        businessRules: businessRules.map(rule => ({ ...rule, id: unique(step.id, rule.id) })),
        implementation: { kind: step.implementation.kind, detail: implementation.detail, referenceIds: step.implementation.referenceIds },
        acceptanceTests: acceptanceTests.map(test => ({ ...test, id: unique(step.id, test.id) })),
      };
    }),
    eliminatedAsIsSteps: outline.eliminatedAsIsSteps, coverage: outline.coverage,
    conflictDecisions: outline.conflictDecisions, openQuestions: outline.openQuestions,
  };
}

/** Split whole-design errors into those a single step call or register call can fix and those that need the outline. */
export function attributeErrors(errors: ValidationIssue[], design: DetailedDesign):
  { byStep: Map<string, ValidationIssue[]>; byGroup: Map<RegisterGroup, ValidationIssue[]>; global: ValidationIssue[] } {
  const byStep = new Map<string, ValidationIssue[]>(), byGroup = new Map<RegisterGroup, ValidationIssue[]>(), global: ValidationIssue[] = [];
  const add = (index: number, issue: ValidationIssue) => {
    const stepId = design.steps[index]!.id;
    byStep.set(stepId, [...(byStep.get(stepId) ?? []), issue]);
  };
  for (const error of errors) {
    const step = /^draft\.steps\.(\d+)(?:\.|$)/.exec(error.path);
    const item = /^draft\.coverage\.(\d+)$/.exec(error.path);
    const group = groupOf(/^draft\.([A-Za-z]+)(?:\.|$)/.exec(error.path)?.[1] ?? "");
    if (group) byGroup.set(group, [...(byGroup.get(group) ?? []), error]);
    else if (step && design.steps[Number(step[1])]) add(Number(step[1]), error);
    else if (item && error.code === "CRITICAL_REQUIREMENT_UNTESTED" && design.coverage[Number(item[1])]) {
      const requirementId = design.coverage[Number(item[1])]!.requirementId;
      design.steps.forEach((candidate, i) => {
        if (candidate.requirementIds.includes(requirementId) && !candidate.acceptanceTests.some(test => test.requirementIds.includes(requirementId))) {
          add(i, { code: error.code, path: `draft.steps.${i}.acceptanceTests` });
        }
      });
      if (!design.steps.some(candidate => candidate.requirementIds.includes(requirementId))) global.push(error);
    } else global.push(error);
  }
  return { byStep, byGroup, global };
}

const OUTLINE_REFERENCE_OBJECTS = 8;
const OUTLINE_OBJECT_CHARS = 100;
/** The outline picks references by id and fit class; it needs the capability and a few object names to recognise a match, not the limitations
 * and evidence quotes (about 600 characters each). The step call that cites a reference receives it in full. */
export const outlineReference = ({ id, fitType, capability, objects }: DesignContext["references"][number]) =>
  ({ id, fitType, capability, objects: objects?.slice(0, OUTLINE_REFERENCE_OBJECTS).map(object => object.slice(0, OUTLINE_OBJECT_CHARS)) });

/** Outline model input: the discovery as saved, the decision register, and the catalog as a compact id/fit/capability/objects slice. */
export function outlineRequest(input: ToBeInput, references: DesignContext["references"], validationErrors: ValidationIssue[]) {
  return { input, approvedDecisions: [] as never[], references: references.map(outlineReference),
    validationErrors, ...catalogNote(input, references), ...repairNotes(validationErrors) };
}

/** Per-step model input: the frozen outline plus only this step's requirements, the sources they quote, the references it cites. */
/** A consistency-pass repair: the reviewer's findings about this part in `note`, and the part's present answer, which the model changes as little as it can. */
export type PartRepair = { note: string; current: unknown };
export function stepRequest(input: ToBeInput, references: DesignContext["references"], outline: Outline, step: OutlineStep, validationErrors: ValidationIssue[], repair?: PartRepair) {
  const { discovery } = input;
  const requirements = discovery.requirements.filter(requirement => step.requirementIds.includes(requirement.id));
  const asIsSteps = discovery.asIsSteps.filter(asIs => step.asIsStepIds.includes(asIs.id));
  const sourceIds = new Set([...requirements.map(r => r.evidence.sourceId), ...asIsSteps.map(a => a.evidence.sourceId)]);
  return {
    targetProduct: input.targetProduct, targetRelease: discovery.targetRelease, variantName: discovery.variantName,
    ...(input.sharedRules && { sharedRules: input.sharedRules }),
    ...(input.decisionRegister && { decisionRegister: input.decisionRegister }),
    ...(contextForStep(discovery.companyContext).length && { companyContext: contextForStep(discovery.companyContext) }),
    outline: { processName: outline.processName, steps: outline.steps,
      coverage: outline.coverage.filter(item => step.requirementIds.includes(item.requirementId)),
      conflictDecisions: outline.conflictDecisions, openQuestions: outline.openQuestions },
    step, asIsSteps,
    // An enabling step has no requirement of its own: it sees what the steps it enables must achieve, to design for them.
    ...(step.enablesStepIds?.length && { enables: outline.steps.filter(other => step.enablesStepIds!.includes(other.id)).map(other => ({
      id: other.id, title: other.title, purpose: other.purpose,
      requirements: discovery.requirements.filter(r => other.requirementIds.includes(r.id)).map(r => ({ id: r.id, statement: r.statement })) })) }),
    requirements: requirements.map(r => ({ id: r.id, asIsStepId: r.asIsStepId, critical: r.critical, kind: r.kind,
      statement: r.statement, sourceId: r.evidence.sourceId, quote: r.evidence.quote })),
    sources: discovery.sources.filter(source => sourceIds.has(source.id)).map(({ id, locator, text }) => ({ id, locator, text })),
    conflicts: discovery.conflicts.filter(conflict => conflict.sourceIds.some(sourceId => sourceIds.has(sourceId))),
    inputOpenQuestions: discovery.openQuestions,
    references: references.filter(reference => step.implementation.referenceIds.includes(reference.id)),
    approvedDecisions: [], validationErrors, ...catalogNote(input, references), ...repairNotes(validationErrors),
    ...(repair && { repairNote: repair.note, currentAnswer: repair.current }),
  };
}

const NO_CATALOG_GROUPS: readonly RegisterGroup[] = ["scope", "governance"];

/** What the late register groups (documents, governance) read of the finished steps: who acts, which documents come out, which rules exist.
 * Taken from the assembled steps so rule ids are the final ones. */
export const stepDigest = (steps: DetailedDesign["steps"]) => steps.map(step => ({
  id: step.id, title: step.title, actor: step.actor, actionActors: [...new Set(step.actions.map(action => action.actor))],
  inputDocuments: step.inputDocuments, outputDocuments: step.outputDocuments, stepType: step.stepType,
  codes: [...new Set(textFields(step).flatMap(extractSapCodes).map(code => `${code.kind.toLowerCase().replace("_", " ")} ${code.token}`))],
  businessRules: step.businessRules.map(rule => ({ id: rule.id, condition: rule.condition })),
}));

/** Per-group register input: the frozen outline, every answered company-context field, all requirements and the catalog's
 * objects. No source text, no evidence quotes. The early groups see no step bodies (the step calls run in parallel and are not available
 * yet); the late groups also get the finished steps as a digest. */
export function registerRequest(input: ToBeInput, references: DesignContext["references"], outline: Outline, group: RegisterGroup, validationErrors: ValidationIssue[],
  steps?: DetailedDesign["steps"], repair?: PartRepair) {
  const { discovery } = input;
  return {
    group, registerKeys: REGISTER_GROUPS[group],
    targetProduct: input.targetProduct, targetRelease: discovery.targetRelease, variantName: discovery.variantName,
    companyContext: (discovery.companyContext ?? []).map(({ fieldId, label, value }) => ({ fieldId, label, value })),
    outline: { processName: outline.processName, steps: outline.steps, coverage: outline.coverage, openQuestions: outline.openQuestions },
    requirements: discovery.requirements.map(r => ({ id: r.id, asIsStepId: r.asIsStepId, critical: r.critical, kind: r.kind, statement: r.statement })),
    // The catalog is the largest part of a register request. Scope and governance rows carry no SAP basis, so they are not sent it.
    ...(NO_CATALOG_GROUPS.includes(group) ? {} : { references: references.map(({ id, fitType, capability, objects }) => ({ id, fitType, capability, objects })) }),
    ...(steps && { steps: stepDigest(steps) }),
    inputOpenQuestions: discovery.openQuestions, validationErrors, ...catalogNote(input, references), ...repairNotes(validationErrors),
    ...(repair && { repairNote: repair.note, currentAnswer: repair.current }),
  };
}

/** Consistency-pass input: the finished design in compact form, what the business asked for, and the answered company context to check it against. */
export function reviewRequest(input: ToBeInput, design: DetailedDesign) {
  const { discovery } = input;
  return {
    targetProduct: input.targetProduct, targetRelease: discovery.targetRelease, variantName: discovery.variantName,
    companyContext: (discovery.companyContext ?? []).map(({ fieldId, value }) => ({ fieldId, value })),
    requirements: discovery.requirements.map(r => ({ id: r.id, kind: r.kind, critical: r.critical, statement: r.statement })),
    design: compactDesign(design),
  };
}

/** Run `worker` over `items` with at most `limit` in flight. After the first failure nothing new starts; the rest settle, then it rethrows. */
export async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0, failure: { error: unknown } | undefined;
  const lane = async () => {
    while (!failure && next < items.length) {
      try { await worker(items[next++]!); } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure.error;
}

export type DesignDeps = {
  /** One model call; resolves to the tool payload, null when the provider did not return exactly one complete tool call, or TRUNCATED when it stopped on max_tokens. */
  ask: (substage: Substage, user: unknown, group?: RegisterGroup | "patch", options?: { thinking?: boolean }) => Promise<unknown>;
  /** The error to throw for AI_INVALID_OUTPUT. */
  invalid: () => Error;
  /** Record the issues of one failed attempt in the stage metrics. */
  record: (issues: ValidationIssue[]) => void;
  /** Record the deterministic repairs the server applied to an accepted call (warnings, not errors). */
  warn?: (issues: ValidationIssue[]) => void;
  /** Eval only: the raw payload of a call that failed validation, with the call it answered. */
  rawFailure?: (substage: Substage, key: string, payload: unknown) => void;
  parallelism: number;
  /** Outline repairs allowed (AI_TO_BE_OUTLINE_REPAIRS). Default 2. */
  maxOutlineRepairs?: number;
  /** Re-requests allowed per step or register call (AI_TO_BE_PART_REPAIRS). Default 2. */
  maxPartRepairs?: number;
  /** Fraction (0-1) of the stage budget still unspent. Default 1. */
  remainingBudget?: () => number;
  /** Run the consistency pass on a valid design (AI_TO_BE_REVIEW). Default false here; the stage runner turns it on unless the operator switched it off. */
  review?: boolean;
  /** Most parts the fix pass may send back (AI_TO_BE_FIX_MAX_PARTS). Default 0 here (off); the stage runner passes the operator's value, default 8. */
  maxFixParts?: number;
};

/** The first outline repair is always allowed; each further one only while more than this share of the stage budget remains. */
export const EXTRA_OUTLINE_REPAIR_MIN_REMAINING = 0.5;
/** A step body that still fails after its repairs gets one last call with model reasoning on, only while more than this share of the stage budget remains. */
export const THINKING_RETRY_MIN_REMAINING = 0.25;
/** The consistency pass, and each repair it triggers, only starts while more than this share of the stage budget remains. */
export const REVIEW_MIN_REMAINING = 0.25;
/** Step and register-group repairs one consistency pass may spend: one per affected part, at most this many parts. */
export const MAX_REVIEW_REPAIRS = 6;
/** The fix pass only starts while more than this share of the stage budget remains; adding a step through an outline patch needs more. */
export const FIX_MIN_REMAINING = 0.25;
export const FIX_PATCH_MIN_REMAINING = 0.4;
export const outlineRepairAllowed = (done: number, max: number, remaining: number) =>
  done < max && (done === 0 || remaining > EXTRA_OUTLINE_REPAIR_MIN_REMAINING);

export async function runDesign(input: ToBeInput, references: DesignContext["references"], deps: DesignDeps): Promise<ToBeOutput> {
  let outlineRepairs = 0;
  const canRepairOutline = () => outlineRepairAllowed(outlineRepairs, deps.maxOutlineRepairs ?? 2, deps.remainingBudget?.() ?? 1);
  let lastShaped: unknown;
  const settle = (raw: unknown, key: string, result: ReturnType<typeof validateOutline>) => {
    // A cut-off answer has no shaped payload; the last one stays the reference for the next restore.
    if ("shaped" in result) lastShaped = result.shaped;
    if (!result.success) { deps.record(result.errors); if (raw !== TRUNCATED) deps.rawFailure?.("to_be_outline", key, raw); }
    else if (result.warnings.length) deps.warn?.(result.warnings);
    return result;
  };
  const requestOutline = async (errors: ValidationIssue[]) => {
    const raw = await deps.ask("to_be_outline", outlineRequest(input, references, errors));
    return settle(raw, "outline", raw === TRUNCATED ? { success: false as const, errors: [{ path: "to_be_outline", code: OUTPUT_TRUNCATED }], shaped: lastShaped }
      : validateOutline(input, references, raw, errors.length && lastShaped !== undefined ? { value: lastShaped, issues: errors } : undefined));
  };
  /** Ask for a patch of the flagged items, merge it onto the last outline and validate the merge. A patch that is cut off, missing or
   * fails its schema is a failed repair that leaves the errors (and the last outline) as they were. */
  const requestPatch = async (errors: ValidationIssue[]) => {
    const raw = await deps.ask("to_be_outline", outlinePatchRequest(input, references, lastShaped, errors), "patch");
    const normalized = raw === TRUNCATED || raw === null ? undefined : normalizeToolInput(OutlinePatchSchema, raw, "outline.patch");
    const parsed = normalized ? OutlinePatchSchema.safeParse(normalized.value) : undefined;
    if (!normalized || !parsed || !parsed.success) {
      const issues = raw === TRUNCATED ? [{ path: "to_be_outline", code: OUTPUT_TRUNCATED }] : parsed && !parsed.success
        ? rePath(draftIssues(parsed.error.issues), "draft", "outline.patch") : [{ path: "to_be_outline", code: "NO_TOOL_PAYLOAD" }];
      deps.record(issues);
      if (raw !== TRUNCATED && raw !== null) deps.rawFailure?.("to_be_outline", "outline-patch", raw);
      return { success: false as const, errors, shaped: lastShaped };
    }
    if (normalized.warnings.length) deps.warn?.(normalized.warnings);
    return settle(raw, "outline-patch", validateOutline(input, references, applyOutlinePatch(lastShaped, parsed.data as OutlinePatch)));
  };
  /** Errors that all point into named items of the last outline take a patch; anything global takes the whole outline again. */
  const repairOutline = (errors: ValidationIssue[]) => {
    const here = rePath(errors, "draft", "outline");
    return lastShaped !== undefined && isPatchable(here, lastShaped) ? requestPatch(here) : requestOutline(errors);
  };
  // The outline gets up to maxOutlineRepairs repairs (the second only while the stage budget is more than half unspent): errors only, never the model's own text.
  let first = await requestOutline([]);
  while (!first.success && canRepairOutline()) { outlineRepairs++; first = await repairOutline(first.errors); }
  if (!first.success) throw deps.invalid();
  let outline = first.outline;

  const details = new Map<string, StepDetail>(), registers = new Map<RegisterGroup, unknown>(), retries = new Map<string, number>();
  const registerKey = (group: RegisterGroup) => `register:${group}`;
  const warnAll = (...lists: ValidationIssue[][]) => { const all = lists.flat(); if (all.length) deps.warn?.(all); };
  const decisionIds = new Set((input.decisionRegister ?? []).map(decision => decision.id));
  const requirementIds = new Set(input.discovery.requirements.map(requirement => requirement.id));
  const isLate = (group: RegisterGroup) => (LATE_GROUPS as readonly string[]).includes(group);
  // Re-requests per call in total (AI_TO_BE_PART_REPAIRS, the second only while the stage budget is more than half unspent),
  // whether the answer failed its schema or the assembled design's checks.
  const markRetry = (key: string) => {
    const done = retries.get(key) ?? 0;
    if (!outlineRepairAllowed(done, deps.maxPartRepairs ?? 2, deps.remainingBudget?.() ?? 1)) throw deps.invalid();
    retries.set(key, done + 1);
  };

  /** One step answer, read the way every step answer is: normalised, its decision ids repaired, parsed. `errors` is what the next request carries when it does not parse. */
  const readStep = (current: Outline, stepId: string, raw: unknown) => {
    const index = current.steps.findIndex(step => step.id === stepId), path = `draft.steps.${index}`;
    const normalized = normalizeToolInput(StepDetailSchema, raw, path);
    const repaired = repairStepBody(normalized.value, decisionIds, path);
    const parsed = StepDetailSchema.safeParse(repaired.value);
    if (parsed.success) return { ok: true as const, value: parsed.data, warnings: [normalized.warnings, repaired.warnings] };
    return { ok: false as const, errors: raw === TRUNCATED ? [{ path, code: OUTPUT_TRUNCATED }] : raw === null ? [{ path, code: "NO_TOOL_PAYLOAD" }] : rePath(draftIssues(parsed.error.issues), "draft", path) };
  };
  /** The same for one register group. */
  const readGroup = (current: Outline, group: RegisterGroup, raw: unknown) => {
    const normalized = normalizeToolInput(RegisterGroupSchemas[group], raw, "draft");
    const repaired = repairRegisterGroup(normalized.value, { requirementIds, stepIds: new Set(current.steps.map(step => step.id)), decisionIds });
    const parsed = RegisterGroupSchemas[group].safeParse(repaired.value);
    if (parsed.success) return { ok: true as const, value: parsed.data satisfies RegisterPayloads[RegisterGroup], warnings: [normalized.warnings, repaired.warnings] };
    return { ok: false as const, errors: raw === TRUNCATED ? [{ path: "draft", code: OUTPUT_TRUNCATED }] : raw === null ? [{ path: "draft", code: "NO_TOOL_PAYLOAD" }] : draftIssues(parsed.error.issues) };
  };

  /** Steps and register groups are independent calls over the frozen outline, so they share one bounded pool. */
  const expand = async (stepIds: readonly string[], groups: readonly RegisterGroup[], errors: ReadonlyMap<string, ValidationIssue[]>) => {
    const current = outline;
    const expandStep = async (stepId: string) => {
      const index = current.steps.findIndex(step => step.id === stepId);
      let validationErrors = errors.get(stepId) ?? [], thinking = false;
      for (;;) {
        const raw = await deps.ask("to_be_step", stepRequest(input, references, current, current.steps[index]!, validationErrors), undefined, thinking ? { thinking } : undefined);
        const result = readStep(current, stepId, raw);
        if (result.ok) { details.set(stepId, result.value); warnAll(...result.warnings); return; }
        if (raw !== TRUNCATED && raw !== null) deps.rawFailure?.("to_be_step", stepId, raw);
        validationErrors = result.errors;
        deps.record(validationErrors);
        if (!thinking && (deps.maxPartRepairs ?? 2) > 0 && !outlineRepairAllowed(retries.get(stepId) ?? 0, deps.maxPartRepairs ?? 2, deps.remainingBudget?.() ?? 1)
          && (deps.remainingBudget?.() ?? 1) > THINKING_RETRY_MIN_REMAINING) {
          // Retries spent: one more call with reasoning on, for this step only. Its failure ends the stage like any exhausted retry.
          thinking = true;
          deps.warn?.([{ code: "RETRIED_WITH_THINKING", path: `draft.steps.${index}` }]);
          continue;
        }
        if (thinking) throw deps.invalid();
        markRetry(stepId);
      }
    };
    const expandGroup = async (group: RegisterGroup) => {
      let validationErrors = errors.get(registerKey(group)) ?? [];
      // A late group reads the finished steps; by the time it runs every step of `current` is in `details`.
      const steps = isLate(group) ? assemble(current, details).steps : undefined;
      for (;;) {
        const raw = await deps.ask("to_be_registers", registerRequest(input, references, current, group, validationErrors, steps), group);
        const result = readGroup(current, group, raw);
        if (result.ok) { registers.set(group, result.value); warnAll(...result.warnings); return; }
        if (raw !== TRUNCATED && raw !== null) deps.rawFailure?.("to_be_registers", group, raw);
        validationErrors = result.errors;
        deps.record(validationErrors);
        markRetry(registerKey(group));
      }
    };
    await runPool([...groups.filter(group => !isLate(group)).map(group => () => expandGroup(group)), ...stepIds.map(stepId => () => expandStep(stepId))],
      deps.parallelism, task => task());
    await runPool(groups.filter(isLate).map(group => () => expandGroup(group)), deps.parallelism, task => task());
  };

  /** One repair of one part: the note says what is open, the part's present answer travels with it. Resolves to the parsed answer, or undefined when the call failed, was cut off or did not parse.
   * `fix` marks a call of the fix pass (substage to_be_fix), otherwise it belongs to the consistency pass. */
  type Proposal = { part: Part; step?: StepDetail; group?: RegisterPayloads[RegisterGroup] };
  const propose = async (part: Part, note: string, fix: boolean): Promise<Proposal | undefined> => {
    const current = outline, tag = fix ? "fix" : "review";
    try {
      if (part.type === "step") {
        const step = current.steps.find(candidate => candidate.id === part.stepId)!;
        const raw = await deps.ask(fix ? "to_be_fix" : "to_be_step", stepRequest(input, references, current, step, [], { note, current: details.get(part.stepId) }));
        const result = readStep(current, part.stepId, raw);
        if (result.ok) { warnAll(...result.warnings); return { part, step: result.value }; }
        if (raw !== TRUNCATED && raw !== null) deps.rawFailure?.(fix ? "to_be_fix" : "to_be_step", `${part.stepId}-${tag}`, raw);
      } else {
        const steps = isLate(part.group) ? assemble(current, details).steps : undefined;
        const raw = await deps.ask(fix ? "to_be_fix" : "to_be_registers", registerRequest(input, references, current, part.group, [], steps, { note, current: registers.get(part.group) }), part.group);
        const result = readGroup(current, part.group, raw);
        if (result.ok) { warnAll(...result.warnings); return { part, group: result.value }; }
        if (raw !== TRUNCATED && raw !== null) deps.rawFailure?.(fix ? "to_be_fix" : "to_be_registers", `${part.group}-${tag}`, raw);
      }
    } catch { /* a failed repair leaves its findings open; the stage still has its design */ }
    return undefined;
  };
  /** Parts the consistency pass already sent back once: the fix pass does not send their review findings again. */
  const reviewTried = new Set<string>();

  /** The consistency pass. A valid design is read once as a whole; each finding that names a step or register group sends that part back once with the finding as its
   * repair note, and a repair is kept only if the whole design is still valid with it. Findings that name no part, parts the repair could not fix and findings beyond the
   * repair limit stay as review findings. The pass never fails the stage: a design that was valid before it is valid after it. */
  const reviewed = async (data: ToBeOutput, design: DetailedDesign): Promise<ToBeOutput> => {
    const skip = (code: string) => { deps.warn?.([{ code, path: "to_be_review" }]); return data; };
    if (!deps.review) return data;
    if ((deps.remainingBudget?.() ?? 1) <= REVIEW_MIN_REMAINING) return skip("REVIEW_SKIPPED_BUDGET");
    let found;
    try {
      const raw = await deps.ask("to_be_review", reviewRequest(input, design));
      if (raw === TRUNCATED || raw === null) return skip(raw === null ? "REVIEW_NO_PAYLOAD" : OUTPUT_TRUNCATED);
      const normalized = normalizeToolInput(ReviewSchema, raw, "review");
      const parsed = ReviewSchema.safeParse(normalized.value);
      if (!parsed.success) return skip("REVIEW_INVALID_OUTPUT");
      found = parsed.data.findings;
    } catch { return skip("REVIEW_FAILED"); }
    const findings: RoutedFinding[] = routeFindings(design, found);
    const byPart = new Map<string, { part: Part; findings: RoutedFinding[] }>();
    for (const finding of findings) for (const part of finding.parts) {
      const entry = byPart.get(partKey(part)) ?? { part, findings: [] };
      entry.findings.push(finding); byPart.set(partKey(part), entry);
    }
    const parts = [...byPart.values()].slice(0, MAX_REVIEW_REPAIRS);
    const current = outline;
    const proposals = new Map<string, Proposal>();
    if ((deps.remainingBudget?.() ?? 1) > REVIEW_MIN_REMAINING) {
      for (const { part } of parts) reviewTried.add(partKey(part));
      await runPool(parts, deps.parallelism, async ({ part, findings: concerned }) => {
        const proposal = await propose(part, repairNote(part, concerned), false);
        if (proposal) proposals.set(partKey(part), proposal);
      });
    }
    // Adopt each proposal on its own, and only when the whole design is still valid with it.
    let result = data, finalDesign = design;
    const adopted = new Set<string>();
    for (const { part } of parts) {
      const proposal = proposals.get(partKey(part));
      if (!proposal) continue;
      const priorStep = part.type === "step" ? details.get(part.stepId) : undefined, priorGroup = part.type === "group" ? registers.get(part.group) : undefined;
      if (proposal.step && part.type === "step") details.set(part.stepId, proposal.step);
      if (proposal.group && part.type === "group") registers.set(part.group, proposal.group);
      const trial = assemble(current, details, registers), validated = validateToBeOutput(input, trial, references);
      if (validated.success) {
        result = validated.data; finalDesign = trial; adopted.add(partKey(part));
        deps.warn?.([{ code: "REVIEW_REPAIRED", path: part.type === "step" ? `draft.steps.${current.steps.findIndex(step => step.id === part.stepId)}` : `draft.${part.group}` }]);
      } else {
        if (part.type === "step" && priorStep) details.set(part.stepId, priorStep);
        if (part.type === "group" && priorGroup) registers.set(part.group, priorGroup);
        deps.warn?.([{ code: "REVIEW_REPAIR_REJECTED", path: partKey(part) }]);
      }
    }
    // A finding is resolved only when every part it names was repaired and kept. The blockers point into the final design.
    const open = routeFindings(finalDesign, found).map((routed, i) => ({ ...routed,
      outcome: findings[i]!.parts.length > 0 && findings[i]!.parts.every(part => adopted.has(partKey(part))) ? "REPAIRED" as const : "UNRESOLVED" as const }));
    const extra = reviewBlockers(open);
    const final = extra.length ? validateToBeOutput(input, finalDesign, references, extra) : undefined;
    deps.warn?.(open.map(finding => ({ code: `REVIEW_${finding.outcome}_${finding.kind}`, path: finding.blockerPath })));
    return { ...(final?.success ? final.data : result), reviewFindings: open.map(({ kind, paths, explanation, outcome, blockerPath }) => ({ kind, paths, explanation, outcome, blockerPath })) };
  };

  /** The fix pass, part by part: every fixable heuristic blocker and every unresolved review finding that names a part goes back to that part in ONE call (all findings
   * for the part in one note, at most `cap` parts). A repaired part is kept only if the whole design still validates, the blockers do not grow, and at least one of the
   * part's findings no longer fires (the heuristic checks run again on the trial design; a review finding cannot be re-run, so it counts as cleared by a kept repair).
   * Otherwise the original part and its blockers stay. */
  const fixParts = async (start: ToBeOutput, cap: number): Promise<{ data: ToBeOutput; used: number }> => {
    const { targets, routed } = collectTargets(start.design, start.evaluation.blockers, start.reviewFindings, reviewTried);
    const chosen = targets.slice(0, cap);
    if (!chosen.length) return { data: start, used: 0 };
    const proposals = new Map<string, Proposal>();
    await runPool(chosen, deps.parallelism, async ({ part, blockers, findingIndexes }) => {
      const lines = [...blockers.map(blocker => explainBlocker(blocker, start.design, input)), ...findingIndexes.map(i => findingLine(start.reviewFindings![i]!))];
      const proposal = await propose(part, fixNote(part, lines), true);
      if (proposal) proposals.set(partKey(part), proposal);
    });
    let data = start, findings = start.reviewFindings;
    const adopted = new Set<string>();
    for (const target of chosen) {
      const { part } = target, proposal = proposals.get(partKey(part)), path = partPath(part, start.design);
      if (!proposal) { deps.warn?.([{ code: "FIX_NO_PROPOSAL", path }]); continue; }
      const priorStep = part.type === "step" ? details.get(part.stepId) : undefined, priorGroup = part.type === "group" ? registers.get(part.group) : undefined;
      if (proposal.step && part.type === "step") details.set(part.stepId, proposal.step);
      if (proposal.group && part.type === "group") registers.set(part.group, proposal.group);
      const withPart = new Set([...adopted, partKey(part)]);
      const trialFindings = findings?.map((finding, i): ReviewOutcome => finding.outcome === "UNRESOLVED" && routed[i]!.parts.length > 0 && routed[i]!.parts.every(item => withPart.has(partKey(item)))
        ? { ...finding, outcome: "REPAIRED" } : finding);
      const validated = validateToBeOutput(input, assemble(outline, details, registers), references, reviewBlockers(trialFindings));
      const stillOpen = (blocker: { code: string; path: string }) => validated.success && validated.data.evaluation.blockers.some(item => item.code === blocker.code && item.path === blocker.path);
      const cleared = target.blockers.filter(blocker => !stillOpen(blocker)).length
        + (trialFindings ?? []).filter((finding, i) => finding.outcome === "REPAIRED" && findings![i]!.outcome === "UNRESOLVED").length;
      if (validated.success && cleared > 0 && validated.data.evaluation.blockers.length <= data.evaluation.blockers.length) {
        adopted.add(partKey(part)); findings = trialFindings;
        data = { ...validated.data, ...(findings && { reviewFindings: findings }) };
        deps.warn?.([{ code: "FIX_APPLIED", path }]);
      } else {
        if (part.type === "step" && priorStep) details.set(part.stepId, priorStep);
        if (part.type === "group" && priorGroup) registers.set(part.group, priorGroup);
        deps.warn?.([{ code: "FIX_REJECTED", path }]);
      }
    }
    return { data, used: chosen.length };
  };

  /** A finding that needs a step the design lacks: ONE outline patch, then only the new or changed steps are expanded again. Returns the design with the findings marked
   * repaired, or undefined when the patch, an expansion or the whole design's validation failed (the caller restores its snapshot). */
  const addSteps = async (data: ToBeOutput, indexes: readonly number[]): Promise<ToBeOutput | undefined> => {
    if (lastShaped === undefined) return undefined;
    const raw = await deps.ask("to_be_fix", fixPatchRequest(input, references, lastShaped, indexes.map(i => findingLine(data.reviewFindings![i]!))), "patch");
    if (raw === TRUNCATED || raw === null) return undefined;
    const parsed = OutlinePatchSchema.safeParse(normalizeToolInput(OutlinePatchSchema, raw, "outline.patch").value);
    if (!parsed.success) return undefined;
    const patched = validateOutline(input, references, applyOutlinePatch(lastShaped, parsed.data as OutlinePatch));
    if (!patched.success) return undefined;
    const before = new Map(outline.steps.map(step => [step.id, JSON.stringify(step)]));
    const changed = patched.outline.steps.filter(step => before.get(step.id) !== JSON.stringify(step));
    const expanded = new Map<string, StepDetail>();
    await runPool(changed, deps.parallelism, async step => {
      const answer = await deps.ask("to_be_fix", stepRequest(input, references, patched.outline, step, []));
      const result = readStep(patched.outline, step.id, answer);
      if (result.ok) { expanded.set(step.id, result.value); warnAll(...result.warnings); }
    });
    if (expanded.size !== changed.length) return undefined;
    for (const stepId of [...details.keys()]) if (!patched.outline.steps.some(step => step.id === stepId)) details.delete(stepId);
    for (const [stepId, detail] of expanded) details.set(stepId, detail);
    outline = patched.outline; lastShaped = patched.shaped;
    const findings = data.reviewFindings!.map((finding, i): ReviewOutcome => indexes.includes(i) ? { ...finding, outcome: "REPAIRED" } : finding);
    const validated = validateToBeOutput(input, assemble(outline, details, registers), references, reviewBlockers(findings));
    return validated.success ? { ...validated.data, reviewFindings: findings } : undefined;
  };

  const fixed = async (start: ToBeOutput): Promise<ToBeOutput> => {
    const cap = deps.maxFixParts ?? 0, remaining = () => deps.remainingBudget?.() ?? 1;
    if (cap <= 0) return start;
    const first = collectTargets(start.design, start.evaluation.blockers, start.reviewFindings, reviewTried);
    if (!first.targets.length && !first.newStep.length) return start;
    if (remaining() <= FIX_MIN_REMAINING) { deps.warn?.([{ code: "FIX_SKIPPED_BUDGET", path: "to_be_fix" }]); return start; }
    const { data: afterParts, used } = await fixParts(start, cap);
    // Findings that need a new step cannot be fixed per part. They are only kept as findings unless the budget allows a patch, and the patch is only kept if it leaves fewer blockers.
    const missing = collectTargets(afterParts.design, afterParts.evaluation.blockers, afterParts.reviewFindings, reviewTried).newStep;
    if (!missing.length) return afterParts;
    if (remaining() <= FIX_PATCH_MIN_REMAINING) { deps.warn?.([{ code: "FIX_PATCH_SKIPPED_BUDGET", path: "to_be_fix" }]); return afterParts; }
    const snapshot = { outline, lastShaped, details: new Map(details), registers: new Map(registers) };
    const patched = await addSteps(afterParts, missing).catch(() => undefined);
    // The steps it added may leave blockers of their own (a new step with no objective, role or test): the same part-by-part pass clears them with what is left of the cap.
    const settled = patched && await fixParts(patched, Math.max(0, cap - used));
    if (settled && settled.data.evaluation.blockers.length < afterParts.evaluation.blockers.length) {
      deps.warn?.([{ code: "FIX_PATCH_APPLIED", path: "to_be_fix" }]);
      return settled.data;
    }
    outline = snapshot.outline; lastShaped = snapshot.lastShaped;
    details.clear(); for (const [stepId, detail] of snapshot.details) details.set(stepId, detail);
    registers.clear(); for (const [group, value] of snapshot.registers) registers.set(group, value);
    deps.warn?.([{ code: "FIX_PATCH_REJECTED", path: "to_be_fix" }]);
    return afterParts;
  };

  await expand(outline.steps.map(step => step.id), REGISTER_GROUP_NAMES, new Map());
  for (let round = 0; ; round++) {
    const design = assemble(outline, details, registers);
    const result = validateToBeOutput(input, design, references);
    if (result.success) return fixed(await reviewed(result.data, design));
    deps.record(result.errors);
    if (round >= 1) throw deps.invalid();
    const { byStep, byGroup, global } = attributeErrors(result.errors, design);
    const redo = new Set(byStep.keys()), redoGroups = new Set(byGroup.keys());
    for (const stepId of redo) markRetry(stepId);
    for (const group of redoGroups) markRetry(registerKey(group));
    // The late groups were written from the old step bodies; a redone step makes them stale, which is not their own failure.
    if (redo.size) for (const group of LATE_GROUPS) redoGroups.add(group);
    if (global.length) {
      if (!canRepairOutline()) throw deps.invalid();
      outlineRepairs++;
      const repaired = await repairOutline(global);
      if (!repaired.success) throw deps.invalid();
      // Frozen means unchanged steps keep their expansion; a step whose outline entry changed (or is new) is expanded again.
      // The registers were written against the old outline, so they are all written again.
      const before = new Map(outline.steps.map(step => [step.id, JSON.stringify(step)]));
      outline = repaired.outline;
      for (const step of outline.steps) {
        if (before.get(step.id) !== JSON.stringify(step)) { details.delete(step.id); retries.delete(step.id); redo.add(step.id); }
      }
      for (const stepId of [...details.keys()]) if (!outline.steps.some(step => step.id === stepId)) details.delete(stepId);
      registers.clear();
      for (const group of REGISTER_GROUP_NAMES) { retries.delete(registerKey(group)); redoGroups.add(group); }
    }
    await expand([...redo].filter(stepId => outline.steps.some(step => step.id === stepId)), [...redoGroups],
      new Map([...byStep, ...[...byGroup].map(([group, issues]) => [registerKey(group), issues] as const)]));
  }
}
